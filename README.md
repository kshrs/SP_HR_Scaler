# SP_HR_Scaler: Satellite Imagery Super-Resolution & Analysis Platform

[![Repository](https://img.shields.io/badge/GitHub-kshrs%2FSP__HR__Scaler-blue?logo=github)](https://github.com/kshrs/SP_HR_Scaler)
[![Frontend](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev/)
[![Backend](https://img.shields.io/badge/Node.js-Express%205-339933?logo=node.js)](https://nodejs.org/)
[![Styling](https://img.shields.io/badge/TailwindCSS-v4-38bdf8?logo=tailwindcss)](https://tailwindcss.com/)
[![Map Engine](https://img.shields.io/badge/Leaflet-React--Leaflet-199900?logo=leaflet)](https://leafletjs.com/)

**SP_HR_Scaler** is a satellite remote-sensing platform engineered to reconstruct high-resolution surface reflectance and multispectral products from European Space Agency (ESA) Sentinel-2 imagery. It couples a deep learning super-resolution pipeline with an interactive geospatial web interface, on-the-fly XYZ tile serving, interactive Area of Interest (AOI) bounding, and multi-band GeoTIFF packaging for downstream earth observation applications.

---

## Key Features

- **Multispectral Super-Resolution (SR)**: Enhances native Sentinel-2 imagery (10m/20m/60m) into fine-detail 2.5m ground sampling distance reconstructions.
- **Dynamic XYZ Tile Server**: Asynchronously serves Sentinel-2 multispectral and super-resolved tiles (`/api/tiles/:band/:z/:x/:y.png`) with thread-safe deduplication and disk caching.
- **Multispectral & Analysis Layer Views**:
  - True Color (RGB: B04, B03, B02)
  - Normalized Difference Vegetation Index (NDVI: B08, B04)
  - Normalized Difference Water Index (NDWI: B03, B08)
  - False Color / Urban / Agriculture index combinations
  - Side-by-side split comparison slider and opacity inspection
- **Interactive Square AOI Selector**:
  - Draw custom geographic bounding boxes on the map with intuitive mouse drag.
  - Interactive button toggle switch to activate/deactivate AOI mode.
  - Hold **Spacebar** while in AOI mode to seamlessly pan the map without triggering box drawing.
  - Automatic boundary coordinates and geographic area calculation in km².
- **Full Multi-Band GeoTIFF Export**:
  - Downloads multi-band or super-resolved GeoTIFF products matching selected AOI bounds directly to the browser.
  - Preserves geospatial bounding, CRS metadata, and individual Sentinel-2 spectral bands.

---

## Underlying Model Architecture

The super-resolution engine in SP_HR_Scaler leverages a specialized hybrid deep learning framework designed specifically for satellite remote sensing and multispectral reflectance characteristics.

```
                  +----------------------------------------------+
                  |           Sentinel-2 L1C / L2A Input         |
                  |     (Multispectral Bands: 10m / 20m / 60m)   |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |         Pre-trained SEN2SR Backbone          |
                  |    - Preserves Physical Surface Reflectance   |
                  |    - Sensor-Specific Spectral Calibration    |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |          Custom U-Net Head & Decoder         |
                  |    - Multi-scale Skip Connections             |
                  |    - High-frequency Feature Reconstruction   |
                  |    - Cloud / Shadow & Artifact Suppression   |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |       Super-Resolved Output (2.5m GSD)       |
                  |        (RGB, SWIR, NIR, & Index Bands)       |
                  +----------------------------------------------+
```

### 1. Model Structure & Design
- **Pre-trained SEN2SR Foundation Backbone**:
  Rather than standard computer vision super-resolution networks (which frequently distort photometric radiance and spectral signatures), the system integrates pre-trained weights from the **SEN2SR** foundation model. This backbone maintains physical radiometric fidelity across all spectral wavelengths.
- **Custom U-Net Head**:
  A custom-designed U-Net architecture head sits atop the latent representations extracted by the backbone. Featuring multi-level residual skip connections, symmetric encoder-decoder blocks, and attention-gated feature refinement, the head accurately reconstructs high-frequency spatial structures (e.g., roads, field boundaries, urban structures) without losing multispectral band alignment.

---

## Training Datasets & References

The super-resolution model and domain adaptation pipeline are trained and fine-tuned on a targeted combination of benchmark remote sensing datasets:

| Dataset | Role in Pipeline | Description & Specifications |
| :--- | :--- | :--- |
| **Sentinel-2 L2A** | Primary LR Input | Primary low-resolution multispectral input for Stage 1 super-resolution. Contains Level-2A bottom-of-atmosphere (BOA) surface reflectance data with ~2.2M patches globally at 10m, 20m, and 60m native spatial resolution. |
| **SEN2NEON** | Ground-Truth Reference | High-resolution ground-truth reference for training and validating the SR model. Provides 10,000 paired patches (~31 GB) with 10m LR input and co-registered 2.5m HR NEON airborne reference. |
| **Open Earth Map** | Segmentation & Domain Adaptation | Primary target for semantic segmentation, land-use evaluation, and domain adaptation. Contains 5,000 images with 2.2M annotated segments across 97 regions worldwide at 0.25–0.5m ground sampling distance. |
| **ESA WorldCover** | Land Cover Benchmark | Global land cover validation benchmark aligned with the UN-FAO Land Cover Classification System. Covers the globe at 10m spatial resolution (~124 GB total size) across 11 land categories. |
| **SEN2NAIPv2** | Foundation SR Training | Large-scale dataset used for training and calibrating the SEN2SR foundation model. Features 62,242 LR-HR image pairs pairing 10m Sentinel-2 input with 2.5m HR target patches. |
| **NAIP** | High-Resolution Imagery Source | High-resolution National Agriculture Imagery Program aerial imagery utilized as the sub-meter reference ground truth in SEN2NAIP. Comprises ~22.8M aerial orthophotos at standard 0.6m GSD. |
| **CloudSEN12** | Cloud & Shadow Masking | Specialized multi-temporal dataset used for training cloud, cirrus, and shadow masking in the SR preprocessing pipeline. Contains 49,400 image patches (~1 TB) covering 509 × 509 pixel windows at 10m resolution. |
| **S2-SRF** | Spectral Response Functions | Reference spectral response curves for Sentinel-2 MSI bands (3.1 MB). Used to simulate Sentinel-2 multispectral bands from airborne hyperspectral data and enforce spectral consistency across bands. |

---

## Architecture & System Overview

The project is structured into three primary decoupled subsystems:

```
SP_HR_Scaler/
├── backend/                  # Node.js / Express Tile & GeoTIFF Server
│   ├── src/
│   │   ├── services/
│   │   │   ├── geotiffExportService.js  # GeoTIFF processing & multi-band packaging
│   │   │   ├── tileService.js           # Tile generation, caching, and band math
│   │   │   └── geoUtils.js              # Coordinate conversions & bounding math
│   │   └── server.js                    # Express endpoints and error handling
│   ├── cache/                           # Persistent disk tile cache
│   └── package.json
│
├── frontend/                 # React 19 + Vite + TailwindCSS 4 Web App
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.tsx               # Controls, band selection, AOI toggle, and export
│   │   │   ├── MapViewport.tsx          # Leaflet map, split-view slider, AOI bounding box
│   │   │   └── LayerControl.tsx         # Layer opacity & index visualization controls
│   │   ├── App.tsx                      # State orchestration & notification toasts
│   │   └── types.ts                     # TypeScript data interfaces
│   └── vite.config.ts
│
└── research/                 # Python Super-Resolution & ML Pipeline
    ├── model/                           # Pretrained checkpoints & weights
    ├── main.py                          # Inference & evaluation pipeline
    └── vis_nb.py                        # Visualization & analysis notebooks
```

---

## Getting Started

### Prerequisites

- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **Python**: `3.10+` (optional, for running local research and ML inference scripts)
- **GDAL / Sharp build tools**: Installed on your system for native image handling

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/kshrs/SP_HR_Scaler.git
   cd SP_HR_Scaler
   ```

2. **Backend Setup**:
   ```bash
   cd backend
   npm install
   cp .env.example .env   # Configure any required port or API keys
   ```

3. **Frontend Setup**:
   ```bash
   cd ../frontend
   npm install
   ```

---

## Running the Application

### 1. Start the Backend API Server
```bash
cd backend
npm run dev
# Server listens on http://localhost:5000
```

### 2. Start the Frontend Development Server
```bash
cd frontend
npm run dev
# Web interface available at http://localhost:5173
```

---

## API Reference

### Tile Endpoint
`GET /api/tiles/:band/:z/:x/:y.png`
- **Parameters**:
  - `band`: Spectral band or product (`rgb`, `b08`, `ndvi`, `ndwi`, `sr`, etc.)
  - `z`: Zoom level
  - `x`: Tile column index
  - `y`: Tile row index
- **Response**: `image/png` binary stream with `Cache-Control` headers.

### Tile Coordinate Lookup
`GET /api/tile-at?lat={latitude}&lon={longitude}&zoom={zoom}&band={band}`
- Returns tile grid indices corresponding to a specific geographic point.

### GeoTIFF Export Endpoint
`POST /api/export/geotiff`
- **Payload**:
  ```json
  {
    "bbox": [minLon, minLat, maxLon, maxLat],
    "bands": ["B02", "B03", "B04", "B08"],
    "resolution": "2.5m"
  }
  ```
- **Response**: Binary GeoTIFF file attachment with standard spatial reference tags.

---

## Usage Guide

1. **Navigate & Explore**: Pan and zoom across the interactive Leaflet map to inspect satellite imagery.
2. **Switch Bands & Indices**: Use the top control panel to switch between natural True Color RGB, false color infrared, and calculated vegetation/water indices (NDVI/NDWI).
3. **Compare High-Resolution vs Low-Resolution**: Engage the split slider mode to directly inspect differences between raw 10m Sentinel-2 bands and the super-resolved 2.5m reconstruction.
4. **Draw AOI**:
   - Click the **Square AOI** toggle in the header.
   - Click and drag anywhere on the map to define an extraction zone.
   - *Tip*: Hold the **Spacebar** while AOI mode is active to pan around the map without creating new selections.
5. **Export GeoTIFF**: Once an AOI is drawn, click **Export GeoTIFF** to package and download high-resolution GeoTIFF bands directly to your local machine.

---

## License

This project is licensed under the terms described in the repository's [LICENSE](LICENSE) file.
