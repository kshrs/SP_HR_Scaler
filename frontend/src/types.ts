export interface BandItem {
  id: string;
  code: string;
  name: string;
  category: 'preset' | 'band' | 'index';
  wavelength?: string;
  resolution: string;
  badgeColor?: string;
  viewUrl: string;
  description: string;
}

export interface Coordinates {
  lat: number;
  lng: number;
}
