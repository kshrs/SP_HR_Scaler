import React, { useEffect, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  useMap,
  useMapEvents,
  Polygon,
} from 'react-leaflet';
import L from 'leaflet';
import type { BandItem, Coordinates, TileCoordinates } from '../types';

interface MapViewportProps {
  activeBand: BandItem | null;
  pointerCoords: Coordinates | null;
  onPointerMove: (coords: Coordinates) => void;
  center: [number, number];
  zoom: number;
}

// Sentinel-2 target AOI bounding box
const AOI_POLYGON: [number, number][] = [
  [11.957275, 78.443025],
  [11.96708, 78.443025],
  [11.96708, 78.453219],
  [11.957275, 78.453219],
];

// Helper component to track map movements, zoom level changes, and pointer events
const MapEventsObserver: React.FC<{
  onPointerMove: (coords: Coordinates) => void;
  onZoomChange: (z: number) => void;
  onCenterTileChange: (tile: TileCoordinates) => void;
}> = ({ onPointerMove, onZoomChange, onCenterTileChange }) => {
  const map = useMapEvents({
    mousemove(e) {
      onPointerMove({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
    zoomend() {
      const currentZoom = map.getZoom();
      onZoomChange(currentZoom);
      updateCenterTile(map.getCenter(), currentZoom);
    },
    moveend() {
      updateCenterTile(map.getCenter(), map.getZoom());
    },
  });

  const updateCenterTile = (centerLatLng: L.LatLng, z: number) => {
    const n = Math.pow(2, z);
    const x = Math.floor(((centerLatLng.lng + 180) / 360) * n);
    const latRad = (centerLatLng.lat * Math.PI) / 180;
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    onCenterTileChange({ x, y, z });
  };

  useEffect(() => {
    updateCenterTile(map.getCenter(), map.getZoom());
  }, []);

  return null;
};

// Map controller to execute external programmatic views
const MapController: React.FC<{ center: [number, number]; zoom: number }> = ({
  center,
  zoom,
}) => {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom, { animate: true });
  }, [center, zoom, map]);
  return null;
};

export const MapViewport: React.FC<MapViewportProps> = ({
  activeBand,
  pointerCoords,
  onPointerMove,
  center,
  zoom,
}) => {
  const mapRef = useRef<L.Map | null>(null);
  const [currentZoom, setCurrentZoom] = useState<number>(zoom);
  const [centerTile, setCenterTile] = useState<TileCoordinates>({ x: 23524, y: 15287, z: 15 });

  const handleZoomIn = () => {
    mapRef.current?.zoomIn();
  };

  const handleZoomOut = () => {
    mapRef.current?.zoomOut();
  };

  const handleResetOrientation = () => {
    if (mapRef.current) {
      mapRef.current.setView(center, 15, { animate: true });
    }
  };

  const formatCoord = (lat: number, lng: number) => {
    const latDeg = Math.floor(Math.abs(lat));
    const latMin = Math.floor((Math.abs(lat) - latDeg) * 60);
    const latSec = Math.floor(((Math.abs(lat) - latDeg) * 60 - latMin) * 60);
    const latDir = lat >= 0 ? 'N' : 'S';

    const lngDeg = Math.floor(Math.abs(lng));
    const lngMin = Math.floor((Math.abs(lng) - lngDeg) * 60);
    const lngSec = Math.floor(((Math.abs(lng) - lngDeg) * 60 - lngMin) * 60);
    const lngDir = lng >= 0 ? 'E' : 'W';

    return `${latDeg}°${latMin}'${latSec}"${latDir} ${lngDeg}°${lngMin}'${lngSec}"${lngDir}`;
  };

  // Dynamic async tile pattern for the active band from the backend
  const activeTileUrl = activeBand?.tilePattern || '/api/tiles/rgb/{z}/{x}/{y}.png';

  return (
    <main
      className="flex-1 relative bg-[#0f1113] overflow-hidden"
      data-purpose="geospatial-map-display"
    >
      {/* Interactive Leaflet Map Container */}
      <MapContainer
        center={center}
        zoom={zoom}
        ref={mapRef}
        className="w-full h-full z-0"
        zoomControl={false}
        minZoom={3}
        maxZoom={18}
      >
        <MapController center={center} zoom={zoom} />
        <MapEventsObserver
          onPointerMove={onPointerMove}
          onZoomChange={setCurrentZoom}
          onCenterTileChange={setCenterTile}
        />


        {/* Dynamic Async Sentinel-2 Tile Layer from Node Backend Cache */}
        <TileLayer
          key={activeBand?.id || 'rgb'}
          url={activeTileUrl}
          opacity={0.92}
          maxZoom={18}
          minZoom={4}
          tileSize={256}
        />

        {/* Target AOI Boundary Polygon */}
        <Polygon
          positions={AOI_POLYGON}
          pathOptions={{
            color: '#00bcd4',
            weight: 1.5,
            fillColor: 'transparent',
            dashArray: '4, 4',
          }}
        />
      </MapContainer>

      {/* Floating Canvas Controls */}
      <div className="absolute right-6 top-6 z-10 flex flex-col items-center space-y-2 pointer-events-auto">
        <button
          onClick={handleZoomIn}
          className="w-8 h-8 rounded bg-[#181a1e]/90 border border-[#2b3038] text-slate-200 flex items-center justify-center shadow hover:bg-[#202328] transition-colors cursor-pointer"
          title="Zoom In"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M12 6v12M6 12h12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        </button>
        <button
          onClick={handleZoomOut}
          className="w-8 h-8 rounded bg-[#181a1e]/90 border border-[#2b3038] text-slate-200 flex items-center justify-center shadow hover:bg-[#202328] transition-colors cursor-pointer"
          title="Zoom Out"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M6 12h12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        </button>
        <button
          onClick={handleResetOrientation}
          className="w-8 h-8 rounded bg-[#181a1e]/90 border border-[#2b3038] text-slate-200 flex items-center justify-center shadow hover:bg-[#202328] transition-colors text-xs font-mono font-bold cursor-pointer"
          title="Reset Orientation"
        >
          N
        </button>
      </div>

      {/* Active Band Badge & Zoom Tile HUD Floating on Map */}
      <div className="absolute left-6 top-6 z-10 pointer-events-auto flex flex-col space-y-1">
        <div className="bg-[#141619]/90 backdrop-blur-md border border-[#2b3036] px-3 py-1.5 rounded flex items-center space-x-2 text-xs">
          <span className="w-2 h-2 rounded-full bg-[#00bcd4] animate-pulse" />
          <span className="font-semibold text-white">
            {activeBand ? activeBand.name : 'Sentinel-2 L2A'}
          </span>
          <span className="text-[#7a828e] font-mono text-[10px]">
            {activeBand?.resolution}
          </span>
        </div>
        <div className="bg-[#141619]/80 border border-[#22272d] px-2.5 py-1 rounded text-[10px] font-mono text-[#7a828e] flex items-center space-x-2">
          <span>Zoom: <strong className="text-white">{currentZoom}</strong></span>
          <span>•</span>
          <span>Center Tile: <strong className="text-[#00bcd4]">[{centerTile.x}, {centerTile.y}]</strong></span>
        </div>
      </div>

      {/* Map Coordinates & Attribution bar in corner */}
      <div className="absolute right-4 bottom-2 z-10 text-[10px] text-[#7a828e] font-mono flex items-center space-x-4 bg-[#111315]/80 px-2 py-0.5 rounded border border-[#25282f]/60 select-none">
        <span>
          {pointerCoords
            ? formatCoord(pointerCoords.lat, pointerCoords.lng)
            : `11°57'44"N 78°26'52"E`}
        </span>
        <span>Elevation: 1,420m</span>
        <span>© Team ThunderBoltz - SIH26</span>
      </div>
    </main>
  );
};
