const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const DB_DIR = path.resolve(__dirname, '../research/db');

// Serve static images directly from research/db
app.use('/api/tiles', express.static(DB_DIR));

// Endpoint to fetch metadata and band catalogue
app.get('/api/metadata', (req, res) => {
  try {
    const metaPath = path.join(DB_DIR, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Metadata not found' });
    }
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    // Augment with available web-renderable view URLs
    const bandsWithViews = [
      {
        id: 'rgb',
        code: 'RGB',
        name: 'True Color (RGB)',
        resolution: '10m',
        viewUrl: '/api/tiles/RGB_preview.png',
        processedUrl: '/api/tiles/SRM_processed_preview.png',
        type: 'composite',
        description: 'Human-readable visual composite (B04 + B03 + B02)'
      },
      {
        id: 'cir',
        code: 'CIR',
        name: 'Color Infrared (CIR)',
        resolution: '10m',
        viewUrl: '/api/tiles/CIR_falsecolor_preview.png',
        type: 'composite',
        description: 'Near-infrared false-color composite (B08 + B04 + B03)'
      },
      {
        id: 'B02',
        code: 'B02',
        name: 'Band 2 — Blue',
        resolution: '10m',
        viewUrl: '/api/tiles/BLUE_view.png',
        type: 'band',
        description: '490 nm - Water penetration and soil/vegetation contrast'
      },
      {
        id: 'B03',
        code: 'B03',
        name: 'Band 3 — Green',
        resolution: '10m',
        viewUrl: '/api/tiles/GREEN_view.png',
        type: 'band',
        description: '560 nm - Peak vegetation reflectance'
      },
      {
        id: 'B04',
        code: 'B04',
        name: 'Band 4 — Red',
        resolution: '10m',
        viewUrl: '/api/tiles/RED_view.png',
        type: 'band',
        description: '665 nm - Chlorophyll absorption'
      },
      {
        id: 'B08',
        code: 'B08',
        name: 'Band 8 — NIR',
        resolution: '10m',
        viewUrl: '/api/tiles/NIR_view.png',
        type: 'band',
        description: '842 nm - Mesophyll reflection, land-water boundary'
      },
      {
        id: 'B05',
        code: 'B05',
        name: 'Band 5 — Red Edge 1',
        resolution: '20m',
        viewUrl: '/api/tiles/B05_view.png',
        type: 'band',
        description: '705 nm - Chlorophyll and nitrogen status'
      },
      {
        id: 'B06',
        code: 'B06',
        name: 'Band 6 — Red Edge 2',
        resolution: '20m',
        viewUrl: '/api/tiles/B06_view.png',
        type: 'band',
        description: '740 nm - Leaf Area Index (LAI) evaluation'
      },
      {
        id: 'B07',
        code: 'B07',
        name: 'Band 7 — Red Edge 3',
        resolution: '20m',
        viewUrl: '/api/tiles/B07_view.png',
        type: 'band',
        description: '783 nm - Transition to NIR plateau'
      },
      {
        id: 'B8A',
        code: 'B8A',
        name: 'Band 8A — Narrow NIR',
        resolution: '20m',
        viewUrl: '/api/tiles/B8A_view.png',
        type: 'band',
        description: '865 nm - Atmospheric water vapor avoidance'
      },
      {
        id: 'B11',
        code: 'B11',
        name: 'Band 11 — SWIR 1',
        resolution: '20m',
        viewUrl: '/api/tiles/B11_view.png',
        type: 'band',
        description: '1610 nm - Canopy moisture & snow/cloud discrimination'
      },
      {
        id: 'B12',
        code: 'B12',
        name: 'Band 12 — SWIR 2',
        resolution: '20m',
        viewUrl: '/api/tiles/B12_view.png',
        type: 'band',
        description: '2190 nm - Geology, soils & burn severity'
      },
      {
        id: 'B01',
        code: 'B01',
        name: 'Band 1 — Coastal Aerosol',
        resolution: '60m',
        viewUrl: '/api/tiles/B01_view.png',
        type: 'band',
        description: '443 nm - Coastal bathymetry & aerosol correction'
      },
      {
        id: 'B09',
        code: 'B09',
        name: 'Band 9 — Water Vapour',
        resolution: '60m',
        viewUrl: '/api/tiles/B09_view.png',
        type: 'band',
        description: '945 nm - Atmospheric water vapor absorption'
      },
      {
        id: 'SCL',
        code: 'SCL',
        name: 'Scene Classification (SCL)',
        resolution: '20m',
        viewUrl: '/api/tiles/SCL_view.png',
        type: 'classification',
        description: 'Quality mask: vegetation, soil, water, clouds, shadow'
      }
    ];

    res.json({
      ...data,
      availableBands: bandsWithViews
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
