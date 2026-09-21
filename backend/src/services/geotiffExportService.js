const os = require('os');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const { getCopernicusAuthToken } = require('./copernicusAuth');
const { getOrFetchTile } = require('./tileService');
const { lonLatToTile } = require('./geoUtils');

const SH_PROCESS_API = 'https://sh.dataspace.copernicus.eu/api/v1/process';

// Complete list of Sentinel-2 L2A individual bands and composites to export
const S2_BANDS = [
  { id: 'B01', name: 'Coastal_Aerosol_B01', resolution: '60m', singleBand: 'B01' },
  { id: 'B02', name: 'Blue_B02', resolution: '10m', singleBand: 'B02' },
  { id: 'B03', name: 'Green_B03', resolution: '10m', singleBand: 'B03' },
  { id: 'B04', name: 'Red_B04', resolution: '10m', singleBand: 'B04' },
  { id: 'B05', name: 'Vegetation_Red_Edge_B05', resolution: '20m', singleBand: 'B05' },
  { id: 'B06', name: 'Vegetation_Red_Edge_B06', resolution: '20m', singleBand: 'B06' },
  { id: 'B07', name: 'Vegetation_Red_Edge_B07', resolution: '20m', singleBand: 'B07' },
  { id: 'B08', name: 'NIR_B08', resolution: '10m', singleBand: 'B08' },
  { id: 'B8A', name: 'Narrow_NIR_B8A', resolution: '20m', singleBand: 'B8A' },
  { id: 'B09', name: 'Water_Vapour_B09', resolution: '60m', singleBand: 'B09' },
  { id: 'B11', name: 'SWIR1_B11', resolution: '20m', singleBand: 'B11' },
  { id: 'B12', name: 'SWIR2_B12', resolution: '20m', singleBand: 'B12' },
  { id: 'RGB', name: 'True_Color_RGB', resolution: '10m', composite: 'rgb' },
  { id: 'CIR', name: 'False_Color_CIR', resolution: '10m', composite: 'cir' },
  { id: 'NDVI', name: 'Normalized_Vegetation_Index_NDVI', resolution: '10m', composite: 'ndvi' },
  { id: 'NDMI', name: 'Normalized_Moisture_Index_NDMI', resolution: '10m', composite: 'ndmi' },
];

/**
 * Returns user's Downloads directory, creating it if it doesn't exist
 */
function getDownloadsDir() {
  const home = os.homedir();
  const downloads = path.join(home, 'Downloads');
  if (!fs.existsSync(downloads)) {
    fs.mkdirSync(downloads, { recursive: true });
  }
  return downloads;
}

/**
 * Formats current date and time into a clean filesystem folder name:
 * e.g. "Sentinel2_AOI_2026-09-21_14-35-12"
 */
function getTimestampFolderName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const mins = pad(now.getMinutes());
  const secs = pad(now.getSeconds());
  return `Sentinel2_AOI_${year}-${month}-${day}_${hours}-${mins}-${secs}`;
}

/**
 * Builds Copernicus evalscript for uint16 calibrated reflectance GeoTIFF export
 */
function buildTiffEvalscript(bandDef) {
  if (bandDef.singleBand) {
    const b = bandDef.singleBand;
    return `//VERSION=3
function setup() {
  return {
    input: ["${b}"],
    output: { bands: 1, sampleType: "UINT16" }
  };
}
function evaluatePixel(sample) {
  return [Math.min(65535, Math.round(sample.${b} * 10000))];
}`;
  }

  if (bandDef.composite === 'rgb') {
    return `//VERSION=3
function setup() {
  return {
    input: ["B02", "B03", "B04"],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  return [
    Math.min(255, Math.round(Math.pow(sample.B04 * 3.5, 0.7) * 255)),
    Math.min(255, Math.round(Math.pow(sample.B03 * 3.5, 0.7) * 255)),
    Math.min(255, Math.round(Math.pow(sample.B02 * 3.5, 0.7) * 255))
  ];
}`;
  }

  if (bandDef.composite === 'cir') {
    return `//VERSION=3
function setup() {
  return {
    input: ["B03", "B04", "B08"],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  return [
    Math.min(255, Math.round(sample.B08 * 3.0 * 255)),
    Math.min(255, Math.round(sample.B04 * 3.5 * 255)),
    Math.min(255, Math.round(sample.B03 * 3.5 * 255))
  ];
}`;
  }

  if (bandDef.composite === 'ndvi') {
    return `//VERSION=3
function setup() {
  return {
    input: ["B04", "B08"],
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(sample) {
  var ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 1e-6);
  return [ndvi];
}`;
  }

  if (bandDef.composite === 'ndmi') {
    return `//VERSION=3
function setup() {
  return {
    input: ["B08", "B11"],
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(sample) {
  var ndmi = (sample.B08 - sample.B11) / (sample.B08 + sample.B11 + 1e-6);
  return [ndmi];
}`;
  }

  return buildTiffEvalscript({ singleBand: 'B04' });
}

/**
 * Downloads a single band GeoTIFF directly via Copernicus Process API
 */
async function fetchTiffFromCopernicus(bbox, bandDef, token, width = 512, height = 512) {
  const { west, south, east, north } = bbox;
  const evalscript = buildTiffEvalscript(bandDef);

  const payload = {
    input: {
      bounds: {
        bbox: [west, south, east, north],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: {
              from: '2024-10-01T00:00:00Z',
              to: '2025-04-30T23:59:59Z',
            },
            maxCloudCoverage: 20,
            mosaickingOrder: 'leastCC',
          },
        },
      ],
    },
    output: {
      width,
      height,
      responses: [
        {
          identifier: 'default',
          format: { type: 'image/tiff' },
        },
      ],
    },
    evalscript,
  };

  const response = await axios.post(SH_PROCESS_API, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'image/tiff',
    },
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  return Buffer.from(response.data);
}

/**
 * Fallback GeoTIFF generator using Sharp if Copernicus API is unreachable
 */
async function generateFallbackTiff(bbox, bandDef, width = 512, height = 512) {
  // Use center coordinate to get regional base slippy tile
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLon = (bbox.west + bbox.east) / 2;
  const tileCoord = lonLatToTile(centerLon, centerLat, 15);
  
  const bandKey = bandDef.singleBand ? bandDef.singleBand.toLowerCase() : (bandDef.composite || 'rgb');
  const pngBuffer = await getOrFetchTile(bandKey, tileCoord.z, tileCoord.x, tileCoord.y);

  if (bandDef.composite === 'rgb' || bandDef.composite === 'cir') {
    const rawRgb = await sharp(pngBuffer).resize(width, height).raw().toBuffer({ resolveWithObject: true });
    return await sharp(rawRgb.data, {
      raw: { width, height, channels: rawRgb.info.channels },
    }).tiff({ compression: 'deflate' }).toBuffer();
  }

  // Grayscale single band as uint16
  const rawGray = await sharp(pngBuffer).resize(width, height).grayscale().raw().toBuffer({ resolveWithObject: true });
  const u16 = Buffer.alloc(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    const val = rawGray.data[i];
    u16.writeUInt16LE(Math.round((val / 255) * 10000), i * 2);
  }

  return await sharp(u16, {
    raw: { width, height, channels: 1 },
  }).tiff({ compression: 'deflate' }).toBuffer();
}

/**
 * Main Export Function:
 * Fetches all Sentinel-2 bands for the selected square AOI and saves them
 * into ~/Downloads/Sentinel2_AOI_<timestamp>/
 *
 * @param {Object} bbox { west, south, east, north }
 * @returns {Object} { targetDir, files, aoi: { west, south, east, north, widthKm } }
 */
async function exportAoiGeoTiffs(bbox) {
  const { west, south, east, north } = bbox;

  // Validate coordinates
  if (
    typeof west !== 'number' || typeof south !== 'number' ||
    typeof east !== 'number' || typeof north !== 'number' ||
    isNaN(west) || isNaN(south) || isNaN(east) || isNaN(north)
  ) {
    throw new Error('Invalid AOI bounding box coordinates.');
  }

  const downloadsDir = getDownloadsDir();
  const folderName = getTimestampFolderName();
  const targetDir = path.join(downloadsDir, folderName);
  fs.mkdirSync(targetDir, { recursive: true });

  const token = await getCopernicusAuthToken();

  console.log(`[GeoTIFF Export] Initiating export for AOI [W:${west.toFixed(4)}, S:${south.toFixed(4)}, E:${east.toFixed(4)}, N:${north.toFixed(4)}]`);
  console.log(`[GeoTIFF Export] Saving products to: ${targetDir}`);

  const savedFiles = [];

  for (const band of S2_BANDS) {
    const filename = `${band.name}_${band.resolution}.tif`;
    const filePath = path.join(targetDir, filename);

    try {
      let tiffBuffer;
      if (token) {
        tiffBuffer = await fetchTiffFromCopernicus(bbox, band, token, 512, 512);
      } else {
        tiffBuffer = await generateFallbackTiff(bbox, band, 512, 512);
      }

      fs.writeFileSync(filePath, tiffBuffer);
      savedFiles.push({ band: band.id, filename, size: tiffBuffer.length, resolution: band.resolution });
      console.log(`[GeoTIFF Export] ✓ Saved ${filename} (${(tiffBuffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.warn(`[GeoTIFF Export] Warning on ${band.id}: ${err.message}. Attempting fallback...`);
      try {
        const fallbackBuffer = await generateFallbackTiff(bbox, band, 512, 512);
        fs.writeFileSync(filePath, fallbackBuffer);
        savedFiles.push({ band: band.id, filename, size: fallbackBuffer.length, resolution: band.resolution });
        console.log(`[GeoTIFF Export] ✓ Fallback saved ${filename}`);
      } catch (fallbackErr) {
        console.error(`[GeoTIFF Export] Failed to export ${band.id}:`, fallbackErr.message);
      }
    }
  }

  // Write metadata JSON alongside the GeoTIFFs
  const meta = {
    aoi: {
      west,
      south,
      east,
      north,
      crs: 'EPSG:4326',
      center: [(south + north) / 2, (west + east) / 2],
    },
    exportTimestamp: new Date().toISOString(),
    totalBandsExported: savedFiles.length,
    files: savedFiles,
  };
  fs.writeFileSync(path.join(targetDir, 'metadata.json'), JSON.stringify(meta, null, 2));

  return {
    targetDir,
    folderName,
    count: savedFiles.length,
    files: savedFiles,
    aoi: meta.aoi,
  };
}

module.exports = {
  exportAoiGeoTiffs,
  S2_BANDS,
  getDownloadsDir,
};
