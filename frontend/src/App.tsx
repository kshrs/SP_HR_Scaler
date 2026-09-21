import React, { useState, useEffect } from 'react';
import { Header, Sidebar, MapViewport } from './components';
import type { BandItem, Coordinates, BoundingBox } from './types';

// Default Sentinel-2 bands matching research/db/ and backend STAC
const INITIAL_BANDS: BandItem[] = [
  // 1. Visual Compositions
  {
    id: 'rgb',
    code: 'RGB',
    name: 'True Color (RGB)',
    category: 'preset',
    resolution: '10m',
    description: 'B4, B3, B2',
    tilePattern: '/api/tiles/rgb/{z}/{x}/{y}.png',
  },
  {
    id: 'sr',
    code: 'SR',
    name: 'Swin2SR Super-Res',
    category: 'preset',
    resolution: '2.5m',
    description: '4x Deep Learning Super-Resolution',
    tilePattern: '/api/tiles/sr/{z}/{x}/{y}.png',
  },
  {
    id: 'cir',
    code: 'CIR',
    name: 'False Color (Urban / IR)',
    category: 'preset',
    resolution: '10m',
    description: 'B8, B4, B3',
    tilePattern: '/api/tiles/cir/{z}/{x}/{y}.png',
  },

  // 2. Spectral Bands
  {
    id: 'B01',
    code: 'B1',
    name: 'Coastal Aerosol',
    category: 'band',
    wavelength: '443 nm',
    resolution: '60m',
    badgeColor: 'text-cyan-400/90',
    tilePattern: '/api/tiles/b01/{z}/{x}/{y}.png',
    description: 'Atmospheric correction',
  },
  {
    id: 'B02',
    code: 'B2',
    name: 'Blue',
    category: 'band',
    wavelength: '490 nm',
    resolution: '10m',
    badgeColor: 'text-blue-400',
    tilePattern: '/api/tiles/b02/{z}/{x}/{y}.png',
    description: 'Surface water mapping',
  },
  {
    id: 'B03',
    code: 'B3',
    name: 'Green',
    category: 'band',
    wavelength: '560 nm',
    resolution: '10m',
    badgeColor: 'text-emerald-400',
    tilePattern: '/api/tiles/b03/{z}/{x}/{y}.png',
    description: 'Vegetation peak reflectance',
  },
  {
    id: 'B04',
    code: 'B4',
    name: 'Red',
    category: 'band',
    wavelength: '665 nm',
    resolution: '10m',
    badgeColor: 'text-red-400',
    tilePattern: '/api/tiles/b04/{z}/{x}/{y}.png',
    description: 'Chlorophyll absorption',
  },
  {
    id: 'B05',
    code: 'B5',
    name: 'Vegetation Red Edge 1',
    category: 'band',
    wavelength: '705 nm',
    resolution: '20m',
    badgeColor: 'text-lime-400',
    tilePattern: '/api/tiles/b05/{z}/{x}/{y}.png',
    description: 'Leaf nitrogen content',
  },
  {
    id: 'B06',
    code: 'B6',
    name: 'Vegetation Red Edge 2',
    category: 'band',
    wavelength: '740 nm',
    resolution: '20m',
    badgeColor: 'text-lime-400',
    tilePattern: '/api/tiles/b06/{z}/{x}/{y}.png',
    description: 'Leaf area index (LAI)',
  },
  {
    id: 'B07',
    code: 'B7',
    name: 'Vegetation Red Edge 3',
    category: 'band',
    wavelength: '783 nm',
    resolution: '20m',
    badgeColor: 'text-lime-400',
    tilePattern: '/api/tiles/b07/{z}/{x}/{y}.png',
    description: 'Canopy biomass edge',
  },
  {
    id: 'B08',
    code: 'B8',
    name: 'NIR (Near Infrared)',
    category: 'band',
    wavelength: '842 nm',
    resolution: '10m',
    badgeColor: 'text-fuchsia-400',
    tilePattern: '/api/tiles/b08/{z}/{x}/{y}.png',
    description: 'Canopy cell structure',
  },
  {
    id: 'B8A',
    code: 'B8A',
    name: 'Narrow NIR',
    category: 'band',
    wavelength: '865 nm',
    resolution: '20m',
    badgeColor: 'text-fuchsia-400',
    tilePattern: '/api/tiles/b8a/{z}/{x}/{y}.png',
    description: 'Water vapor avoidance',
  },
  {
    id: 'B09',
    code: 'B9',
    name: 'Water Vapour',
    category: 'band',
    wavelength: '945 nm',
    resolution: '60m',
    badgeColor: 'text-sky-400',
    tilePattern: '/api/tiles/b09/{z}/{x}/{y}.png',
    description: 'Atmospheric water column',
  },
  {
    id: 'B11',
    code: 'B11',
    name: 'SWIR 1',
    category: 'band',
    wavelength: '1610 nm',
    resolution: '20m',
    badgeColor: 'text-amber-400',
    tilePattern: '/api/tiles/b11/{z}/{x}/{y}.png',
    description: 'Moisture & snow/cloud',
  },
  {
    id: 'B12',
    code: 'B12',
    name: 'SWIR 2',
    category: 'band',
    wavelength: '2190 nm',
    resolution: '20m',
    badgeColor: 'text-amber-500',
    tilePattern: '/api/tiles/b12/{z}/{x}/{y}.png',
    description: 'Soils & mineralogy',
  },

  // 3. Spectral Indices
  {
    id: 'ndvi',
    code: 'NDVI',
    name: 'Vegetation Index',
    category: 'index',
    resolution: '10m',
    badgeColor: 'text-green-400',
    tilePattern: '/api/tiles/ndvi/{z}/{x}/{y}.png',
    description: '(B8-B4)/(B8+B4)',
  },
  {
    id: 'ndmi',
    code: 'NDMI',
    name: 'Moisture Index',
    category: 'index',
    resolution: '10m',
    badgeColor: 'text-cyan-400',
    tilePattern: '/api/tiles/ndmi/{z}/{x}/{y}.png',
    description: '(B8-SWIR)/(B8+SWIR)',
  },
];

// Coimbatore, Tamil Nadu — primary AOI for the SIH demonstration
const AOI_CENTER: [number, number] = [10.9981, 76.9366];

export const App: React.FC = () => {
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [isSplitView, setIsSplitView] = useState<boolean>(false);
  const [bands, setBands] = useState<BandItem[]>(INITIAL_BANDS);
  const [activeBandId, setActiveBandId] = useState<string>('rgb');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [pointerCoords, setPointerCoords] = useState<Coordinates | null>(null);
  const [center, setCenter] = useState<[number, number]>(AOI_CENTER);
  const [zoom, setZoom] = useState<number>(15);

  // GeoTIFF AOI Square Selection and Export states
  const [isSelectingAoi, setIsSelectingAoi] = useState<boolean>(false);
  const [selectedAoi, setSelectedAoi] = useState<BoundingBox | null>(null);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportNotice, setExportNotice] = useState<{ message: string; isError?: boolean } | null>(null);

  // Sync band configuration dynamically from backend metadata
  useEffect(() => {
    fetch('/api/metadata')
      .then((res) => {
        if (!res.ok) throw new Error('Network error');
        return res.json();
      })
      .then((data) => {
        if (data.availableBands && data.availableBands.length > 0) {
          const mapped: BandItem[] = data.availableBands.map((b: any) => ({
            id: b.id,
            code: b.code,
            name: b.name,
            category: b.type === 'composite' ? 'preset' : 'band',
            resolution: b.resolution,
            description: b.description,
            viewUrl: b.viewUrl,
            tilePattern: b.tilePattern || `/api/tiles/${b.id.toLowerCase()}/{z}/{x}/{y}.png`,
          }));
          setBands(mapped);
        }
      })
      .catch((err) => {
        console.warn('Using local band patterns:', err.message);
      });
  }, []);

  const activeBand = bands.find((b) => b.id === activeBandId) || bands[0];

  const handleRecenter = () => {
    setCenter([...AOI_CENTER]);
    setZoom(15);
  };

  const handleToggleSelectAoi = () => {
    setIsSelectingAoi((prev) => !prev);
    if (!selectedAoi && !isSelectingAoi) {
      // Default initial square AOI around map center (~1.6km square) if none selected yet
      const side = 0.015;
      setSelectedAoi({
        west: center[1] - side / 2,
        south: center[0] - side / 2,
        east: center[1] + side / 2,
        north: center[0] + side / 2,
      });
    }
  };

  const handleExportGeoTiff = async () => {
    // If no AOI selected yet, default to a square centered around current center
    let aoiToExport = selectedAoi;
    if (!aoiToExport) {
      const side = 0.015;
      aoiToExport = {
        west: center[1] - side / 2,
        south: center[0] - side / 2,
        east: center[1] + side / 2,
        north: center[0] + side / 2,
      };
      setSelectedAoi(aoiToExport);
    }

    setIsExporting(true);
    setExportNotice(null);

    try {
      const response = await fetch('/api/export-geotiff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aoiToExport),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error || 'Export request failed');
      }

      setExportNotice({
        message: `Successfully exported ${data.count} GeoTIFF bands to ~/Downloads/${data.folderName}`,
        isError: false,
      });
      setIsSelectingAoi(false);
    } catch (err: any) {
      console.error('[Export Error]', err);
      setExportNotice({
        message: `Export failed: ${err.message}`,
        isError: true,
      });
    } finally {
      setIsExporting(false);
      setTimeout(() => {
        setExportNotice(null);
      }, 7000);
    }
  };

  return (
    <div className="h-full w-full overflow-hidden text-slate-300 antialiased font-sans flex flex-col select-none bg-[#111315]">
      {/* 1. Header with brand, search, sidebar toggle slider, Swin2SR split toggle, GeoTIFF export and recenter */}
      <Header
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
        isSplitView={isSplitView}
        onToggleSplitView={() => setIsSplitView((prev) => !prev)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onRecenter={handleRecenter}
        isSelectingAoi={isSelectingAoi}
        onToggleSelectAoi={handleToggleSelectAoi}
        onExportGeoTiff={handleExportGeoTiff}
        hasSelectedAoi={Boolean(selectedAoi)}
        isExporting={isExporting}
      />

      {/* Floating Export Notification Toast */}
      {exportNotice && (
        <div
          className={`absolute top-16 right-6 z-50 max-w-md px-4 py-3 rounded-lg shadow-2xl border backdrop-blur-md flex items-center space-x-3 text-xs transition-all ${
            exportNotice.isError
              ? 'bg-rose-950/90 border-rose-500/80 text-rose-200'
              : 'bg-[#141619]/95 border-emerald-500/80 text-emerald-200'
          }`}
        >
          {exportNotice.isError ? (
            <svg className="w-5 h-5 text-rose-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          <span className="font-medium">{exportNotice.message}</span>
          <button
            onClick={() => setExportNotice(null)}
            className="text-slate-400 hover:text-white ml-auto cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* 2. Main Content Area: Sidebar + Interactive Leaflet Map with Async Slippy Tiles */}
      <div className="flex-1 flex overflow-hidden relative" data-purpose="viewport-container">
        {/* Left Primary Sidebar */}
        <Sidebar
          isOpen={isSidebarOpen}
          bands={bands}
          activeBandId={activeBandId}
          onSelectBand={setActiveBandId}
        />

        {/* Center Interactive Geospatial Map */}
        <MapViewport
          activeBand={activeBand}
          pointerCoords={pointerCoords}
          onPointerMove={setPointerCoords}
          center={center}
          zoom={zoom}
          isSplitView={isSplitView}
          isSelectingAoi={isSelectingAoi}
          selectedAoi={selectedAoi}
          onSelectAoi={setSelectedAoi}
        />
      </div>
    </div>
  );
};

export default App;
