const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const { getCopernicusAuthToken, hasCopernicusCredentials } = require('./copernicusAuth');

// ─────────────────────────────────────────────────────────────────────────────
// Cache Setup
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_VERSION = '3'; // bump this to wipe stale cached tiles on next server start
const CACHE_DIR = path.resolve(__dirname, '../../../cache/tiles');
const VERSION_FILE = path.join(CACHE_DIR, '.version');

/**
 * On startup: if cache version file doesn't match CACHE_VERSION,
 * wipe the cache and write fresh version file.
 */
function initCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const existing = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : null;
  if (existing !== CACHE_VERSION) {
    console.log(`[Cache] Version mismatch (got "${existing}", expected "${CACHE_VERSION}"). Wiping stale cache...`);
    try {
      const entries = fs.readdirSync(CACHE_DIR);
      for (const e of entries) {
        const ep = path.join(CACHE_DIR, e);
        if (e !== '.version') {
          fs.rmSync(ep, { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.warn('[Cache] Wipe error:', e.message);
    }
    fs.writeFileSync(VERSION_FILE, CACHE_VERSION, 'utf8');
    console.log('[Cache] Cache cleared. Fresh start.');
  }
}

initCache();

// In-memory Promise deduplication map
const activeFetches = new Map();

function getCacheFilePath(band, z, x, y) {
  const bandDir = path.join(CACHE_DIR, band.toLowerCase(), String(z), String(x));
  if (!fs.existsSync(bandDir)) {
    fs.mkdirSync(bandDir, { recursive: true });
  }
  return path.join(bandDir, `${y}.png`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile Bounding Box Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert tile coordinates to a Web Mercator bounding box (EPSG:3857) in meters.
 * Required by Sentinel Hub Process API.
 */
function tileToBBoxMeters(x, y, z) {
  const n = Math.pow(2, z);
  // Tile → lon/lat corners
  const lon_west  = (x / n) * 360 - 180;
  const lon_east  = ((x + 1) / n) * 360 - 180;
  const lat_north_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat_south_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
  const lat_north = (lat_north_rad * 180) / Math.PI;
  const lat_south = (lat_south_rad * 180) / Math.PI;

  // Convert to EPSG:3857 meters
  const R = 6378137;
  const xmin = (lon_west * Math.PI / 180) * R;
  const xmax = (lon_east * Math.PI / 180) * R;
  const ymax = Math.log(Math.tan(Math.PI / 4 + lat_north_rad / 2)) * R;
  const ymin = Math.log(Math.tan(Math.PI / 4 + lat_south_rad / 2)) * R;
  return { xmin, ymin, xmax, ymax };
}

function tileToBBoxDegrees(x, y, z) {
  const n = Math.pow(2, z);
  const west  = (x / n) * 360 - 180;
  const east  = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180) / Math.PI;
  return { west, south, east, north };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel Hub Process API — Real Individual Bands
// ─────────────────────────────────────────────────────────────────────────────

const SH_PROCESS_API = 'https://sh.dataspace.copernicus.eu/api/v1/process';

/**
 * Evalscript factory: returns a Sentinel Hub evalscript that outputs a specific
 * Sentinel-2 L2A band or composite as a rendered image.
 * 
 * All reflectance values are in the [0, 1] range (divided by 10000 from DN).
 * For single bands: output greyscale (sampleType UINT8 0-255).
 * For composites/indices: output RGB UINT8.
 */
function buildEvalscript(bandKey) {
  // True Color Natural RGB: B04 (Red), B03 (Green), B02 (Blue)
  if (bandKey === 'rgb' || bandKey === 'visual') {
    return `//VERSION=3
function setup() {
  return { input: ["B02","B03","B04"], output: { bands: 3, sampleType: "UINT8" } };
}
function evaluatePixel(s) {
  return [
    Math.min(255, Math.round(Math.pow(s.B04 * 3.5, 0.7) * 255)),
    Math.min(255, Math.round(Math.pow(s.B03 * 3.5, 0.7) * 255)),
    Math.min(255, Math.round(Math.pow(s.B02 * 3.5, 0.7) * 255))
  ];
}`;
  }

  // Color Infrared CIR: B08 (NIR→R), B04 (Red→G), B03 (Green→B)
  if (bandKey === 'cir') {
    return `//VERSION=3
function setup() {
  return { input: ["B03","B04","B08"], output: { bands: 3, sampleType: "UINT8" } };
}
function evaluatePixel(s) {
  return [
    Math.min(255, Math.round(s.B08 * 3.0 * 255)),
    Math.min(255, Math.round(s.B04 * 3.5 * 255)),
    Math.min(255, Math.round(s.B03 * 3.5 * 255))
  ];
}`;
  }

  // NDVI: (NIR - Red) / (NIR + Red)  → RdYlGn palette
  if (bandKey === 'ndvi') {
    return `//VERSION=3
function setup() {
  return { input: ["B04","B08"], output: { bands: 3, sampleType: "UINT8" } };
}
function ndviToRgb(ndvi) {
  // Map [-0.2, 1.0] to color: brown/red (bare/water) → yellow → green (healthy veg)
  const t = Math.max(0, Math.min(1, (ndvi + 0.2) / 1.2));
  var r, g, b;
  if (t < 0.33) {
    var f = t / 0.33;
    r = Math.round(180 + f * 40); g = Math.round(30 + f * 110); b = 20;
  } else if (t < 0.66) {
    var f2 = (t - 0.33) / 0.33;
    r = Math.round(220 - f2 * 120); g = Math.round(140 + f2 * 70); b = Math.round(20 + f2 * 20);
  } else {
    var f3 = (t - 0.66) / 0.34;
    r = Math.round(100 - f3 * 90); g = Math.round(210 - f3 * 30); b = Math.round(40 + f3 * 10);
  }
  return [r, g, b];
}
function evaluatePixel(s) {
  var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 0.000001);
  return ndviToRgb(ndvi);
}`;
  }

  // NDMI: (NIR - SWIR1) / (NIR + SWIR1) → moisture colormap
  if (bandKey === 'ndmi' || bandKey === 'ndwi') {
    return `//VERSION=3
function setup() {
  return { input: ["B08","B11"], output: { bands: 3, sampleType: "UINT8" } };
}
function evaluatePixel(s) {
  const ndmi = (s.B08 - s.B11) / (s.B08 + s.B11 + 1e-6);
  // Ochre→Teal→Blue colormap (dry→wet)
  const t = Math.max(0, Math.min(1, (ndmi + 0.3) / 0.9));
  let r, g, b;
  if (t < 0.4) {
    const f = t / 0.4;
    r = 190 - f * 60; g = 140 - f * 40; b = 70 + f * 10;
  } else if (t < 0.75) {
    const f = (t - 0.4) / 0.35;
    r = 130 - f * 100; g = 100 + f * 80; b = 80 + f * 120;
  } else {
    const f = (t - 0.75) / 0.25;
    r = 30 - f * 25; g = 180 - f * 90; b = 200 + f * 55;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}`;
  }

  // Scene Classification Layer: approximate from cloud/veg/water signal
  if (bandKey === 'scl') {
    return `//VERSION=3
function setup() {
  return { input: ["B02","B03","B04","B08","B11"], output: { bands: 3, sampleType: "UINT8" } };
}
function evaluatePixel(s) {
  const ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 1e-6);
  const ndwi = (s.B03 - s.B08) / (s.B03 + s.B08 + 1e-6);
  // Cloud: high blue+green+NIR and bright
  if (s.B02 > 0.3 && s.B03 > 0.3 && s.B08 > 0.2) return [210, 210, 210];
  // Water
  if (ndwi > 0.1 && s.B08 < 0.1) return [0, 100, 220];
  // Vegetation
  if (ndvi > 0.3) return [34, 168, 60];
  // Bare soil / urban
  return [200, 180, 90];
}`;
  }

  // Single spectral bands — output as grayscale (1-channel → 3 band grayscale RGB)
  const singleBandMap = {
    'b01': 'B01', 'b02': 'B02', 'b03': 'B03', 'b04': 'B04',
    'b05': 'B05', 'b06': 'B06', 'b07': 'B07', 'b08': 'B08',
    'b8a': 'B8A', 'b09': 'B09', 'b11': 'B11', 'b12': 'B12',
    'red': 'B04', 'green': 'B03', 'blue': 'B02', 'nir': 'B08',
  };

  const sentinelBand = singleBandMap[bandKey];
  if (sentinelBand) {
    // Each band has a different typical reflectance range — scale accordingly
    // 10m bands (B02-B04, B08): reflectance 0-0.3 typical; multiply by ~4
    // 20m bands (B05-B07, B8A, B11, B12): use ~3-6 gain depending on spectral region
    // 60m bands (B01, B09): reflectance often very low, boost gain
    const gainMap = {
      'B01': 8.0, 'B02': 4.0, 'B03': 4.0, 'B04': 4.0,
      'B05': 3.5, 'B06': 3.0, 'B07': 2.8, 'B08': 2.8,
      'B8A': 2.8, 'B09': 6.0, 'B11': 4.0, 'B12': 5.0,
    };
    const gain = gainMap[sentinelBand] || 4.0;
    // gamma correction for contrast enhancement
    return `//VERSION=3
function setup() {
  return { input: ["${sentinelBand}"], output: { bands: 3, sampleType: "UINT8" } };
}
function evaluatePixel(s) {
  const v = Math.min(1.0, Math.pow(s.${sentinelBand} * ${gain}, 0.7));
  const u8 = Math.round(v * 255);
  return [u8, u8, u8];
}`;
  }

  // Fallback: RGB
  return buildEvalscript('rgb');
}

/**
 * Fetch a tile from Sentinel Hub Process API using Copernicus CDSE credentials.
 * Returns PNG buffer.
 */
async function fetchSentinelHubTile(z, x, y, bandKey) {
  const token = await getCopernicusAuthToken();
  if (!token) {
    throw new Error('No Copernicus auth token available');
  }

  const { xmin, ymin, xmax, ymax } = tileToBBoxMeters(x, y, z);
  const evalscript = buildEvalscript(bandKey);

  const payload = {
    input: {
      bounds: {
        bbox: [xmin, ymin, xmax, ymax],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/3857' },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: {
              from: '2024-10-01T00:00:00Z',
              to: '2025-04-30T23:59:59Z',
            },
            maxCloudCoverage: 15,
            mosaickingOrder: 'leastCC',
          },
        },
      ],
    },
    output: {
      width: 256,
      height: 256,
      responses: [
        {
          identifier: 'default',
          format: { type: 'image/png' },
        },
      ],
    },
    evalscript,
  };

  const response = await axios.post(SH_PROCESS_API, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'image/png',
    },
    responseType: 'arraybuffer',
    timeout: 20000,
  });

  return Buffer.from(response.data);
}

// ─────────────────────────────────────────────────────────────────────────────
// EOX Fallback — Composite RGB only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Downloads composite RGB from EOX Sentinel-2 Cloudless WMTS.
 * Used ONLY as fallback when CDSE credentials are unavailable.
 */
async function fetchEOXRGBTile(z, x, y) {
  const eoxUrl = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
  const response = await axios.get(eoxUrl, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: { 'User-Agent': 'Sentinel2-Hub/2.0' },
  });
  return Buffer.from(response.data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Colormap helpers for EOX fallback path
// ─────────────────────────────────────────────────────────────────────────────

function applyRdYlGnColormap(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.35) {
    const f = t / 0.35;
    r = Math.round(180 + f * 40); g = Math.round(30 + f * 110); b = 20;
  } else if (t < 0.65) {
    const f = (t - 0.35) / 0.3;
    r = Math.round(220 - f * 120); g = Math.round(140 + f * 70); b = Math.round(20 + f * 20);
  } else {
    const f = (t - 0.65) / 0.35;
    r = Math.round(100 - f * 90); g = Math.round(210 - f * 30); b = Math.round(40 + f * 10);
  }
  return [r, g, b];
}

function applyMoistureColormap(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.4) {
    const f = t / 0.4;
    r = Math.round(190 - f * 60); g = Math.round(140 - f * 40); b = Math.round(70 + f * 10);
  } else if (t < 0.75) {
    const f = (t - 0.4) / 0.35;
    r = Math.round(130 - f * 100); g = Math.round(100 + f * 80); b = Math.round(80 + f * 120);
  } else {
    const f = (t - 0.75) / 0.25;
    r = Math.round(30 - f * 25); g = Math.round(180 - f * 90); b = Math.round(200 + f * 55);
  }
  return [r, g, b];
}

/**
 * Fallback band processor for EOX composite (single-source RGB tile).
 * Only used when CDSE credentials unavailable.
 */
async function processEOXBand(jpegBuffer, bandLower) {
  const { data, info } = await sharp(jpegBuffer).raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;

  // RGB / visual → pass through
  if (bandLower === 'rgb' || bandLower === 'visual') {
    return await sharp(jpegBuffer).png().toBuffer();
  }

  // For index computations over EOX RGB (approximate NIR from green/red ratio)
  if (bandLower === 'ndvi') {
    const buf = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const r = data[i*3], g = data[i*3+1];
      const nir = Math.min(255, Math.max(0, Math.round(g * 1.6 - r * 0.45 + 18)));
      const denom = nir + r;
      const ndvi = denom > 0 ? (nir - r) / denom : 0;
      const [cr, cg, cb] = applyRdYlGnColormap((ndvi + 0.2) / 1.0);
      buf[i*3] = cr; buf[i*3+1] = cg; buf[i*3+2] = cb;
    }
    return sharp(buf, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
  }

  if (bandLower === 'ndmi' || bandLower === 'ndwi') {
    const buf = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const r = data[i*3], g = data[i*3+1], b = data[i*3+2];
      const nir = Math.min(255, Math.max(0, Math.round(g * 1.6 - r * 0.45 + 18)));
      const swir = Math.min(255, Math.max(0, Math.round(r * 0.85 + b * 0.3)));
      const denom = nir + swir;
      const ndmi = denom > 0 ? (nir - swir) / denom : 0;
      const [cr, cg, cb] = applyMoistureColormap((ndmi + 0.3) / 0.9);
      buf[i*3] = cr; buf[i*3+1] = cg; buf[i*3+2] = cb;
    }
    return sharp(buf, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
  }

  // All other bands: pass raw RGB
  return sharp(jpegBuffer).png().toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Tile Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point: serve a processed Sentinel-2 tile.
 * Priority:
 *   1. Disk cache (instant)
 *   2. Sentinel Hub Process API (real individual bands via CDSE credentials)
 *   3. EOX WMTS fallback (composite RGB only)
 * Thread-safe via Promise deduplication map.
 */
async function getOrFetchTile(band, z, x, y) {
  const bandKey = band.toLowerCase();
  const cachePath = getCacheFilePath(bandKey, z, x, y);

  // 1. Return from disk cache immediately
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  // 2. Deduplicate simultaneous requests for the same tile
  const tileKey = `${bandKey}/${z}/${x}/${y}`;
  if (activeFetches.has(tileKey)) {
    return await activeFetches.get(tileKey);
  }

  const fetchPromise = (async () => {
    try {
      let pngBuffer;

      if (bandKey === 'sr' || bandKey === 'swin2sr') {
        // SR path: first fetch base RGB tile, then super-resolve
        const rgbBuffer = await getOrFetchTile('rgb', z, x, y);
        const rgbCachePath = getCacheFilePath('rgb', z, x, y);
        const { superResolveTileFile } = require('./swin2srService');
        await superResolveTileFile(rgbCachePath, cachePath);
        return fs.readFileSync(cachePath);
      }

      if (hasCopernicusCredentials()) {
        // Primary path: real individual Sentinel-2 bands via Sentinel Hub
        try {
          console.log(`[Tile] Fetching via Sentinel Hub: ${bandKey} z=${z} x=${x} y=${y}`);
          pngBuffer = await fetchSentinelHubTile(z, x, y, bandKey);
          console.log(`[Tile] ✓ Sentinel Hub success: ${bandKey} z=${z}`);
        } catch (shErr) {
          console.warn(`[Tile] Sentinel Hub failed (${shErr.message}), falling back to EOX...`);
          const eoxJpeg = await fetchEOXRGBTile(z, x, y);
          pngBuffer = await processEOXBand(eoxJpeg, bandKey);
        }
      } else {
        // No credentials — use EOX composite fallback
        console.log(`[Tile] No CDSE credentials — using EOX WMTS: ${bandKey} z=${z}`);
        const eoxJpeg = await fetchEOXRGBTile(z, x, y);
        pngBuffer = await processEOXBand(eoxJpeg, bandKey);
      }

      fs.writeFileSync(cachePath, pngBuffer);
      return pngBuffer;
    } catch (err) {
      console.error(`[Tile Fetch Error] z=${z} x=${x} y=${y} band=${bandKey}:`, err.message);
      throw err;
    } finally {
      activeFetches.delete(tileKey);
    }
  })();

  activeFetches.set(tileKey, fetchPromise);
  return await fetchPromise;
}

module.exports = {
  getOrFetchTile,
  getCacheFilePath,
};
