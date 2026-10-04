// Getting there with a lift: when walking all the way is long or impossible (the Aiguille du Midi from Chamonix is
// a climb), the lifts of IGN BD TOPO (transport_par_cable) are tried: walk to a bottom station, ride, walk from the
// top station, by the IGN route service. Only what the data says: the lift's line and stations, never its timetable
// or whether it runs today (said on screen), and no time is counted for the ride.
import { walkingRoute } from './planner.js?v=202610042100';
import { ON, LIFT, pathStats, resamplePath } from './route.js?v=202610042100';
import { cachedFetch } from './net.js?v=202610042100';

// lifts a walker can take: cable cars and gondolas, chairlifts (often shut in summer), and "other" lifts (rack
// railways, funiculars…); not drag lifts (skis only) nor goods cables
const RIDES = { 'Télécabine, téléphérique': 'cable', 'Télésiège': 'chair', 'Autre remontée mécanique': 'other' };
const KIND_NAME = { cable: 'la télécabine', chair: 'le télésiège', other: 'la remontée' }; // for lifts without a name
const LINK = 150; // m: the top of a lift that near the bottom of another is the same station (a ride in sections)

// the lifts of trails.lifts() → rides oriented bottom → top, with their stations' altitudes
export function rides(lifts, groundAt) {
  const out = [];
  for (const l of lifts) {
    const kind = RIDES[l.nature]; if (!kind) continue;
    const za = l.zs?.[0] ?? groundAt(...l.a), zb = l.zs?.[l.zs.length - 1] ?? groundAt(...l.b);
    if (za == null || zb == null || Math.abs(zb - za) < 50) continue; // nothing gained climbing
    const up = zb > za;
    out.push({ name: l.name, kind, pts: up ? l.pts : [...l.pts].reverse(), bottom: up ? l.a : l.b, top: up ? l.b : l.a, zBottom: Math.min(za, zb), zTop: Math.max(za, zb) });
  }
  return out;
}
// every ride made of 1 to 3 lifts in a row (top of one at the bottom of the next), sections included on their own
export function chains(list) {
  const out = [], near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < LINK;
  const grow = c => { out.push(c); if (c.length < 3) for (const r of list) if (!c.includes(r) && near(c[c.length - 1].top, r.bottom)) grow([...c, r]); };
  for (const r of list) grow([r]);
  return out;
}
// altitudes of points { lon, lat } (IGN altimetry service, RGE ALTI): null where it has none
export async function altitudes(pts) {
  const r = await cachedFetch(`https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${pts.map(p => p.lon.toFixed(6)).join('|')}&lat=${pts.map(p => p.lat.toFixed(6)).join('|')}&resource=ign_rge_alti_wld&zonly=true`);
  if (!r.ok) throw new Error(`service ${r.status}`);
  return (await r.json()).elevations.map(v => v > -1000 ? v : null);
}
// rough walking hours of a straight leg (DIN 33466 on 1.3 × the distance), to choose which rides to work out
const roughHours = (a, b, za, zb) => {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]) * 1.3, th = dist / 4000, tv = Math.max(0, zb - za) / 300 + Math.max(0, za - zb) / 500;
  return Math.max(th, tv) + Math.min(th, tv) / 2;
};

// The best ways with lifts from a to b (scene metres, with their altitudes): at most `max` of them, each one
// { name, lifts, pts, net, stats }. ll: scene metres → { lon, lat }. directHours: walking hours of the way on foot
// (Infinity when there is none), the rides that do not save at least a quarter of it are left out.
export async function liftPlans({ a, b, za, zb, lifts, groundAt, ll, directHours, max = 2 }) {
  const cands = chains(rides(lifts, groundAt)).map(c => {
    const bottom = c[0].bottom, top = c[c.length - 1].top, zBottom = c[0].zBottom, zTop = c[c.length - 1].zTop;
    return { c, bottom, top, cost: roughHours(a, bottom, za, zBottom) + roughHours(top, b, zTop, zb) };
  }).filter(o => o.cost < Math.min(directHours, roughHours(a, b, za, zb)) * 0.75).sort((p, q) => p.cost - q.cost);
  const out = [], names = new Set();
  for (const o of cands) {
    if (out.length >= max) break;
    const name = o.c.map(r => r.name ?? KIND_NAME[r.kind]).join(' puis '); if (names.has(name)) continue;
    try {
      const leg = async (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 80 ? null : walkingRoute(ll(p), ll(q));
      const [l1, l2] = await Promise.all([leg(a, o.bottom), leg(o.top, b)]);
      const pts = [], net = [];
      if (l1) { pts.push(...l1.pts); net.push(...l1.pts.map(() => ON)); }
      for (const r of o.c) for (const p of r.pts) { pts.push(p); net.push(LIFT); }
      if (l2) { pts.push(...l2.pts); net.push(...l2.pts.map(() => ON)); }
      const stats = pathStats(resamplePath(pts, groundAt, net));
      names.add(name);
      out.push({ name, lifts: o.c, pts, net, stats, offEnd: l2?.offEnd ?? 0, offStart: l1?.offStart ?? 0 });
    } catch { /* no path to or from that station: not a way */ }
  }
  return out;
}
