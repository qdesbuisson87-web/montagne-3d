// What grows in the forests: IGN BD Forêt V2 (vegetation formations, by dominant species), served by the IGN as
// a coloured map image (WMS). Each pixel's colour is the legend colour of its formation; it is turned into
// shares of four kinds of trees that look and change differently through the year:
// broadleaf (turn yellow/orange in autumn, bare in winter), larch (golden in autumn, bare in winter),
// pine (incl. arolla), fir/spruce (evergreen). Legend from the service's GetLegendGraphic (01/10/2026).
export const FOREST_WMS = ([x0, y0, x1, y1], w, h) => `https://data.geopf.fr/wms-v/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=LANDCOVER.FORESTINVENTORY.V2&STYLES=&CRS=EPSG:3857&BBOX=${x0},${y0},${x1},${y1}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`;

// legend colour -> [broadleaf, larch, pine] shares (the rest of a forest is fir/spruce); null: not a forest
const B = [1, 0, 0], L = [0, 1, 0], P = [0, 0, 1], S = [0, 0, 0];
const LEGEND = [
  ['#008C4D', B], ['#004D2E', B], ['#668040', B], ['#00FF80', B], ['#40FF1C', B], ['#915633', B], ['#AFCA59', B], ['#00D92F', B], ['#CCFFBF', B], ['#FFFF00', B],
  ['#BF26FF', P], ['#9926FF', P], ['#4D33FF', P], ['#FF1AFF', P], ['#734DE6', P], ['#A666FF', P], ['#D999FF', P],
  ['#4D80FF', L],
  ['#1AE6E6', S], ['#3399FF', S], ['#00929F', S], ['#59FFFF', S], ['#404DFF', S], ['#8080FF', S], ['#99B3CC', S],
  ['#FF6633', [0.6, 0, 0]], ['#FFD138', [0.6, 0, 0]], ['#FF4033', [0.3, 0, 0]],
  ['#E5C45D', null], ['#B3B3B3', null], ['#FFE6BF', null], ['#FFF9A5', null]
].map(([hex, s]) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), s]);

// RGBA of the map image -> RGBA shares: R broadleaf, G larch, B pine, A forest (all ×255)
export function decodeForest(src) {
  const out = new Uint8ClampedArray(src.length);
  let lastKey = -1, last = null;
  for (let k = 0; k < src.length; k += 4) {
    if (src[k + 3] < 128) continue; // transparent: no formation mapped here
    const key = (src[k] << 16) | (src[k + 1] << 8) | src[k + 2];
    if (key !== lastKey) { // nearest legend colour (edges are blended by the map's antialiasing)
      let best = null, bd = 3600;
      for (const e of LEGEND) { const d = (e[0] - src[k]) ** 2 + (e[1] - src[k + 1]) ** 2 + (e[2] - src[k + 2]) ** 2; if (d < bd) { bd = d; best = e; } }
      lastKey = key; last = best;
    }
    if (!last || !last[3]) continue;
    const s = last[3]; out[k] = s[0] * 255; out[k + 1] = s[1] * 255; out[k + 2] = s[2] * 255; out[k + 3] = 255;
  }
  return out;
}
