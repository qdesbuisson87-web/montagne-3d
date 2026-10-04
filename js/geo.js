// Coordinates: web-mercator for tiles, a local metric frame for the 3D scene
// (origin at the selected summit, x = east, z = south, y = altitude in metres), Lambert-93 for IGN elevation.
export const RE = 20037508.342789244;
import { SITE } from './sites.js?v=202610042110';
export const ORIGIN = SITE.origin;

const d2r = Math.PI / 180;
export const lonLatToMerc = (lon, lat) => [lon * RE / 180, Math.log(Math.tan(Math.PI / 4 + lat * d2r / 2)) * RE / Math.PI];
export const mercToLonLat = (mx, my) => [mx / RE * 180, (2 * Math.atan(Math.exp(my / RE * Math.PI)) - Math.PI / 2) / d2r];

const [MX0, MY0] = lonLatToMerc(ORIGIN.lon, ORIGIN.lat);
export const K = Math.cos(ORIGIN.lat * d2r); // mercator metres -> ground metres around the origin

export const mercToWorld = (mx, my) => [(mx - MX0) * K, -(my - MY0) * K];
export const worldToMerc = (x, z) => [x / K + MX0, -z / K + MY0];
export const lonLatToWorld = (lon, lat) => mercToWorld(...lonLatToMerc(lon, lat));
export const worldToLonLat = (x, z) => mercToLonLat(...worldToMerc(x, z));

export function tileMerc(z, x, y) {
  const size = 2 * RE / 2 ** z, minx = -RE + x * size, maxy = RE - y * size;
  return { minx, maxx: minx + size, miny: maxy - size, maxy, size };
}
export const lonLatToTile = (lon, lat, z) => {
  const [mx, my] = lonLatToMerc(lon, lat), n = 2 ** z;
  return [(mx + RE) / (2 * RE) * n, (RE - my) / (2 * RE) * n];
};

// Lambert-93 (EPSG:2154), GRS80
export function lonLatToL93(lon, lat) {
  const n = 0.7256077650, C = 11754255.426, e = 0.08181919112, s = Math.sin(lat * d2r);
  const L = 0.5 * Math.log((1 + s) / (1 - s)) - e / 2 * Math.log((1 + e * s) / (1 - e * s));
  const r = C * Math.exp(-n * L), g = n * (lon - 3) * d2r;
  return [700000 + r * Math.sin(g), 12655612.050 - r * Math.cos(g)];
}
// inverse: Lambert-93 metres -> lon/lat degrees (isometric latitude solved by a few fixed-point steps)
export function l93ToLonLat(X, Y) {
  const n = 0.7256077650, C = 11754255.426, e = 0.08181919112, dx = X - 700000, dy = Y - 12655612.050;
  const R = Math.hypot(dx, dy), gamma = Math.atan2(dx, -dy), L = -Math.log(R / C) / n;
  let phi = 2 * Math.atan(Math.exp(L)) - Math.PI / 2;
  for (let i = 0; i < 6; i++) { const s = e * Math.sin(phi); phi = 2 * Math.atan(Math.pow((1 + s) / (1 - s), e / 2) * Math.exp(L)) - Math.PI / 2; }
  return [3 + gamma / n / d2r, phi / d2r];
}
