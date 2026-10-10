// Catalogue of hikes of the massif, built from official IGN data rather than written by hand:
//  - goals: every named summit, peak and pass (BD TOPO detail_orographique), hut and lake (BD TOPO);
//  - start: the nearest car park (BD TOPO) or top station of a lift (BD TOPO transport_par_cable);
//  - path: the IGN route service on footpaths and tracks (planner.js), which stops where the paths stop;
//  - numbers: altitudes of the IGN RGE ALTI along the path (altimetry service), walking time DIN 33466.
// Nothing is invented: where the path ends short of a goal (glaciers, rock) the entry says how far, and
// everything above 3 000 m or off the paths is marked as high mountain (mountaineering, not hiking).
// Built once per massif (a few minutes, done politely one request at a time) and kept on the device.
import { lonLatToWorld } from './geo.js?v=202610101130';
import { cachedFetch } from './net.js?v=202610101130';
import { walkingRoute } from './planner.js?v=202610101130';

export const WFS = (layer, cql) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${layer}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=3000&CQL_FILTER=${encodeURIComponent(cql)}`;
const ALTI = (lons, lats) => `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${lons.join('|')}&lat=${lats.join('|')}&resource=ign_rge_alti_wld&zonly=true`;
const STORE = id => `midi3d-hikes-${id}-v2`;
const metres = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371000; };
const centre = g => {
  if (g.type === 'Point') return g.coordinates;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.type === 'LineString' ? g.coordinates : g.coordinates[0];
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
};
export async function json(u) { const r = await cachedFetch(u); if (!r.ok) throw new Error(`IGN ${r.status}`); return r.json(); }
export async function altitudes(pts) { // [{lon,lat}] -> metres (IGN RGE ALTI), by batches that keep the URL short
  const out = [];
  for (let i = 0; i < pts.length; i += 150) {
    const b = pts.slice(i, i + 150), j = await json(ALTI(b.map(p => p.lon.toFixed(6)), b.map(p => p.lat.toFixed(6))));
    out.push(...j.elevations.map(v => (v > -1000 ? v : null)));
  }
  return out;
}

// the numbers of a path [[lon, lat]…]: decimated to ≤ 200 points (altitudes asked of the IGN, and a small store),
// distance, climb and descent (steps of 3 m), highest point, DIN 33466 walking time
export async function measure(llFull) {
  const step = Math.max(1, Math.ceil(llFull.length / 200)), ll = llFull.filter((_, i) => i % step === 0 || i === llFull.length - 1);
  const hs = await altitudes(ll.map(([lon, lat]) => ({ lon, lat })));
  let dist = 0, up = 0, down = 0, max = -Infinity, ref = null;
  ll.forEach((p, i) => {
    if (i) dist += metres({ lon: ll[i - 1][0], lat: ll[i - 1][1] }, { lon: p[0], lat: p[1] });
    const h = hs[i]; if (h == null) return; max = Math.max(max, h);
    if (ref == null) ref = h; else if (h - ref >= 3) { up += h - ref; ref = h; } else if (ref - h >= 3) { down += ref - h; ref = h; }
  });
  const th = dist / 4000, tv = up / 300 + down / 500;
  return { dist, up, down, max, startAlt: hs[0], hours: Math.max(th, tv) + Math.min(th, tv) / 2, path: ll.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]) };
}

// difficulty classes (the rules are shown in the app)
export function classify(h) {
  if (h.max > 3000 || h.offEnd > 150) return 'alpine';
  if (h.hours < 3 && h.up < 500) return 'easy';
  if (h.hours < 5 && h.up < 1000) return 'medium';
  if (h.hours < 8) return 'hard';
  return 'long';
}
export const CLASS_NAMES = { easy: 'Facile', medium: 'Moyenne', hard: 'Difficile', long: 'Très longue', alpine: 'Haute montagne' };

export function savedHikes(site) { try { return JSON.parse(localStorage.getItem(STORE(site.id)) || 'null'); } catch { return null; } }
// the catalogue shipped with the app (data/hikes-<site>.json, built the same way beforehand), unless the device
// already holds its own; null for a massif that has none yet
export async function loadHikes(site) {
  const own = savedHikes(site); if (own?.hikes?.length) return own;
  try { const r = await fetch(`data/hikes-${site.id}.json`); return r.ok ? await r.json() : null; } catch { return null; }
}
export function hikePath(h) { return h.path.map(([lon, lat]) => lonLatToWorld(lon, lat)); }

// Builds (or completes) the catalogue; onProgress(list, done, total) is called as entries arrive.
export async function buildHikes(site, onProgress, signal) {
  const [w, s, e, n] = [site.core[0] - 0.06, site.core[1] - 0.05, site.core[2] + 0.06, site.core[3] + 0.05];
  return buildArea([w, s, e, n], STORE(site.id), { onProgress, signal });
}
// Hikes around a place anywhere in France (the IGN data stop at the border), kept by cells of 0.1° so that a
// place nearby reuses them: the goals nearest the place first, at most `max` new ones per call (a call later
// completes the list). `known(goal)`: goals already offered by another list (a massif's catalogue), skipped.
export const nearStore = (lon, lat) => `midi3d-hikes-near-${Math.floor(lat * 10)}_${Math.floor(lon * 10)}`;
export function hikesAround(lon, lat, radiusKm, { max = 25, known = () => false, onProgress, signal } = {}) {
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return buildArea([lon - dLon, lat - dLat, lon + dLon, lat + dLat], nearStore(lon, lat), { centre: { lon, lat }, max, known, onProgress, signal });
}
export function storedAround(lon, lat) { try { return JSON.parse(localStorage.getItem(nearStore(lon, lat)) || 'null')?.hikes ?? []; } catch { return []; } }

async function buildArea([w, s, e, n], storeKey, { centre: c = null, max = Infinity, known = () => false, onProgress, signal } = {}) {
  const box = `BBOX(geometrie,${w},${s},${e},${n},'EPSG:4326')`;
  const [oro, huts, lakes, parks, lifts] = await Promise.all([
    json(WFS('BDTOPO_V3:detail_orographique', `nature IN ('Sommet','Pic','Col') AND toponyme IS NOT NULL AND ${box}`)),
    json(WFS('BDTOPO_V3:zone_d_activite_ou_d_interet', `nature IN ('Refuge','Abri de montagne') AND toponyme IS NOT NULL AND ${box}`)),
    json(WFS('BDTOPO_V3:plan_d_eau', `toponyme IS NOT NULL AND ${box}`)),
    json(WFS('BDTOPO_V3:equipement_de_transport', `nature='Parking' AND ${box}`)),
    json(WFS('BDTOPO_V3:transport_par_cable', box))
  ]);
  const goals = [], seen = new Set();
  const addGoal = (f, kind) => {
    const name = f.properties.toponyme, key = `${kind}/${name}`; if (seen.has(key)) return; seen.add(key);
    const [lon, lat] = centre(f.geometry); goals.push({ name, kind, lon, lat });
  };
  oro.features.forEach(f => addGoal(f, { Col: 'col', Pic: 'sommet', Sommet: 'sommet' }[f.properties.nature]));
  huts.features.forEach(f => addGoal(f, 'refuge'));
  lakes.features.filter(f => !/glacier|névé/i.test(f.properties.nature ?? '')).forEach(f => addGoal(f, 'lac'));
  // starts: car parks, and the top stations of lifts (a hike can start from a cable car)
  const starts = parks.features.map(f => { const [lon, lat] = centre(f.geometry); return { lon, lat, name: f.properties.toponyme || 'parking' }; });
  const liftEnds = lifts.features.filter(f => /Télécabine|Téléphérique|Télésiège|Funiculaire/i.test(f.properties.nature ?? '')).map(f => {
    const c = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
    return { a: { lon: c[0][0], lat: c[0][1] }, b: { lon: c[c.length - 1][0], lat: c[c.length - 1][1] }, name: f.properties.toponyme || f.properties.nature };
  });
  // around a place: the nearest goals first, those not yet in any list, at most `max` this time
  const stored = (() => { try { return JSON.parse(localStorage.getItem(storeKey) || 'null')?.hikes ?? []; } catch { return []; } })();
  if (c) {
    const have0 = new Set(stored.map(h => `${h.kind}/${h.name}`));
    goals.sort((a, b) => metres(c, a) - metres(c, b));
    goals.splice(0, goals.length, ...goals.filter(g => !have0.has(`${g.kind}/${g.name}`) && !known(g)).slice(0, max));
  }
  const [ea, eb, eg] = await Promise.all([altitudes(liftEnds.map(l => l.a)), altitudes(liftEnds.map(l => l.b)), goals.length ? altitudes(goals) : []]);
  liftEnds.forEach((l, i) => { const upB = (eb[i] ?? 0) >= (ea[i] ?? 0), top = upB ? l.b : l.a; starts.push({ ...top, alt: upB ? eb[i] : ea[i], name: `arrivée ${l.name}`, lift: true }); });
  goals.forEach((g, i) => { g.alt = eg[i]; });

  const done = stored, have = new Set(done.map(h => `${h.kind}/${h.name}`)), list = [...done];
  const todo = goals.filter(g => !have.has(`${g.kind}/${g.name}`));
  const total = c ? done.length + todo.length : goals.length; onProgress?.(list, list.length, total);
  for (const g of todo) {
    if (signal?.aborted) break;
    // the nearest start in a straight line; a lift top counts only if it is well below the goal, and a start
    // that leaves less than 800 m of walking gives way to the nearest car park (a hike, not a stroll from a lift)
    const byDist = starts.filter(st => !st.lift || st.alt == null || g.alt == null || st.alt < g.alt - 150).map(st => ({ st, d: metres(st, g) })).sort((a, b) => a.d - b.d);
    let start = byDist[0]?.st;
    if (!start) continue;
    try {
      let r = await walkingRoute(start, g);
      const walked = r.ll.reduce((s, p, i) => i ? s + metres({ lon: r.ll[i - 1][0], lat: r.ll[i - 1][1] }, { lon: p[0], lat: p[1] }) : 0, 0);
      if (walked < 800) { const park = byDist.find(x => !x.st.lift && x.d > 800)?.st; if (!park) continue; start = park; r = await walkingRoute(start, g); }
      // the paths end more than 1 km short of the goal: no approach by path, the route would be a meaningless detour
      if (r.pts.length < 2 || r.offEnd > 1000) continue;
      const m = await measure(r.ll);
      const h = { name: g.name, kind: g.kind, alt: g.alt, start: start.name, startAlt: m.startAlt, dist: m.dist, up: m.up, down: m.down, max: m.max, hours: m.hours, offEnd: r.offEnd, path: m.path };
      h.cls = classify(h); list.push(h);
      try { localStorage.setItem(storeKey, JSON.stringify({ built: Date.now(), hikes: list })); } catch { }
    } catch { /* no path to this goal: left out */ }
    onProgress?.(list, list.length, total);
  }
  return list;
}
