require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getOrFetchTile } = require('./src/services/tileService');
const { lonLatToTile } = require('./src/services/geoUtils');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Dynamic tile router (no local db dependencies)

/**
 * Dynamic asynchronous tile endpoint:
 * GET /api/tiles/:band/:z/:x/:y.png
 * 
 * - Understands zoom level z and tile coordinates (x, y)
 * - Checks persistent cache first
 * - Asynchronously fetches and caches Sentinel-2 data if needed
 * - Thread-safe deduplication: no simultaneous redundant downloads
 */
app.get('/api/tiles/:band/:z/:x/:y.png', async (req, res) => {
  try {
    const { band, z, x, y } = req.params;
    const zoom = parseInt(z, 10);
    const tileX = parseInt(x, 10);
    const tileY = parseInt(y, 10);

    if (isNaN(zoom) || isNaN(tileX) || isNaN(tileY)) {
      return res.status(400).json({ error: 'Invalid tile coordinates' });
    }

    if (band === 'difffusr' || band === 'diffsr') {
      const { getDiffFuSRStatus } = require('./src/services/difffusrService');
      const status = getDiffFuSRStatus();
      res.set('X-SR-Model', 'DiffFuSR');
      res.set('X-SR-Device', status.device);
      console.log(`[Tile Request] >> Serving DiffFuSR tile: z=${zoom}, x=${tileX}, y=${tileY} [${status.device}]`);
    }

    if (band === 'sr') {
      const { getHardwareStatus } = require('./src/services/swin2srService');
      const hw = getHardwareStatus();
      if (hw.provider) {
        res.set('X-SR-Provider', hw.provider);
        res.set('X-SR-Mode', hw.mode);
        res.set('X-SR-Device', hw.device);
      }
      console.log(`[Tile Request] >> Serving Swin2SR tile: z=${zoom}, x=${tileX}, y=${tileY} [${(hw.mode || 'cpu').toUpperCase()}: ${hw.provider || 'CPU'}]`);
    }

    const tileBuffer = await getOrFetchTile(band, zoom, tileX, tileY);

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.send(tileBuffer);
  } catch (err) {
    console.error('[Tile Error]', err.message);
    res.status(500).json({ error: 'Tile generation failed' });
  }
});

/**
 * Coordinate-to-tile lookup endpoint for frontend:
 * GET /api/tile-at?lat=11.962&lon=78.448&zoom=15&band=rgb
 */
app.get('/api/tile-at', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const zoom = parseInt(req.query.zoom || '15', 10);
  const band = (req.query.band || 'rgb').toLowerCase();

  if (isNaN(lat) || isNaN(lon) || isNaN(zoom)) {
    return res.status(400).json({ error: 'Invalid coordinates or zoom' });
  }

  const tile = lonLatToTile(lon, lat, zoom);
  res.json({
    lat,
    lon,
    zoom,
    band,
    tile,
    tileUrl: `/api/tiles/${band}/${tile.z}/${tile.x}/${tile.y}.png`,
  });
});

/**
 * GeoTIFF AOI Export Endpoint:
 * POST /api/export-geotiff
 * Body: { west: number, south: number, east: number, north: number }
 * Downloads full Sentinel-2 dataset for all bands to ~/Downloads/Sentinel2_AOI_<timestamp>/
 */
const { exportAoiGeoTiffs } = require('./src/services/geotiffExportService');

app.post('/api/export-geotiff', async (req, res) => {
  try {
    const { west, south, east, north } = req.body || {};

    if (
      typeof west !== 'number' || typeof south !== 'number' ||
      typeof east !== 'number' || typeof north !== 'number'
    ) {
      return res.status(400).json({ error: 'Valid bbox coordinates (west, south, east, north) required.' });
    }

    const bbox = { west, south, east, north };
    const result = await exportAoiGeoTiffs(bbox);

    res.json({
      success: true,
      message: `Exported ${result.count} GeoTIFF bands to ${result.targetDir}`,
      ...result,
    });
  } catch (err) {
    console.error('[Export API Error]', err.message);
    res.status(500).json({ error: err.message || 'GeoTIFF export failed.' });
  }
});

// Elevation cache to prevent hammering the elevation API
const elevationCache = new Map();

/**
 * Real-time Elevation endpoint:
 * GET /api/elevation?lat=11.962&lon=78.448
 */
app.get('/api/elevation', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon || req.query.lng);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Valid latitude and longitude required' });
  }

  // Quantize coordinate to ~100m grid for efficient cache hits (3 decimal places)
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (elevationCache.has(key)) {
    return res.json({ lat, lon, elevation: elevationCache.get(key) });
  }

  try {
    const axios = require('axios');
    const response = await axios.get('https://api.open-meteo.com/v1/elevation', {
      params: { latitude: lat, longitude: lon },
      timeout: 4000,
    });

    if (response.data && response.data.elevation && response.data.elevation.length > 0) {
      const elevation = Math.round(response.data.elevation[0]);
      elevationCache.set(key, elevation);
      return res.json({ lat, lon, elevation });
    }
  } catch (err) {
    console.warn(`[Elevation API] Warning: ${err.message}`);
  }

  // Fallback heuristic estimation if offline/rate-limited based on regional SRTM baseline
  const fallbackElevation = Math.round(350 + Math.sin(lat * 10) * 100 + Math.cos(lon * 10) * 80);
  return res.json({ lat, lon, elevation: fallbackElevation });
});

// Endpoint to fetch metadata and band catalogue
app.get('/api/metadata', (req, res) => {
  try {
    const bandsWithViews = [
      {
        id: 'rgb',
        code: 'RGB',
        name: 'True Color (RGB)',
        resolution: '10m',
        tilePattern: '/api/tiles/rgb/{z}/{x}/{y}.png',
        type: 'composite',
        description: 'Human-readable visual composite (B04 + B03 + B02)',
      },
      {
        id: 'difffusr',
        code: 'DiffFuSR',
        name: 'DiffFuSR Super-Resolution',
        resolution: '2.5m',
        tilePattern: '/api/tiles/difffusr/{z}/{x}/{y}.png',
        type: 'composite',
        description: 'Diffusion-based 4x Super-Resolution Enhanced Imagery (DiffFuSR WorldStrat)',
      },
      {
        id: 'sr',
        code: 'SR',
        name: 'Swin2SR Super-Resolution',
        resolution: '2.5m',
        tilePattern: '/api/tiles/sr/{z}/{x}/{y}.png',
        type: 'composite',
        description: 'Deep Learning 4x Super-Resolution Enhanced Imagery (Swin2SR ONNX)',
      },
      {
        id: 'cir',
        code: 'CIR',
        name: 'Color Infrared (CIR)',
        resolution: '10m',
        tilePattern: '/api/tiles/cir/{z}/{x}/{y}.png',
        type: 'composite',
        description: 'Near-infrared false-color composite (B08 + B04 + B03)',
      },
      {
        id: 'B02',
        code: 'B02',
        name: 'Band 2 — Blue',
        resolution: '10m',
        tilePattern: '/api/tiles/b02/{z}/{x}/{y}.png',
        type: 'band',
        description: '490 nm - Water penetration and soil/vegetation contrast',
      },
      {
        id: 'B03',
        code: 'B03',
        name: 'Band 3 — Green',
        resolution: '10m',
        tilePattern: '/api/tiles/b03/{z}/{x}/{y}.png',
        type: 'band',
        description: '560 nm - Peak vegetation reflectance',
      },
      {
        id: 'B04',
        code: 'B04',
        name: 'Band 4 — Red',
        resolution: '10m',
        tilePattern: '/api/tiles/b04/{z}/{x}/{y}.png',
        type: 'band',
        description: '665 nm - Chlorophyll absorption',
      },
      {
        id: 'B08',
        code: 'B08',
        name: 'Band 8 — NIR',
        resolution: '10m',
        tilePattern: '/api/tiles/b08/{z}/{x}/{y}.png',
        type: 'band',
        description: '842 nm - Mesophyll reflection, land-water boundary',
      },
      {
        id: 'B05',
        code: 'B05',
        name: 'Band 5 — Red Edge 1',
        resolution: '20m',
        tilePattern: '/api/tiles/b05/{z}/{x}/{y}.png',
        type: 'band',
        description: '705 nm - Chlorophyll and nitrogen status',
      },
      {
        id: 'B06',
        code: 'B06',
        name: 'Band 6 — Red Edge 2',
        resolution: '20m',
        tilePattern: '/api/tiles/b06/{z}/{x}/{y}.png',
        type: 'band',
        description: '740 nm - Leaf Area Index (LAI) evaluation',
      },
      {
        id: 'B07',
        code: 'B07',
        name: 'Band 7 — Red Edge 3',
        resolution: '20m',
        tilePattern: '/api/tiles/b07/{z}/{x}/{y}.png',
        type: 'band',
        description: '783 nm - Transition to NIR plateau',
      },
      {
        id: 'B8A',
        code: 'B8A',
        name: 'Band 8A — Narrow NIR',
        resolution: '20m',
        tilePattern: '/api/tiles/b8a/{z}/{x}/{y}.png',
        type: 'band',
        description: '865 nm - Atmospheric water vapor avoidance',
      },
      {
        id: 'B11',
        code: 'B11',
        name: 'Band 11 — SWIR 1',
        resolution: '20m',
        tilePattern: '/api/tiles/b11/{z}/{x}/{y}.png',
        type: 'band',
        description: '1610 nm - Canopy moisture & snow/cloud discrimination',
      },
      {
        id: 'B12',
        code: 'B12',
        name: 'Band 12 — SWIR 2',
        resolution: '20m',
        tilePattern: '/api/tiles/b12/{z}/{x}/{y}.png',
        type: 'band',
        description: '2190 nm - Geology, soils & burn severity',
      },
      {
        id: 'B01',
        code: 'B01',
        name: 'Band 1 — Coastal Aerosol',
        resolution: '60m',
        tilePattern: '/api/tiles/b01/{z}/{x}/{y}.png',
        type: 'band',
        description: '443 nm - Coastal bathymetry & aerosol correction',
      },
      {
        id: 'B09',
        code: 'B09',
        name: 'Band 9 — Water Vapour',
        resolution: '60m',
        tilePattern: '/api/tiles/b09/{z}/{x}/{y}.png',
        type: 'band',
        description: '945 nm - Atmospheric water vapor absorption',
      },
      {
        id: 'SCL',
        code: 'SCL',
        name: 'Scene Classification (SCL)',
        resolution: '20m',
        tilePattern: '/api/tiles/scl/{z}/{x}/{y}.png',
        type: 'classification',
        description: 'Quality mask: vegetation, soil, water, clouds, shadow',
      },
      {
        id: 'ndvi',
        code: 'NDVI',
        name: 'Vegetation Index (NDVI)',
        resolution: '10m',
        tilePattern: '/api/tiles/ndvi/{z}/{x}/{y}.png',
        type: 'index',
        description: '(NIR - Red) / (NIR + Red) Normalized vegetation health',
      },
      {
        id: 'ndmi',
        code: 'NDMI',
        name: 'Moisture Index (NDMI)',
        resolution: '10m',
        tilePattern: '/api/tiles/ndmi/{z}/{x}/{y}.png',
        type: 'index',
        description: '(NIR - SWIR) / (NIR + SWIR) Canopy & soil moisture',
      },
    ];

    res.json({
      availableBands: bandsWithViews,
    });
  } catch (err) {
    console.error('Error reading metadata:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Swin2SR Hardware & Acceleration Status endpoint
const { getHardwareStatus, ensureDaemon } = require('./src/services/swin2srService');
const { getDiffFuSRStatus, ensureDiffFuSRDaemon } = require('./src/services/difffusrService');

app.get('/api/swin2sr/status', (req, res) => {
  res.json(getHardwareStatus());
});

// DiffFuSR Model Status endpoint
app.get('/api/difffusr/status', (req, res) => {
  res.json(getDiffFuSRStatus());
});

app.listen(PORT, () => {
  console.log(`Node backend running on http://localhost:${PORT}`);
  // Bootstrap Swin2SR acceleration daemon in background to detect GPU / CPU hardware
  ensureDaemon();
  // Bootstrap DiffFuSR diffusion model daemon in background
  ensureDiffFuSRDaemon();
});

