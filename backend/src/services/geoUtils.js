/**
 * Standard Web Mercator (EPSG:3857 / Slippy Tile) geospatial mathematics
 */

// Convert lon/lat to tile numbers x, y at given zoom
function lonLatToTile(lon, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y, z: zoom };
}

// Convert tile x, y, z to bounding box [west, south, east, north] in degrees
function tileToBBox(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  
  const north = (northRad * 180) / Math.PI;
  const south = (southRad * 180) / Math.PI;
  
  return { west, south, east, north };
}

// Check if two bounding boxes overlap
function bboxesIntersect(b1, b2) {
  return !(
    b1.east < b2.west ||
    b1.west > b2.east ||
    b1.south > b2.north ||
    b1.north < b2.south
  );
}

module.exports = {
  lonLatToTile,
  tileToBBox,
  bboxesIntersect,
};
