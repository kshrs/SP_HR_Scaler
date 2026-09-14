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

// Endpoint to fetch metadata and band catalogue
app.get('/api/metadata', (req, res) => {
  try {
    const metaPath = path.join(DB_DIR, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Metadata not found' });
    }
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    const bandsWithViews = [
      {
        id: 'rgb',
        code: 'RGB',
        name: 'True Color (RGB)',
        resolution: '10m',
        viewUrl: '/api/tiles/RGB_preview.png',
        tilePattern: '/api/tiles/rgb/{z}/{x}/{y}.png',
        type: 'composite',
        description: 'Human-readable visual composite (B04 + B03 + B02)',
      },
      {
        id: 'cir',
        code: 'CIR',
        name: 'Color Infrared (CIR)',
        resolution: '10m',
        viewUrl: '/api/tiles/CIR_falsecolor_preview.png',
        tilePattern: '/api/tiles/cir/{z}/{x}/{y}.png',
        type: 'composite',
        description: 'Near-infrared false-color composite (B08 + B04 + B03)',
      },
      {
        id: 'B02',
        code: 'B02',
        name: 'Band 2 — Blue',
        resolution: '10m',
        viewUrl: '/api/tiles/BLUE_view.png',
        tilePattern: '/api/tiles/b02/{z}/{x}/{y}.png',
        type: 'band',
        description: '490 nm - Water penetration and soil/vegetation contrast',
      },
      {
        id: 'B03',
        code: 'B03',
        name: 'Band 3 — Green',
        resolution: '10m',
        viewUrl: '/api/tiles/GREEN_view.png',
        tilePattern: '/api/tiles/b03/{z}/{x}/{y}.png',
        type: 'band',
        description: '560 nm - Peak vegetation reflectance',
      },
      {
        id: 'B04',
        code: 'B04',
        name: 'Band 4 — Red',
        resolution: '10m',
        viewUrl: '/api/tiles/RED_view.png',
        tilePattern: '/api/tiles/b04/{z}/{x}/{y}.png',
        type: 'band',
        description: '665 nm - Chlorophyll absorption',
      },
      {
        id: 'B08',
        code: 'B08',
        name: 'Band 8 — NIR',
        resolution: '10m',
        viewUrl: '/api/tiles/NIR_view.png',
        tilePattern: '/api/tiles/b08/{z}/{x}/{y}.png',
        type: 'band',
        description: '842 nm - Mesophyll reflection, land-water boundary',
      },
      {
        id: 'B05',
        code: 'B05',
        name: 'Band 5 — Red Edge 1',
        resolution: '20m',
        viewUrl: '/api/tiles/B05_view.png',
        tilePattern: '/api/tiles/b05/{z}/{x}/{y}.png',
        type: 'band',
        description: '705 nm - Chlorophyll and nitrogen status',
      },
      {
        id: 'B06',
        code: 'B06',
        name: 'Band 6 — Red Edge 2',
        resolution: '20m',
        viewUrl: '/api/tiles/B06_view.png',
        tilePattern: '/api/tiles/b06/{z}/{x}/{y}.png',
        type: 'band',
        description: '740 nm - Leaf Area Index (LAI) evaluation',
      },
      {
        id: 'B07',
        code: 'B07',
        name: 'Band 7 — Red Edge 3',
        resolution: '20m',
        viewUrl: '/api/tiles/B07_view.png',
        tilePattern: '/api/tiles/b07/{z}/{x}/{y}.png',
        type: 'band',
        description: '783 nm - Transition to NIR plateau',
      },
      {
        id: 'B8A',
        code: 'B8A',
        name: 'Band 8A — Narrow NIR',
        resolution: '20m',
        viewUrl: '/api/tiles/B8A_view.png',
        tilePattern: '/api/tiles/b8a/{z}/{x}/{y}.png',
        type: 'band',
        description: '865 nm - Atmospheric water vapor avoidance',
      },
      {
        id: 'B11',
        code: 'B11',
        name: 'Band 11 — SWIR 1',
        resolution: '20m',
        viewUrl: '/api/tiles/B11_view.png',
        tilePattern: '/api/tiles/b11/{z}/{x}/{y}.png',
        type: 'band',
        description: '1610 nm - Canopy moisture & snow/cloud discrimination',
      },
      {
        id: 'B12',
        code: 'B12',
        name: 'Band 12 — SWIR 2',
        resolution: '20m',
        viewUrl: '/api/tiles/B12_view.png',
        tilePattern: '/api/tiles/b12/{z}/{x}/{y}.png',
        type: 'band',
        description: '2190 nm - Geology, soils & burn severity',
      },
      {
        id: 'B01',
        code: 'B01',
        name: 'Band 1 — Coastal Aerosol',
        resolution: '60m',
        viewUrl: '/api/tiles/B01_view.png',
        tilePattern: '/api/tiles/b01/{z}/{x}/{y}.png',
        type: 'band',
        description: '443 nm - Coastal bathymetry & aerosol correction',
      },
      {
        id: 'B09',
        code: 'B09',
        name: 'Band 9 — Water Vapour',
        resolution: '60m',
        viewUrl: '/api/tiles/B09_view.png',
        tilePattern: '/api/tiles/b09/{z}/{x}/{y}.png',
        type: 'band',
        description: '945 nm - Atmospheric water vapor absorption',
      },
      {
        id: 'SCL',
        code: 'SCL',
        name: 'Scene Classification (SCL)',
        resolution: '20m',
        viewUrl: '/api/tiles/SCL_view.png',
        tilePattern: '/api/tiles/scl/{z}/{x}/{y}.png',
        type: 'classification',
        description: 'Quality mask: vegetation, soil, water, clouds, shadow',
      },
      {
        id: 'ndvi',
        code: 'NDVI',
        name: 'Vegetation Index (NDVI)',
        resolution: '10m',
        viewUrl: '/api/tiles/ndvi/15/23524/15287.png',
        tilePattern: '/api/tiles/ndvi/{z}/{x}/{y}.png',
        type: 'index',
        description: '(NIR - Red) / (NIR + Red) Normalized vegetation health',
      },
      {
        id: 'ndmi',
        code: 'NDMI',
        name: 'Moisture Index (NDMI)',
        resolution: '10m',
        viewUrl: '/api/tiles/ndmi/15/23524/15287.png',
        tilePattern: '/api/tiles/ndmi/{z}/{x}/{y}.png',
        type: 'index',
        description: '(NIR - SWIR) / (NIR + SWIR) Canopy & soil moisture',
      },
    ];

    res.json({
      ...data,
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

app.listen(PORT, () => {
  console.log(`Node backend running on http://localhost:${PORT}`);
});
