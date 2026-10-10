// Loops, rather than there-and-back walks, by the IGN paths only:
//  - round a lake: its real outline (IGN BD TOPO plan_d_eau), points on the shore all round, joined by the IGN
//    route service from the car park nearest the water. Kept only if the paths really go round (close to the
//    shore, without long detours): otherwise it says so;
//  - to a summit, a pass or a hut: up by the hike's path, down by another one, passing by another named place
//    nearby (a pass, a summit, a hut, a lake within 3 km); kept only if the way down shares less than 40 % of the
//    way up. Nothing is drawn where there is no path.
// Worked out when a hike is chosen (a few requests), kept on the device.
import { walkingRoute } from './planner.js?v=202610101153';
import { WFS, json, measure } from './hikes.js?v=202610101153';

const STORE = 'midi3d-loops-v1';
const metres = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371000; };
const P = ([lon, lat]) => ({ lon, lat });
const box = (c, m) => { const dLat = m / 111000, dLon = m / (111000 * Math.cos(c.lat * Math.PI / 180)); return `BBOX(geometrie,${c.lon - dLon},${c.lat - dLat},${c.lon + dLon},${c.lat + dLat},'EPSG:4326')`; };
const quote = s => `'${String(s).replace(/'/g, "''")}'`;
const lengthOf = ll => ll.reduce((s, p, i) => i ? s + metres(P(ll[i - 1]), P(p)) : 0, 0);
// share of a line's length (points every ~20 m) lying within d m of another line
function shared(ll, other, d = 30) {
  const pts = []; for (let i = 1; i < ll.length; i++) { const a = P(ll[i - 1]), b = P(ll[i]), n = Math.max(1, Math.ceil(metres(a, b) / 20)); for (let k = 0; k < n; k++) pts.push({ lon: a.lon + (b.lon - a.lon) * k / n, lat: a.lat + (b.lat - a.lat) * k / n }); }
  const near = q => other.some((p, i) => i && segDist(q, P(other[i - 1]), P(p)) < d);
  return pts.length ? pts.filter(near).length / pts.length : 0;
}
function segDist(q, a, b) { // metres from q to segment ab (local flat approximation)
  const k = 111000 * Math.cos(q.lat * Math.PI / 180), ax = (a.lon - q.lon) * k, ay = (a.lat - q.lat) * 111000, bx = (b.lon - q.lon) * k, by = (b.lat - q.lat) * 111000;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
const keyOf = h => `${h.kind}/${h.name}/${h.path[0].join(',')}`;

// h: a hike (hikes.js). Returns { loop: { path, dist, up, down, max, hours, how, start } | null, why }
export async function makeLoop(h) {
  const all = load(), k = keyOf(h); if (all[k]) return all[k];
  const res = h.kind === 'lac' ? await lakeTour(h) : await otherWayDown(h);
  if (res.loop || res.final) { all[k] = res; try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { } }
  return res;
}

async function lakeTour(h) {
  const end = P(h.path[h.path.length - 1]);
  const lakes = await json(WFS('BDTOPO_V3:plan_d_eau', `toponyme=${quote(h.name)} AND ${box(end, 3000)}`));
  const polys = lakes.features.flatMap(f => f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : []);
  if (!polys.length) return { loop: null, why: 'contour du lac introuvable', final: true };
  const ring = polys.map(p => p[0]).sort((a, b) => lengthOf(b) - lengthOf(a))[0], per = lengthOf(ring);
  if (per > 25000) return { loop: null, why: `lac trop grand pour en faire le tour à pied (${Math.round(per / 1000)} km de rive)`, final: true };
  const c = { lon: ring.reduce((s, p) => s + p[0], 0) / ring.length, lat: ring.reduce((s, p) => s + p[1], 0) / ring.length };
  // the car park nearest the water (the hike's own start if none is nearer)
  const parks = (await json(WFS('BDTOPO_V3:equipement_de_transport', `nature='Parking' AND ${box(c, Math.max(1500, per / 3))}`))).features
    .map(f => { const g = f.geometry, q = g.type === 'Point' ? g.coordinates : (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0])[0]; return P(q); });
  const shoreDist = q => Math.min(...ring.map(p => metres(q, P(p))));
  const start = [P(h.path[0]), ...parks].map(q => ({ q, d: shoreDist(q) })).sort((a, b) => a.d - b.d)[0].q;
  // points all round the shore, pushed 25 m out onto the land, from the one nearest the start
  const n = Math.max(4, Math.min(10, Math.round(per / 450))), pts = [];
  let acc = 0, next = 0;
  for (let i = 1; i < ring.length && pts.length < n; i++) {
    const a = P(ring[i - 1]), b = P(ring[i]), L = metres(a, b);
    while (acc + L >= next && pts.length < n) {
      const t = (next - acc) / L, q = { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t }, d = metres(c, q) || 1;
      pts.push({ lon: q.lon + (q.lon - c.lon) * 25 / d, lat: q.lat + (q.lat - c.lat) * 25 / d }); next += per / n;
    }
    acc += L;
  }
  const i0 = pts.map((q, i) => [metres(q, start), i]).sort((a, b) => a[0] - b[0])[0][1], vias = [...pts.slice(i0), ...pts.slice(0, i0)];
  let r; try { r = await walkingRoute(start, start, vias); } catch { return { loop: null, why: 'pas de chemin trouvé autour du lac' }; }
  const len = lengthOf(r.ll), nearShore = r.ll.filter(p => shoreDist(P(p)) < 200).length / r.ll.length;
  if (len > per * 2.6 + 1500 || nearShore < 0.55) return { loop: null, why: 'les chemins ne font pas le tour du lac au bord de l\'eau', final: true };
  return { loop: { ...(await measure(r.ll)), how: `tour du lac (${Math.round(nearShore * 100)} % du chemin à moins de 200 m de l'eau)`, start: 'parking le plus proche du lac' } };
}

async function otherWayDown(h) {
  const up = h.path, top = P(up[up.length - 1]), start = P(up[0]);
  // other named places near the goal, for a way down by another path
  const near = await json(WFS('BDTOPO_V3:detail_orographique', `nature IN ('Sommet','Pic','Col') AND toponyme IS NOT NULL AND ${box(top, 3000)}`)).catch(() => ({ features: [] }));
  const cands = near.features.map(f => ({ name: f.properties.toponyme, ...P(f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0]) }))
    .filter(v => v.name !== h.name && metres(v, top) > 400 && metres(v, top) < 3000 && metres(v, start) > 300)
    .sort((a, b) => metres(a, top) - metres(b, top)).slice(0, 4);
  let best = null;
  for (const v of cands) {
    try {
      const r = await walkingRoute(top, start, [v]); if (r.offStart > 150 || r.offEnd > 150) continue;
      const share = shared(r.ll, up), ratio = lengthOf(r.ll) / Math.max(1, lengthOf(up));
      if (share < 0.4 && ratio < 2.5 && (!best || share * 2 + ratio < best.score)) best = { r, v, share, score: share * 2 + ratio };
    } catch { }
  }
  if (!best) return { loop: null, why: 'pas d\'autre chemin pour redescendre', final: cands.length > 0 };
  const ll = [...up, ...best.r.ll.slice(1)];
  return { loop: { ...(await measure(ll)), how: `montée par ${h.start === 'parking' ? 'le chemin le plus court' : h.start}, descente par ${best.v.name} (${Math.round(best.share * 100)} % de chemin commun)`, start: h.start } };
}
