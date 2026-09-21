import React, { useEffect, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  Pane,
  Rectangle,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import type { BandItem, Coordinates, TileCoordinates, BoundingBox } from '../types';

interface MapViewportProps {
  activeBand: BandItem | null;
  pointerCoords: Coordinates | null;
  onPointerMove: (coords: Coordinates) => void;
  center: [number, number];
  zoom: number;
  isSplitView?: boolean;
  isSelectingAoi?: boolean;
  selectedAoi: BoundingBox | null;
  onSelectAoi: (bbox: BoundingBox) => void;
}

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

// Square AOI selector: allows clicking & dragging or clicking on map to draw a strict square AOI
// Holding the Spacebar temporarily switches into pan mode while in AOI selection mode
const AoiSquareSelector: React.FC<{
  isSelecting: boolean;
  onAoiSelected: (bbox: BoundingBox) => void;
}> = ({ isSelecting, onAoiSelected }) => {
  const map = useMap();
  const startPointRef = useRef<L.LatLng | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const isSpacePressedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isSelecting) {
      map.dragging.enable();
      const container = map.getContainer();
      container.style.cursor = '';
      return;
    }

    const container = map.getContainer();

    const updateMapInteractionMode = () => {
      if (isSpacePressedRef.current) {
        map.dragging.enable();
        container.style.cursor = 'grab';
      } else {
        map.dragging.disable();
        container.style.cursor = 'crosshair';
      }
    };

    updateMapInteractionMode();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        // Prevent default window page scroll on spacebar
        e.preventDefault();
        isSpacePressedRef.current = true;
        // If user was drawing an AOI, cancel current draw so it doesn't get messed up
        isDraggingRef.current = false;
        startPointRef.current = null;
        updateMapInteractionMode();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        isSpacePressedRef.current = false;
        updateMapInteractionMode();
      }
    };

    const onMouseDown = (e: L.LeafletMouseEvent) => {
      if (isSpacePressedRef.current) return;
      startPointRef.current = e.latlng;
      isDraggingRef.current = true;
    };

    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (isSpacePressedRef.current || !isDraggingRef.current || !startPointRef.current) return;
      const p1 = startPointRef.current;
      const p2 = e.latlng;

      // Force strictly square dimensions: equalize deltaLat and deltaLng
      const dLat = Math.abs(p2.lat - p1.lat);
      const dLng = Math.abs(p2.lng - p1.lng);
      const side = Math.max(dLat, dLng);

      const latSign = p2.lat >= p1.lat ? 1 : -1;
      const lngSign = p2.lng >= p1.lng ? 1 : -1;

      const p2SquareLat = p1.lat + latSign * side;
      const p2SquareLng = p1.lng + lngSign * side;

      const south = Math.min(p1.lat, p2SquareLat);
      const north = Math.max(p1.lat, p2SquareLat);
      const west = Math.min(p1.lng, p2SquareLng);
      const east = Math.max(p1.lng, p2SquareLng);

      onAoiSelected({ west, south, east, north });
    };

    const onMouseUp = (e: L.LeafletMouseEvent) => {
      if (isSpacePressedRef.current) return;
      if (isDraggingRef.current && startPointRef.current) {
        const p1 = startPointRef.current;
        const p2 = e.latlng;
        let dLat = Math.abs(p2.lat - p1.lat);
        let dLng = Math.abs(p2.lng - p1.lng);
        let side = Math.max(dLat, dLng);

        // If it was just a click without dragging, default to a sensible square AOI (~1.6km square)
        if (side < 0.002) {
          side = 0.015; // ~1.6 km square
        }

        const south = p1.lat - side / 2;
        const north = p1.lat + side / 2;
        const west = p1.lng - side / 2;
        const east = p1.lng + side / 2;

        onAoiSelected({ west, south, east, north });
      }
      isDraggingRef.current = false;
      startPointRef.current = null;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      map.dragging.enable();
      container.style.cursor = '';
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
    };
  }, [isSelecting, map, onAoiSelected]);

  return null;
};

export const MapViewport: React.FC<MapViewportProps> = ({
  activeBand,
  pointerCoords,
  onPointerMove,
  center,
  zoom,
  isSplitView = false,
  isSelectingAoi = false,
  selectedAoi,
  onSelectAoi,
}) => {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentZoom, setCurrentZoom] = useState<number>(zoom);
  const [centerTile, setCenterTile] = useState<TileCoordinates>({ x: 23264, y: 15422, z: 15 });
  const [elevation, setElevation] = useState<number | null>(null);
  const [isFetchingElevation, setIsFetchingElevation] = useState<boolean>(false);

  // Split-screen movable separator position (percentage from 0 to 100)
  const [splitPos, setSplitPos] = useState<number>(50);
  const isDraggingSplitRef = useRef<boolean>(false);

  // Dynamically update elevation when pointer coordinates or map center changes
  useEffect(() => {
    const targetLat = pointerCoords ? pointerCoords.lat : center[0];
    const targetLng = pointerCoords ? pointerCoords.lng : center[1];

    const timer = setTimeout(() => {
      setIsFetchingElevation(true);
      fetch(`/api/elevation?lat=${targetLat}&lon=${targetLng}`)
        .then((res) => {
          if (!res.ok) throw new Error('Elevation fetch failed');
          return res.json();
        })
        .then((data) => {
          if (typeof data.elevation === 'number') {
            setElevation(data.elevation);
          }
        })
        .catch((err) => {
          console.warn('[Elevation] Fetch warning:', err.message);
        })
        .finally(() => {
          setIsFetchingElevation(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [pointerCoords?.lat, pointerCoords?.lng, center]);

  // Handle dragging the split slider separation
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSplitRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const percentage = Math.max(5, Math.min(95, (relativeX / rect.width) * 100));
      setSplitPos(percentage);
    };

    const handleMouseUp = () => {
      isDraggingSplitRef.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

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

  // Dynamic async tile patterns for normal layer and Swin2SR layer
  const baseTileUrl = activeBand?.tilePattern || '/api/tiles/rgb/{z}/{x}/{y}.png';
  const srTileUrl = '/api/tiles/sr/{z}/{x}/{y}.png';

  return (
    <main
      ref={containerRef}
      className="flex-1 relative bg-[#0f1113] overflow-hidden select-none"
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

        {/* 1. Normal / Base Tile Layer (Visible on Left side or Full screen) */}
        <TileLayer
          key={activeBand?.id || 'rgb'}
          url={baseTileUrl}
          opacity={0.96}
          maxZoom={18}
          minZoom={4}
          tileSize={256}
          className="smooth-tiles"
        />

        {/* 2. Swin2SR Super-Resolution Tile Layer (Visible on Right side when Split-View is active) */}
        {isSplitView && (
          <Pane name="swin2srPane" style={{ zIndex: 250 }}>
            <TileLayer
              key="swin2sr-sr-layer"
              url={srTileUrl}
              opacity={1.0}
              maxZoom={18}
              minZoom={4}
              tileSize={256}
              className="smooth-tiles"
            />
          </Pane>
        )}

        {/* 3. Interactive Square AOI Selection Controller */}
        <AoiSquareSelector isSelecting={isSelectingAoi} onAoiSelected={onSelectAoi} />

        {/* 4. Render Selected Square AOI Bounding Box */}
        {selectedAoi && (
          <Rectangle
            bounds={[
              [selectedAoi.south, selectedAoi.west],
              [selectedAoi.north, selectedAoi.east],
            ]}
            pathOptions={{
              color: '#00bcd4',
              weight: 2,
              fillColor: '#00bcd4',
              fillOpacity: 0.15,
              dashArray: isSelectingAoi ? '4, 4' : undefined,
            }}
          />
        )}
      </MapContainer>

      {/* AOI Selection Guide Banner overlay */}
      {isSelectingAoi && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-[#141619]/95 border border-[#00bcd4]/70 px-4 py-2 rounded-lg shadow-xl backdrop-blur-md flex items-center space-x-3 text-xs text-white">
          <span className="w-2.5 h-2.5 rounded-full bg-[#00bcd4] animate-ping" />
          <span>
            Click or drag to select a <strong>Square AOI</strong> &bull; Hold <kbd className="bg-[#22272d] border border-slate-600 px-1.5 py-0.5 rounded text-[10px] font-mono text-cyan-300">Space</kbd> to Pan
          </span>
          {selectedAoi && (
            <span className="text-emerald-400 font-mono text-[11px] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
              Square AOI Ready
            </span>
          )}
        </div>
      )}

      {/* Dynamic CSS Clip Path applied to Swin2SR Pane to restrict it to right side of divider */}
      {isSplitView && (
        <style>{`
          .leaflet-pane.leaflet-swin2srPane-pane {
            clip-path: polygon(${splitPos}% 0%, 100% 0%, 100% 100%, ${splitPos}% 100%) !important;
            width: 100% !important;
            height: 100% !important;
          }
        `}</style>
      )}

      {/* Movable Split Separation Line & Handle */}
      {isSplitView && (
        <div
          style={{ left: `${splitPos}%` }}
          className="absolute top-0 bottom-0 z-20 pointer-events-auto cursor-ew-resize flex items-center justify-center -ml-[2px]"
          onMouseDown={(e) => {
            e.preventDefault();
            isDraggingSplitRef.current = true;
          }}
        >
          {/* Vertical divider bar */}
          <div className="w-[3px] h-full bg-[#00bcd4] shadow-[0_0_10px_rgba(0,188,212,0.8)]" />

          {/* Central draggable handle badge */}
          <div className="absolute w-8 h-8 rounded-full bg-[#181a1e] border-2 border-[#00bcd4] shadow-[0_0_12px_rgba(0,188,212,0.6)] flex items-center justify-center text-white cursor-ew-resize select-none">
            <svg className="w-4 h-4 text-[#00bcd4]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 9l-4 3 4 3m8-6l4 3-4 3" />
            </svg>
          </div>

          {/* Floating Left/Right Indicators */}
          <div className="absolute top-4 -left-28 bg-[#141619]/90 border border-[#2b3036] px-2 py-1 rounded text-[10px] font-semibold text-slate-200 pointer-events-none shadow backdrop-blur-sm">
            {activeBand ? activeBand.name : 'Original (10m)'}
          </div>
          <div className="absolute top-4 left-3 bg-[#141619]/90 border border-amber-400/50 px-2 py-1 rounded text-[10px] font-semibold text-amber-400 pointer-events-none shadow backdrop-blur-sm flex items-center space-x-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span>Swin2SR 4x (2.5m)</span>
          </div>
        </div>
      )}

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
            : `10°59'53"N 76°56'10"E`}
        </span>
        <span className="flex items-center space-x-1">
          <span>Elevation:</span>
          <span className="text-slate-200 font-semibold">
            {elevation !== null ? `${elevation.toLocaleString()}m` : isFetchingElevation ? '...' : '--'}
          </span>
        </span>
        <span>© Team ThunderBoltz - SIH26</span>
      </div>
    </main>
  );
};
