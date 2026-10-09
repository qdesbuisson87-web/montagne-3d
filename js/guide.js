// Guidance at the forks along an itinerary. IGN BD TOPO splits its paths at every junction: where three path
// sections or more meet on the line, there is a choice to make. For each one: which way the line goes (left,
// right, keep left at a fork…) and towards which named place further on. Only paths and tracks are in the data
// loaded (not roads): a junction with a road is not known. During an outing the next instruction is said ahead.

const NEAR = 12, AHEAD = 25; // m: a junction this close to the line is on it; headings measured over this length

// heading of a way leaving node point p along pts (from its first or last point), over ~AHEAD m
function branch(pts, fromStart) {
  const seq = fromStart ? pts : [...pts].reverse(), [x0, z0] = seq[0];
  let q = seq[seq.length - 1];
  for (let i = 1, d = 0; i < seq.length; i++) { d += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]); if (d >= AHEAD) { q = seq[i]; break; } }
  const dx = q[0] - x0, dz = q[1] - z0, l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}
const angle = (a, b) => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI; // > 0: b turns right of a (x east, z south)

// samples: the itinerary (route.js); ways: the paths loaded [{ kind, pts }]; places: named points [{ name, x, z }]
// returns [{ d, x, z, text, turn }] along the line
export function junctions(samples, ways, places) {
  if (samples.length < 3) return [];
  // the nodes of the path network and the ways leaving each
  const nodes = new Map();
  for (const w of ways) {
    if (w.kind === 'lift' || w.pts.length < 2) continue;
    for (const end of [0, 1]) {
      const p = end ? w.pts[w.pts.length - 1] : w.pts[0], k = `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      let n = nodes.get(k); if (!n) nodes.set(k, n = { x: p[0], z: p[1], out: [] });
      n.out.push(branch(w.pts, !end));
    }
  }
  // samples on a grid of 20 m, to find the line near each node
  const G = 20, grid = new Map();
  samples.forEach((s, i) => { if (s.lift) return; const k = `${Math.floor(s.x / G)},${Math.floor(s.z / G)}`; (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
  const nearest = (x, z, max = NEAR) => {
    let best = Infinity, bi = -1; const gx = Math.floor(x / G), gz = Math.floor(z / G), r = Math.ceil(max / G);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) for (const k of grid.get(`${gx + i},${gz + j}`) ?? []) { const d = Math.hypot(samples[k].x - x, samples[k].z - z); if (d < best) { best = d; bi = k; } }
    return best <= max ? bi : -1;
  };
  const end = samples[samples.length - 1].d, out = [];
  const at = d => { let i = 0; while (i < samples.length - 1 && samples[i].d < d) i++; return samples[Math.max(0, Math.min(samples.length - 1, i))]; };
  for (const n of nodes.values()) {
    if (n.out.length < 3) continue;
    const i = nearest(n.x, n.z); if (i < 0) continue;
    const d = samples[i].d; if (d < 20 || d > end - 20) continue;
    const a = at(d - AHEAD), b = at(d + AHEAD + 5), s = samples[i];
    const hin = [s.x - a.x, s.z - a.z], hout = [b.x - s.x, b.z - s.z], li = Math.hypot(...hin), lo = Math.hypot(...hout); if (li < 5 || lo < 5) continue;
    const vin = [hin[0] / li, hin[1] / li], vout = [hout[0] / lo, hout[1] / lo];
    // the branches the line itself uses (back the way it came, and on), the others are the choice
    const others = n.out.filter(o => Math.abs(angle(vout, o)) > 30 && Math.abs(angle([-vin[0], -vin[1]], o)) > 30);
    if (!others.length) continue;
    const turn = angle(vin, vout), side = t => t > 0 ? 'droite' : 'gauche';
    const fork = others.find(o => Math.abs(angle(vout, o)) < 50);
    const text = fork ? `à la fourche, prends le chemin de ${side(angle(fork, vout))}`
      : Math.abs(turn) < 25 ? 'continue tout droit' : Math.abs(turn) < 60 ? `prends légèrement à ${side(turn)}` : Math.abs(turn) < 140 ? `prends à ${side(turn)}` : `prends en épingle à ${side(turn)}`;
    out.push({ d, x: s.x, z: s.z, text, turn });
  }
  out.sort((p, q) => p.d - q.d);
  // a junction counted twice (two nodes a few metres apart): kept once
  const merged = out.filter((j, k) => !k || j.d - out[k - 1].d > 15);
  // towards: the next named place near the line after the junction
  const marks = places.map(p => { const i = nearest(p.x, p.z, 150); return i < 0 ? null : { d: samples[i].d, name: p.name }; }).filter(Boolean).sort((p, q) => p.d - q.d);
  for (const j of merged) j.toward = marks.find(m => m.d > j.d + 50)?.name ?? null;
  return merged;
}

// the instruction said ahead of a junction
export const say = (j, metres) => `Dans ${metres} m, ${j.text}${j.toward ? `, direction ${j.toward}` : ''}.`;
