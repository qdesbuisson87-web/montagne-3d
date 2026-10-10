// Walking itineraries computed by the IGN route service (Géoplateforme, pedestrian profile over the BD TOPO
// network of footpaths, tracks and roads). The service starts and ends on the nearest path: when the chosen
// point is off the paths (a summit, a glacier) the itinerary says how far from it the paths end, and never
// invents the rest (alpine terrain is not a footpath).
import { lonLatToWorld } from './geo.js?v=202610101153';
import { cachedFetch } from './net.js?v=202610101153';

// vias: points to pass by on the way, in order (a loop: start = end, vias around)
const URL_ = (a, b, vias = []) => `https://data.geopf.fr/navigation/itineraire?resource=bdtopo-pgr&profile=pedestrian&optimization=shortest&start=${a.lon.toFixed(6)},${a.lat.toFixed(6)}&end=${b.lon.toFixed(6)},${b.lat.toFixed(6)}${vias.length ? `&intermediates=${vias.map(v => `${v.lon.toFixed(6)},${v.lat.toFixed(6)}`).join('|')}` : ''}&geometryFormat=geojson&getSteps=false`;
const metres = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371000; };

// a, b: { lon, lat }. Returns the path in scene metres, and how far its ends are from the points asked for.
export async function walkingRoute(a, b, vias = []) {
  const r = await cachedFetch(URL_(a, b, vias));
  if (!r.ok) throw new Error(r.status === 404 ? "aucun chemin trouvé entre ces deux points" : `service IGN indisponible (${r.status})`);
  const j = await r.json(), c = j.geometry?.coordinates;
  if (!c?.length) throw new Error("aucun chemin trouvé entre ces deux points");
  const first = { lon: c[0][0], lat: c[0][1] }, last = { lon: c[c.length - 1][0], lat: c[c.length - 1][1] };
  return { pts: c.map(([lon, lat]) => lonLatToWorld(lon, lat)), ll: c.map(([lon, lat]) => [lon, lat]), offStart: metres(a, first), offEnd: metres(b, last) };
}
