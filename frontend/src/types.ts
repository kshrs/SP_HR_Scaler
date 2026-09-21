export interface BandItem {
  id: string;
  code: string;
  name: string;
  category: 'preset' | 'band' | 'index';
  wavelength?: string;
  resolution: string;
  badgeColor?: string;
  viewUrl?: string;
  tilePattern: string;
  description: string;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface TileCoordinates {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}
