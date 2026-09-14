import React, { useEffect, useRef } from 'react';
import {
  MapContainer,
  TileLayer,
  ImageOverlay,
  useMap,
  useMapEvents,
  Polygon,
} from 'react-leaflet';
import L from 'leaflet';
import type { BandItem, Coordinates } from '../types';

interface MapViewportProps {
  activeBand: BandItem | null;
  pointerCoords: Coordinates | null;
  onPointerMove: (coords: Coordinates) => void;
  center: [number, number];
  zoom: number;
}

// Sentinel-2 target AOI bounding box from research/db/metadata.json:
// [minLon: 78.443025, minLat: 11.957275, maxLon: 78.453219, maxLat: 11.96708]
const BOUNDS: L.LatLngBoundsExpression = [
  [11.957275, 78.443025], // South-West [lat, lon]
  [11.96708, 78.453219],  // North-East [lat, lon]
];

// Helper to handle mousemove events over Leaflet map
const MouseEventsHandler: React.FC<{ onPointerMove: (coords: Coordinates) => void }> = ({
  onPointerMove,
}) => {
  useMapEvents({
    mousemove(e) {
      onPointerMove({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
};

// Map controller to execute external zoom and center actions
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
      >
        <MapController center={center} zoom={zoom} />
        <MouseEventsHandler onPointerMove={onPointerMove} />

        {/* High-fidelity CartoDB Dark Matter / Esri Satellite base layer */}
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          maxZoom={20}
        />

        {/* GeoTIFF Band Image Overlay aligned directly to Sentinel-2 Bounding Box */}
        {activeBand && (
          <ImageOverlay
            url={activeBand.viewUrl}
            bounds={BOUNDS}
            opacity={0.92}
            interactive={true}
          />
        )}

        {/* AOI Bounding Box Polygon Accent Border */}
        <Polygon
          positions={[
            [11.957275, 78.443025],
            [11.96708, 78.443025],
            [11.96708, 78.453219],
            [11.957275, 78.453219],
          ]}
          pathOptions={{
            color: '#00bcd4',
            weight: 1.5,
            fillColor: 'transparent',
            dashArray: '4, 4',
          }}
        />
      </MapContainer>

      {/* Map Floating Overlay Controls (Compass & Zoom) */}
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

      {/* Active Band Badge Floating on Map */}
      <div className="absolute left-6 top-6 z-10 pointer-events-auto bg-[#141619]/90 backdrop-blur-md border border-[#2b3036] px-3 py-1.5 rounded flex items-center space-x-2 text-xs">
        <span className="w-2 h-2 rounded-full bg-[#00bcd4] animate-pulse" />
        <span className="font-semibold text-white">
          {activeBand ? activeBand.name : 'Sentinel-2 L2A'}
        </span>
        <span className="text-[#7a828e] font-mono text-[10px]">
          {activeBand?.resolution}
        </span>
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
