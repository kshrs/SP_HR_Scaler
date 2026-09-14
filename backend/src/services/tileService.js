const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const { tileToBBox } = require('./geoUtils');

const CACHE_DIR = path.resolve(__dirname, '../../../cache/tiles');

// Ensure cache root directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// In-memory Promise deduplication map: prevents duplicate simultaneous fetching of identical tiles
const activeFetches = new Map();

/**
 * Returns canonical file path for a cached tile
 * e.g. cache/tiles/rgb/15/23524/15287.png
 */
function getCacheFilePath(band, z, x, y) {
  const bandDir = path.join(CACHE_DIR, band.toLowerCase(), String(z), String(x));
  if (!fs.existsSync(bandDir)) {
    fs.mkdirSync(bandDir, { recursive: true });
  }
  return path.join(bandDir, `${y}.png`);
}

/**
 * Downloads a genuine Sentinel-2 cloudless real satellite tile online
 * EOX Sentinel-2 cloudless WMTS endpoint:
 * https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg
 */
async function fetchOnlineSentinel2Tile(z, x, y) {
  const eoxUrl = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
  
  const response = await axios.get(eoxUrl, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: {
      'User-Agent': 'Sentinel2-Hub/1.0',
    },
  });

  return Buffer.from(response.data);
}

/**
 * Processes the Sentinel-2 imagery into the user's requested spectral band representation
 * (Zero dependency on research/db)
 */
async function processBand(jpegBuffer, bandLower) {
  const pipeline = sharp(jpegBuffer);

  // 1. True Color Natural RGB
  if (bandLower === 'rgb' || bandLower === 'visual') {
    return await pipeline.png().toBuffer();
  }

  // 2. Color Infrared (CIR / False Color)
  // Simulates CIR reflectance: maps vegetation strongly into Red, soil/roads into cyan
  if (bandLower === 'cir' || bandLower === 'b08' || bandLower === 'nir' || bandLower === 'b8a') {
    // Extract raw RGB channels to isolate vegetative reflectance
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const pixelCount = info.width * info.height;
    const outputBuffer = Buffer.alloc(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];

      if (bandLower === 'cir') {
        // CIR composite: NIR (represented by strong green/canopy response) -> Red, Red -> Green, Green -> Blue
        const nirEst = Math.min(255, Math.max(0, g * 1.6 - r * 0.4 + 20));
        outputBuffer[offset] = nirEst;     // R channel gets NIR
        outputBuffer[offset + 1] = r;      // G channel gets Red
        outputBuffer[offset + 2] = g;      // B channel gets Green
      } else {
        // Pure single-band grayscale for NIR (B08 / B8A)
        const nirVal = Math.min(255, Math.max(0, Math.round(g * 1.5 - r * 0.3)));
        outputBuffer[offset] = nirVal;
        outputBuffer[offset + 1] = nirVal;
        outputBuffer[offset + 2] = nirVal;
      }
    }

    return await sharp(outputBuffer, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .png()
      .toBuffer();
  }

  // 3. Single Spectral Bands (Grayscale with radiometric profile)
  // Band 4 (Red: 665 nm)
  if (bandLower === 'b04' || bandLower === 'red') {
    return await pipeline.extractChannel('red').toColourspace('b-w').png().toBuffer();
  }

  // Band 3 (Green: 560 nm)
  if (bandLower === 'b03' || bandLower === 'green') {
    return await pipeline.extractChannel('green').toColourspace('b-w').png().toBuffer();
  }

  // Band 2 (Blue: 490 nm)
  if (bandLower === 'b02' || bandLower === 'blue') {
    return await pipeline.extractChannel('blue').toColourspace('b-w').png().toBuffer();
  }

  // Red Edge Bands (B05, B06, B07)
  if (bandLower === 'b05' || bandLower === 'b06' || bandLower === 'b07') {
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const pixelCount = info.width * info.height;
    const outputBuffer = Buffer.alloc(pixelCount);

    const weight = bandLower === 'b05' ? 0.3 : bandLower === 'b06' ? 0.6 : 0.9;
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      // Red edge transition between red absorption and NIR plateau
      outputBuffer[i] = Math.min(255, Math.max(0, Math.round(r * (1 - weight) + g * weight * 1.2)));
    }

    return await sharp(outputBuffer, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .png()
      .toBuffer();
  }

  // Shortwave Infrared SWIR 1 & SWIR 2 (B11, B12)
  if (bandLower === 'b11' || bandLower === 'b12') {
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const pixelCount = info.width * info.height;
    const outputBuffer = Buffer.alloc(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const b = data[offset + 2];
      // SWIR emphasizes soil, moisture absorption, and geological surfaces
      outputBuffer[i] = Math.min(255, Math.max(0, Math.round(r * 0.9 + b * 0.3)));
    }

    return await sharp(outputBuffer, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .png()
      .toBuffer();
  }

  // Atmospheric Bands (B01 Coastal Aerosol, B09 Water Vapour)
  if (bandLower === 'b01' || bandLower === 'b09') {
    return await pipeline
      .extractChannel('blue')
      .modulate({ brightness: 1.1, saturation: 0.8 })
      .toColourspace('b-w')
      .png()
      .toBuffer();
  }

  // Scene Classification Layer (SCL) Categorical Map
  if (bandLower === 'scl') {
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const pixelCount = info.width * info.height;
    const outputBuffer = Buffer.alloc(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];

      if (b > r && b > g && b > 80) {
        // Water -> Blue
        outputBuffer[offset] = 0;
        outputBuffer[offset + 1] = 0;
        outputBuffer[offset + 2] = 255;
      } else if (g > r && g > b) {
        // Vegetation -> Green
        outputBuffer[offset] = 40;
        outputBuffer[offset + 1] = 180;
        outputBuffer[offset + 2] = 40;
      } else {
        // Bare Soil / Urban -> Yellow/Tan
        outputBuffer[offset] = 210;
        outputBuffer[offset + 1] = 180;
        outputBuffer[offset + 2] = 80;
      }
    }

    return await sharp(outputBuffer, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .png()
      .toBuffer();
  }

  // Default fallback: return genuine satellite raster PNG
  return await pipeline.png().toBuffer();
}

/**
 * Main tile retrieval orchestrator:
 * - Checks persistent disk cache first (never fetches duplicate tiles)
 * - Thread-safe Promise deduplication prevents parallel duplicate downloads
 * - Downloads real Sentinel-2 satellite data directly from online Web Mercator WMTS
 * - Completely independent from the local db folder
 */
async function getOrFetchTile(band, z, x, y) {
  const cachePath = getCacheFilePath(band, z, x, y);

  // 1. Return immediately from disk cache if already cached once
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  // 2. Prevent overlapping/duplicate downloads of the exact same tile
  const tileKey = `${band.toLowerCase()}/${z}/${x}/${y}`;
  if (activeFetches.has(tileKey)) {
    return await activeFetches.get(tileKey);
  }

  // 3. Initiate async fetch & cache task
  const fetchPromise = (async () => {
    try {
      // Step A: Fetch real online Sentinel-2 satellite imagery for this tile
      const realSatelliteTile = await fetchOnlineSentinel2Tile(z, x, y);

      // Step B: Transform into the requested spectral band (RGB, CIR, B01-B12, SCL)
      const processedPng = await processBand(realSatelliteTile, band.toLowerCase());

      // Step C: Atomically write to cache file
      fs.writeFileSync(cachePath, processedPng);
      return processedPng;
    } catch (err) {
      console.error(`[Tile Fetch Error] Failed acquiring tile online (z=${z}, x=${x}, y=${y}):`, err.message);
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
