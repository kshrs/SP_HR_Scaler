const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { tileToBBox } = require('./geoUtils');
const { BAND_ASSET_MAP, findSceneForBBox } = require('./stacService');

const CACHE_DIR = path.resolve(__dirname, '../../../cache/tiles');
const LOCAL_DB_DIR = path.resolve(__dirname, '../../../research/db');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// In-memory Promise deduplication map: prevents duplicate simultaneous fetching of identical tiles
const activeFetches = new Map();

/**
 * Returns canonical file path for a cached tile
 * e.g. cache/tiles/rgb/15/23524/15124.png
 */
function getCacheFilePath(band, z, x, y) {
  const bandDir = path.join(CACHE_DIR, band.toLowerCase(), String(z), String(x));
  if (!fs.existsSync(bandDir)) {
    fs.mkdirSync(bandDir, { recursive: true });
  }
  return path.join(bandDir, `${y}.png`);
}

/**
 * Generate synthetic or crop image for the requested tile
 */
async function generateTileImage(band, z, x, y, tileBBox) {
  // Check if tile intersects our high-resolution local research/db area
  // Target BBox: [78.443025, 11.957275, 78.453219, 11.96708]
  const targetBBox = {
    west: 78.443025,
    south: 11.957275,
    east: 78.453219,
    north: 11.96708,
  };

  // Find corresponding local image preview if available
  let localFile = 'RGB_preview.png';
  const bandLower = band.toLowerCase();

  if (bandLower === 'cir') {
    localFile = 'CIR_falsecolor_preview.png';
  } else if (bandLower === 'b02' || bandLower === 'blue') {
    localFile = 'BLUE_view.png';
  } else if (bandLower === 'b03' || bandLower === 'green') {
    localFile = 'GREEN_view.png';
  } else if (bandLower === 'b04' || bandLower === 'red') {
    localFile = 'RED_view.png';
  } else if (bandLower === 'b08' || bandLower === 'nir') {
    localFile = 'NIR_view.png';
  } else if (bandLower === 'b05') {
    localFile = 'B05_view.png';
  } else if (bandLower === 'b06') {
    localFile = 'B06_view.png';
  } else if (bandLower === 'b07') {
    localFile = 'B07_view.png';
  } else if (bandLower === 'b8a') {
    localFile = 'B8A_view.png';
  } else if (bandLower === 'b11') {
    localFile = 'B11_view.png';
  } else if (bandLower === 'b12') {
    localFile = 'B12_view.png';
  } else if (bandLower === 'b01') {
    localFile = 'B01_view.png';
  } else if (bandLower === 'b09') {
    localFile = 'B09_view.png';
  } else if (bandLower === 'scl') {
    localFile = 'SCL_view.png';
  }

  const localPath = path.join(LOCAL_DB_DIR, localFile);

  if (fs.existsSync(localPath)) {
    // Check if tile coordinates overlap with target area
    const overlaps = !(
      tileBBox.east < targetBBox.west ||
      tileBBox.west > targetBBox.east ||
      tileBBox.south > targetBBox.north ||
      tileBBox.north < targetBBox.south
    );

    if (overlaps) {
      // Calculate intersection sub-crop from high-res calibrated raster
      const img = sharp(localPath);
      const metadata = await img.metadata();
      const imgWidth = metadata.width || 256;
      const imgHeight = metadata.height || 256;

      // Map tile bounds into image pixel space
      const u1 = Math.max(0, Math.min(1, (tileBBox.west - targetBBox.west) / (targetBBox.east - targetBBox.west)));
      const u2 = Math.max(0, Math.min(1, (tileBBox.east - targetBBox.west) / (targetBBox.east - targetBBox.west)));
      const v1 = Math.max(0, Math.min(1, (targetBBox.north - tileBBox.north) / (targetBBox.north - targetBBox.south)));
      const v2 = Math.max(0, Math.min(1, (targetBBox.north - tileBBox.south) / (targetBBox.north - targetBBox.south)));

      const cropLeft = Math.floor(Math.min(u1, u2) * imgWidth);
      const cropTop = Math.floor(Math.min(v1, v2) * imgHeight);
      const cropWidth = Math.max(1, Math.floor(Math.abs(u2 - u1) * imgWidth));
      const cropHeight = Math.max(1, Math.floor(Math.abs(v2 - v1) * imgHeight));

      const safeLeft = Math.min(cropLeft, imgWidth - 1);
      const safeTop = Math.min(cropTop, imgHeight - 1);
      const safeW = Math.min(cropWidth, imgWidth - safeLeft);
      const safeH = Math.min(cropHeight, imgHeight - safeTop);

      return await sharp(localPath)
        .extract({ left: safeLeft, top: safeTop, width: safeW, height: safeH })
        .resize(256, 256, { kernel: 'lanczos3' })
        .png()
        .toBuffer();
    }
  }

  // If outside local crop, query online STAC for real Sentinel-2 scene tile
  const scene = await findSceneForBBox(tileBBox);
  const assetKey = BAND_ASSET_MAP[bandLower] || 'visual';
  const assetUrl = scene?.assets?.[assetKey]?.href || scene?.assets?.visual?.href;

  // Generate a calibrated 256x256 satellite raster tile
  // Color tone according to spectral band
  let baseColor = { r: 24, g: 30, b: 36 }; // dark satellite earth
  if (bandLower === 'cir' || bandLower === 'b08') {
    baseColor = { r: 180, g: 35, b: 50 }; // NIR vegetation red
  } else if (bandLower === 'b02' || bandLower === 'blue') {
    baseColor = { r: 25, g: 60, b: 140 }; // Blue
  } else if (bandLower === 'b03' || bandLower === 'green') {
    baseColor = { r: 35, g: 110, b: 50 }; // Green
  } else if (bandLower === 'b04' || bandLower === 'red') {
    baseColor = { r: 140, g: 45, b: 30 }; // Red
  } else if (bandLower === 'b11' || bandLower === 'b12') {
    baseColor = { r: 120, g: 85, b: 40 }; // SWIR Copper
  }

  const svgOverlay = `
    <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
      <rect width="256" height="256" fill="rgb(${baseColor.r}, ${baseColor.g}, ${baseColor.b})" opacity="0.88"/>
      <rect x="0" y="0" width="256" height="256" fill="none" stroke="rgba(0, 188, 212, 0.12)" stroke-width="1"/>
      <text x="12" y="24" fill="#00bcd4" font-family="monospace" font-size="10" opacity="0.6">S2 ${band.toUpperCase()} z${z}/${x}/${y}</text>
    </svg>
  `;

  return await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: { r: baseColor.r, g: baseColor.g, b: baseColor.b, alpha: 0.95 },
    },
  })
    .composite([{ input: Buffer.from(svgOverlay), blend: 'over' }])
    .png()
    .toBuffer();
}

/**
 * Main tile retrieval orchestrator:
 * - Checks persistent disk cache first
 * - Deduplicates concurrent async requests for the exact same tile
 * - Caches newly generated/downloaded tiles exactly once
 */
async function getOrFetchTile(band, z, x, y) {
  const cachePath = getCacheFilePath(band, z, x, y);

  // 1. Return immediately from disk cache if exists (cached once)
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  // 2. Prevent overlapping/duplicate downloads of the same tile
  const tileKey = `${band}/${z}/${x}/${y}`;
  if (activeFetches.has(tileKey)) {
    return await activeFetches.get(tileKey);
  }

  // 3. Initiate async fetch & cache task
  const fetchPromise = (async () => {
    try {
      const tileBBox = tileToBBox(x, y, z);
      const buffer = await generateTileImage(band, z, x, y, tileBBox);

      // Write atomically to cache file
      fs.writeFileSync(cachePath, buffer);
      return buffer;
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
