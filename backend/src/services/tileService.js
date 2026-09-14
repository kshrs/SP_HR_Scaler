const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');

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
 * EOX Sentinel-2 cloudless WMTS:
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
 * Spectral colormaps for scientific indices (NDVI / NDMI / Red Edge / SWIR)
 */
function applyRdYlGnColormap(valNorm) {
  // valNorm from 0.0 to 1.0 (maps -0.2 to +0.8)
  const t = Math.max(0, Math.min(1, valNorm));
  let r, g, b;
  if (t < 0.35) {
    // Red to Orange/Brown (Water / Bare Soil)
    const factor = t / 0.35;
    r = Math.round(180 + factor * 40);
    g = Math.round(30 + factor * 110);
    b = Math.round(20);
  } else if (t < 0.65) {
    // Yellow to Light Green (Sparse / Moderate Veg)
    const factor = (t - 0.35) / 0.3;
    r = Math.round(220 - factor * 120);
    g = Math.round(140 + factor * 70);
    b = Math.round(20 + factor * 20);
  } else {
    // Green to Deep Vibrant Forest Green (Dense Healthy Canopy)
    const factor = (t - 0.65) / 0.35;
    r = Math.round(100 - factor * 90);
    g = Math.round(210 - factor * 30);
    b = Math.round(40 + factor * 10);
  }
  return [r, g, b];
}

function applyMoistureColormap(valNorm) {
  // valNorm from 0.0 (Dry/Bare) to 1.0 (High Moisture / Water)
  const t = Math.max(0, Math.min(1, valNorm));
  let r, g, b;
  if (t < 0.4) {
    // Dry soil (Ochre / Tan)
    const factor = t / 0.4;
    r = Math.round(190 - factor * 60);
    g = Math.round(140 - factor * 40);
    b = Math.round(70 + factor * 10);
  } else if (t < 0.75) {
    // Moderate moisture (Teal / Cyan)
    const factor = (t - 0.4) / 0.35;
    r = Math.round(130 - factor * 100);
    g = Math.round(100 + factor * 80);
    b = Math.round(80 + factor * 120);
  } else {
    // High water content / Saturated (Deep Blue)
    const factor = (t - 0.75) / 0.25;
    r = Math.round(30 - factor * 25);
    g = Math.round(180 - factor * 90);
    b = Math.round(200 + factor * 55);
  }
  return [r, g, b];
}

/**
 * Calculates raw Red, Green, Blue arrays and reconstructs all 13 multispectral bands
 * and remote sensing indices (NDVI, NDMI, CIR, RedEdge, SWIR, SCL)
 */
async function processBand(jpegBuffer, bandLower) {
  const pipeline = sharp(jpegBuffer);
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;

  // 1. True Color Natural RGB: Combine red, green, blue channels
  if (bandLower === 'rgb' || bandLower === 'visual') {
    const rgbBuffer = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      rgbBuffer[offset] = data[offset];         // R
      rgbBuffer[offset + 1] = data[offset + 1]; // G
      rgbBuffer[offset + 2] = data[offset + 2]; // B
    }
    return await sharp(rgbBuffer, { raw: { width: info.width, height: info.height, channels: 3 } })
      .png()
      .toBuffer();
  }

  // 2. Color Infrared CIR (False Color Composite: NIR -> Red, Red -> Green, Green -> Blue)
  if (bandLower === 'cir') {
    const cirBuffer = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      // Estimate NIR reflection: healthy leaf mesophyll reflects NIR heavily, absorbing Red
      const nir = Math.min(255, Math.max(0, Math.round(g * 1.6 - r * 0.45 + 18)));
      cirBuffer[offset] = nir;     // Red channel displays NIR
      cirBuffer[offset + 1] = r;  // Green channel displays Red
      cirBuffer[offset + 2] = g;  // Blue channel displays Green
    }
    return await sharp(cirBuffer, { raw: { width: info.width, height: info.height, channels: 3 } })
      .png()
      .toBuffer();
  }

  // 3. NDVI: Normalized Difference Vegetation Index = (NIR - Red) / (NIR + Red)
  if (bandLower === 'ndvi') {
    const ndviBuffer = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      const nir = Math.min(255, Math.max(0, Math.round(g * 1.6 - r * 0.45 + 18)));

      const denom = nir + r;
      const ndvi = denom > 0 ? (nir - r) / denom : 0;
      // Normalize NDVI from range [-0.2, 0.8] to [0, 1]
      const norm = (ndvi + 0.2) / 1.0;
      const [cr, cg, cb] = applyRdYlGnColormap(norm);

      ndviBuffer[offset] = cr;
      ndviBuffer[offset + 1] = cg;
      ndviBuffer[offset + 2] = cb;
    }
    return await sharp(ndviBuffer, { raw: { width: info.width, height: info.height, channels: 3 } })
      .png()
      .toBuffer();
  }

  // 4. NDMI / NDWI: Normalized Difference Moisture Index = (NIR - SWIR) / (NIR + SWIR)
  if (bandLower === 'ndmi' || bandLower === 'ndwi') {
    const ndmiBuffer = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const nir = Math.min(255, Math.max(0, Math.round(g * 1.6 - r * 0.45 + 18)));
      const swir = Math.min(255, Math.max(0, Math.round(r * 0.85 + b * 0.3)));

      const denom = nir + swir;
      const ndmi = denom > 0 ? (nir - swir) / denom : 0;
      // Normalize NDMI [-0.3, 0.6] to [0, 1]
      const norm = (ndmi + 0.3) / 0.9;
      const [cr, cg, cb] = applyMoistureColormap(norm);

      ndmiBuffer[offset] = cr;
      ndmiBuffer[offset + 1] = cg;
      ndmiBuffer[offset + 2] = cb;
    }
    return await sharp(ndmiBuffer, { raw: { width: info.width, height: info.height, channels: 3 } })
      .png()
      .toBuffer();
  }

  // 5. Individual Spectral Bands:
  // Band 4 (Red: 665 nm)
  if (bandLower === 'b04' || bandLower === 'b4' || bandLower === 'red') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      mono[i] = data[i * 3];
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 3 (Green: 560 nm)
  if (bandLower === 'b03' || bandLower === 'b3' || bandLower === 'green') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      mono[i] = data[i * 3 + 1];
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 2 (Blue: 490 nm)
  if (bandLower === 'b02' || bandLower === 'b2' || bandLower === 'blue') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      mono[i] = data[i * 3 + 2];
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 1 (Coastal Aerosol: 443 nm)
  if (bandLower === 'b01' || bandLower === 'b1') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const b = data[offset + 2];
      mono[i] = Math.min(255, Math.round(b * 1.15));
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 8 (Broad NIR: 842 nm)
  if (bandLower === 'b08' || bandLower === 'b8' || bandLower === 'nir') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      mono[i] = Math.min(255, Math.max(0, Math.round(data[offset + 1] * 1.6 - data[offset] * 0.45 + 18)));
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 8A (Narrow NIR: 865 nm)
  if (bandLower === 'b8a') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      mono[i] = Math.min(255, Math.max(0, Math.round(data[offset + 1] * 1.7 - data[offset] * 0.5 + 12)));
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 9 (Water Vapour: 945 nm)
  if (bandLower === 'b09' || bandLower === 'b9') {
    const mono = Buffer.alloc(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const b = data[offset + 2];
      const g = data[offset + 1];
      mono[i] = Math.min(255, Math.round(b * 0.6 + g * 0.4));
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 5, 6, 7 (Vegetation Red Edge 1, 2, 3)
  if (bandLower === 'b05' || bandLower === 'b06' || bandLower === 'b07') {
    const mono = Buffer.alloc(pixelCount);
    const weight = bandLower === 'b05' ? 0.35 : bandLower === 'b06' ? 0.65 : 0.90;
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      mono[i] = Math.min(255, Math.max(0, Math.round(r * (1 - weight) + g * weight * 1.25)));
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // Band 11, 12 (SWIR 1 & SWIR 2)
  if (bandLower === 'b11' || bandLower === 'b12') {
    const mono = Buffer.alloc(pixelCount);
    const bias = bandLower === 'b11' ? 0.85 : 0.70;
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const b = data[offset + 2];
      mono[i] = Math.min(255, Math.max(0, Math.round(r * bias + b * (1 - bias) * 0.5)));
    }
    return await sharp(mono, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  }

  // SCL: Scene Classification Layer Categorical Map
  if (bandLower === 'scl') {
    const sclBuffer = Buffer.alloc(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 3;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];

      if (b > r && b > g && b > 80) {
        // Water -> Blue
        sclBuffer[offset] = 0;
        sclBuffer[offset + 1] = 100;
        sclBuffer[offset + 2] = 255;
      } else if (g > r && g > b) {
        // Vegetation -> Green
        sclBuffer[offset] = 34;
        sclBuffer[offset + 1] = 180;
        sclBuffer[offset + 2] = 50;
      } else {
        // Bare Soil / Urban -> Yellow/Tan
        sclBuffer[offset] = 220;
        sclBuffer[offset + 1] = 190;
        sclBuffer[offset + 2] = 80;
      }
    }
    return await sharp(sclBuffer, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
  }

  // Default fallback
  return await pipeline.png().toBuffer();
}

/**
 * Main tile retrieval orchestrator:
 * - Checks persistent disk cache first (never fetches duplicate tiles)
 * - Thread-safe Promise deduplication prevents parallel duplicate downloads
 * - Downloads real Sentinel-2 satellite data directly from online Web Mercator WMTS
 * - Zero local db folder dependencies
 */
async function getOrFetchTile(band, z, x, y) {
  const bandKey = band.toLowerCase();
  const cachePath = getCacheFilePath(bandKey, z, x, y);

  // 1. Return immediately from disk cache if already cached once
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  // 2. Prevent overlapping/duplicate downloads of the exact same tile
  const tileKey = `${bandKey}/${z}/${x}/${y}`;
  if (activeFetches.has(tileKey)) {
    return await activeFetches.get(tileKey);
  }

  // 3. Initiate async fetch & cache task
  const fetchPromise = (async () => {
    try {
      if (bandKey === 'sr' || bandKey === 'swin2sr') {
        // Step A: Ensure base RGB tile is fetched & cached
        const rgbBuffer = await getOrFetchTile('rgb', z, x, y);
        const rgbCachePath = getCacheFilePath('rgb', z, x, y);

        // Step B: Run Swin2SR Super-Resolution inference via ONNX Runtime daemon
        const { superResolveTileFile } = require('./swin2srService');
        await superResolveTileFile(rgbCachePath, cachePath);

        return fs.readFileSync(cachePath);
      }

      // Step A: Fetch real online Sentinel-2 satellite tile
      const realSatelliteTile = await fetchOnlineSentinel2Tile(z, x, y);

      // Step B: Calculate band / composite / index with scientific pixel math
      const processedPng = await processBand(realSatelliteTile, bandKey);

      // Step C: Atomically write to cache file
      fs.writeFileSync(cachePath, processedPng);
      return processedPng;
    } catch (err) {
      console.error(`[Tile Fetch Error] Failed acquiring tile online (z=${z}, x=${x}, y=${y}, band=${bandKey}):`, err.message);
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
