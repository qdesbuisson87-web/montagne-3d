// The itineraries kept on the device ("Mes itinéraires"), compared side by side; an outing split into days at the
// huts along the way; and when to leave, from the Météo-France forecast at the itinerary's highest point and the
// daylight. Everything is computed from the relief under the line (route.js samples) and official forecasts; the
// walking times are the DIN 33466 ones (average hiker, no breaks), said as such on screen.
import { pathStats } from './route.js?v=202610101210';
import { sunPosition, sunTimes } from './live.js?v=202610101210';

const BOOK = 'midi3d-routes';
export const loadBook = () => { try { return JSON.parse(localStorage.getItem(BOOK) || '[]'); } catch { return []; } };
export const saveBook = list => { try { localStorage.setItem(BOOK, JSON.stringify(list)); return true; } catch { return false; } };

// the numbers kept with an itinerary (computed once, with the relief loaded when it is kept): those of the
// itinerary card, plus the length walked across slopes of 30° and more (where avalanches start)
export function routeFacts(samples, slopeAt) {
  const st = pathStats(samples); if (!st) return null;
  let steep30 = 0;
  for (let i = 1; i < samples.length; i++) { if (samples[i - 1].lift) continue; const s = slopeAt(samples[i].x, samples[i].z); if (s && s.deg >= 30) steep30 += samples[i].d - samples[i - 1].d; }
  return { dist: st.dist, up: st.up, down: st.down, max: st.max, min: st.min, steepDeg: st.steepDeg, hours: st.hours, steep30, ride: st.ride, complete: st.complete };
}

// huts and shelters within 250 m of the line, where an outing can stop for the night: [{ d (m along), name, alt }]
export function nightSpots(samples, places) {
  const out = [];
  for (const p of places) {
    if (!p.hut || p.fall || (p.rinfo && !['refuge', 'gîte', 'cabane'].includes(p.rinfo.kind))) continue;
    let best = Infinity, d = 0;
    for (let i = 0; i < samples.length; i += 2) { const s = samples[i], e = Math.hypot(s.x - p.x, s.z - p.z); if (e < best) { best = e; d = s.d; } }
    if (best < 250 && d > 300 && d < samples[samples.length - 1].d - 300) out.push({ d, name: p.name, alt: p.alt ?? null });
  }
  return out.sort((a, b) => a.d - b.d).filter((s, i, a) => !i || s.d - a[i - 1].d > 200);
}

// the numbers of each day, the nights being distances along the line
export function stages(samples, nights) {
  const cuts = [0, ...nights.filter(d => d > 0 && d < samples[samples.length - 1].d).sort((a, b) => a - b), Infinity];
  const out = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const part = samples.filter(s => s.d >= cuts[k] - 1e-6 && s.d <= cuts[k + 1] + 1e-6).map(s => ({ ...s, d: s.d - cuts[k] }));
    const st = pathStats(part); if (st) out.push(st);
  }
  return out;
}

// sunrise on a day at a place (upper limb at the horizon), stepping through the morning like sunTimes does
export function sunrise(date, lat, lon) {
  const day = new Date(date); day.setHours(2, 0, 0, 0);
  const el = t => sunPosition(new Date(t), lat, lon).el * 180 / Math.PI + 0.833;
  let a = +day; for (let i = 0; i < 48 && el(a) < 0; i++) a += 15 * 60e3;
  if (el(a) < 0) return null;
  let b = a - 15 * 60e3; while (a - b > 60e3) { const m = (a + b) / 2; if (el(m) >= 0) a = m; else b = m; }
  return new Date(a);
}

// When to leave, for today and tomorrow: reach the highest point an hour before the first bad hour of the forecast
// there (fog, rain, snow, storm: weather codes 45 and above) and be back before sunset (half an hour of margin);
// never before sunrise. hourly: Open-Meteo/Météo-France forecast at the highest point (pointForecast).
export function whenToLeave(samples, hourly, lat, lon, now = new Date()) {
  const st = pathStats(samples); if (!st) return null;
  const hi = samples.reduce((b, s) => (s.h != null && s.h > (b?.h ?? -Infinity) ? s : b), null);
  const upTo = pathStats(samples.filter(s => s.d <= hi.d)), toTop = upTo ? upTo.hours : 0, total = st.hours;
  const days = [];
  for (const k of [0, 1]) {
    const day = new Date(now); day.setDate(day.getDate() + k); day.setHours(12, 0, 0, 0);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const rise = sunrise(day, lat, lon), set = sunTimes(day, lat, lon).sunset;
    // the first bad hour of that day, from 6 h on, and what it is
    let bad = null;
    hourly.time.forEach((t, i) => { if (!bad && t.startsWith(iso) && +t.slice(11, 13) >= 6 && hourly.weather_code[i] >= 45) bad = { at: new Date(t), code: hourly.weather_code[i] }; });
    const earliest = k === 0 ? new Date(Math.max(+rise, +now)) : rise;
    let latest = set ? new Date(+set - (total + 0.5) * 3600e3) : null, reason = 'sun';
    if (bad) { const w = new Date(+bad.at - (toTop + 1) * 3600e3); if (!latest || w < latest) { latest = w; reason = 'weather'; } }
    days.push({ day, rise, set, bad, earliest, latest, reason, ok: !!(earliest && latest && latest >= earliest) });
  }
  return { toTop, total, hiAlt: hi.h, days };
}

// ----- Can it be walked? -----
// Along the line (samples every 10 m): is each stretch on a footpath or track (IGN BD TOPO, within 40 m: the
// line drawn and the map's path differ by a few metres), on a glacier (BD TOPO outlines), and how steep is the
// ground it crosses (LiDAR relief): 35° and more is very steep ground (a slip does not stop), 45° and more is rock
// where the hands are needed (climbing). Nothing is guessed: a stretch whose paths are not loaded yet is "unknown".
// returns lengths (m) and the stretches to show on the map: [{ d0, d1, kind }] with kind rock | steep | glacier | off
// stations: lift stations (scene metres): the IGN network climbs their stairs, galleries and footbridges (the
// Aiguille du Midi's, up the rock): within STATION m of one, a stretch on the network is not counted as climbing
const STATION = 120;
export function walkability(samples, { slopeAt, onGlacier, pathDist, stations = [] }) {
  const out = { total: 0, path: 0, off: 0, unknown: 0, glacier: 0, steep: 0, rock: 0, rockMax: 0, lift: 0, stretches: [] };
  let cur = null;
  const push = (d0, d1, kind) => { if (cur && cur.kind === kind && d0 - cur.d1 < 15) cur.d1 = d1; else { if (cur) out.stretches.push(cur); cur = { d0, d1, kind }; } };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], len = b.d - a.d, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    if (a.lift) { out.lift += len; continue; } // a ride: nothing to walk
    out.total += len;
    const s = slopeAt(mx, mz), deg = s?.deg ?? 0, ice = onGlacier(mx, mz), pd = a.net && b.net ? 0 : pathDist(mx, mz);
    const onPath = pd != null && pd <= 40;
    // the line's own grade over ~30 m: a "path" that climbs a face at 60 % and more is a climbing line (the IGN
    // network holds some, the Aiguille du Midi's north face for one)
    const j0 = Math.max(0, i - 2), j1 = Math.min(samples.length - 1, i + 1), A = samples[j0], Bq = samples[j1];
    const grade = A.h != null && Bq.h != null && Bq.d > A.d && !samples.slice(j0, j1).some(q => q.lift) ? Math.abs(Bq.h - A.h) / (Bq.d - A.d) : 0;
    const built = a.net && b.net && stations.some(s => Math.hypot(s[0] - mx, s[1] - mz) < STATION);
    const climbing = deg >= 45 && !built && (!onPath || grade >= 0.6);
    if (pd == null) out.unknown += len; else if (onPath) out.path += len; else out.off += len;
    if (ice) out.glacier += len;
    // steepness counts off the paths only: a path cut into a steep slope is a path (its own grade is measured apart)
    if (climbing) { out.rock += len; out.rockMax = Math.max(out.rockMax, deg); }
    else if (!onPath && deg >= 35) out.steep += len;
    const kind = climbing ? 'rock' : ice ? 'glacier' : !onPath && deg >= 35 ? 'steep' : pd != null && !onPath ? 'off' : null;
    if (kind) push(a.d, b.d, kind);
  }
  if (cur) out.stretches.push(cur);
  // the verdict, the worst first
  out.level = out.rock > 30 ? 'rock' : out.glacier > 50 ? 'glacier' : out.steep > 50 ? 'steep' : out.off > 200 ? 'off' : out.unknown > out.total * 0.3 ? 'unknown' : 'path';
  return out;
}

// ----- Under avalanche slopes? -----
// A point of the line is exposed when a slope of 30 to 60° (where slab avalanches start) lies above it within 1 km,
// faces it (within 60°), and an avalanche starting there would run that far by the Norwegian alpha-beta model
// (Lied & Bakkehøi): on the straight profile from the slope down to the point, β = angle seen from the top to where
// the ground eases below 10°, runout angle α = 0.96 β − 1.4°, taken one standard deviation further (−2.3°, on the
// cautious side). The point is reached when it is seen from the top at α or steeper. Relief alone, on a 20 m grid
// of the loaded relief: forest (which often holds the snow) is not counted. It says where snow could come down onto
// the line, not whether it will: that is the avalanche bulletin's and the day's snow.
// Async, in slices of ~25 ms. returns { exposed (m walked), unknown (m), stretches: [{ d0, d1, kind: 'under' }] }
export async function exposure(samples, heightAt, { R = 1000, G = 20, alpha = 18, alive = () => true } = {}) {
  const walk = samples.filter((s, i) => i % 2 === 0 && !s.lift && s.h != null);
  if (walk.length < 2) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of walk) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
  x0 -= R + G; z0 -= R + G; const nx = Math.ceil((x1 + R + G - x0) / G) + 1, nz = Math.ceil((z1 + R + G - z0) / G) + 1;
  const H = new Float32Array(nx * nz).fill(NaN), NONE = -1e9; // NaN: not asked yet; NONE: no relief loaded there
  const hAt = (i, j) => { const k = j * nx + i; let v = H[k]; if (v !== v) v = H[k] = heightAt(x0 + i * G, z0 + j * G) ?? NONE; return v; };
  const tanA = Math.tan(alpha * Math.PI / 180), tan30 = Math.tan(Math.PI / 6), tan60 = Math.tan(Math.PI / 3), cos60 = 0.5, r = Math.ceil(R / G);
  // alpha-beta along the straight profile from the slope (i, j, height h) to the point: down to the β point (the
  // ground eases below 10° over two steps), then α from β; the point lying before the β point is reached anyway
  const tan10 = Math.tan(Math.PI / 18), deg = Math.PI / 180;
  const reaches = (i, j, h, dx, dz, dist, hp) => {
    const n = Math.floor(dist / G);
    let prev = h, eased = 0;
    for (let k = 1; k <= n; k++) {
      const fi = i + dx / dist * k, fj = j + dz / dist * k, q = hAt(Math.round(fi), Math.round(fj)); if (q === NONE) return true; // cautious
      eased = (prev - q) / G < tan10 ? eased + 1 : 0; prev = q;
      if (eased >= 2) {
        const sb = (k - 1) * G, beta = Math.atan((h - q) / sb) / deg, a = 0.96 * beta - 1.4 - 2.3;
        return Math.atan((h - hp) / dist) / deg >= a;
      }
    }
    return true; // still steep all the way down to the point
  };
  const flags = new Int8Array(walk.length); // 1 exposed, 0 not, -1 unknown
  let t = performance.now();
  for (let w = 0; w < walk.length; w++) {
    const P = walk[w], pi = Math.round((P.x - x0) / G), pj = Math.round((P.z - z0) / G);
    let res = 0, holes = 0;
    for (let j = Math.max(1, pj - r); j <= Math.min(nz - 2, pj + r) && res !== 1; j++) for (let i = Math.max(1, pi - r); i <= Math.min(nx - 2, pi + r); i++) {
      const dx = P.x - (x0 + i * G), dz = P.z - (z0 + j * G), dist = Math.hypot(dx, dz); if (dist > R) continue;
      const h = hAt(i, j); if (h === NONE) { holes++; continue; }
      if (h - P.h < tanA * Math.max(dist, G)) continue; // not high enough above the point
      const e = hAt(i + 1, j), o = hAt(i - 1, j), s = hAt(i, j + 1), n = hAt(i, j - 1); if (e === NONE || o === NONE || s === NONE || n === NONE) { holes++; continue; }
      const gx = (e - o) / (2 * G), gz = (s - n) / (2 * G), g = Math.hypot(gx, gz);
      if (g < tan30 || g > tan60) continue;
      // downhill (−gradient) pointing at the point, within 60° (right under it: counted)
      if (dist > G && (-gx * dx - gz * dz) / (g * dist) < cos60) continue;
      if (dist > 2 * G && !reaches(i, j, h, dx, dz, dist, P.h)) continue;
      res = 1; break;
    }
    flags[w] = res === 1 ? 1 : holes > 20 ? -1 : 0;
    if (performance.now() - t > 25) { await new Promise(ok => setTimeout(ok, 0)); if (!alive()) return null; t = performance.now(); }
  }
  const out = { exposed: 0, unknown: 0, stretches: [] };
  for (let w = 1; w < walk.length; w++) {
    const a = walk[w - 1], b = walk[w], len = b.d - a.d; if (len > 60) continue; // a ride or a gap in between
    if (flags[w] === 1 || flags[w - 1] === 1) {
      out.exposed += len;
      const last = out.stretches[out.stretches.length - 1];
      if (last && a.d - last.d1 < 25) last.d1 = b.d; else out.stretches.push({ d0: a.d, d1: b.d, kind: 'under' });
    } else if (flags[w] === -1) out.unknown += len;
  }
  return out;
}

// ----- On skis (ski touring) -----
// Up: "effort kilometres" (1 km on the flat or 100 m of climb), 4 an hour, the rule the Swiss Alpine Club uses for
// ascents. Down: 1 000 m of descent an hour, a common estimate that varies a lot with the snow and the skier (or
// 15 km/h on long gentle runs). Where the line goes down, the ground's slope (LiDAR relief) is measured: length
// at 30–35°, 35–40°, 40–45°, 45° and more, and those stretches for the map (kind s30 … s45). Rides not counted.
export const SKI_BINS = [30, 35, 40, 45];
export function skiStats(samples, slopeAt) {
  const s = samples.filter(p => p.h != null); if (s.length < 2) return null;
  let up = 0, down = 0, ref = s[0].h, distUp = 0, distDown = 0, cur = null;
  const bins = [0, 0, 0, 0], stretches = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i], len = b.d - a.d;
    if (a.lift) { ref = b.h; continue; }
    if (b.h - ref >= 3) { up += b.h - ref; ref = b.h; } else if (ref - b.h >= 3) { down += ref - b.h; ref = b.h; }
    // going down here: the trend over ~40 m around
    const p = s[Math.max(0, i - 2)], q = s[Math.min(s.length - 1, i + 2)];
    if (q.h - p.h < -2) {
      distDown += len;
      const deg = slopeAt((a.x + b.x) / 2, (a.z + b.z) / 2)?.deg ?? 0;
      let k = -1; for (let j = SKI_BINS.length - 1; j >= 0; j--) if (deg >= SKI_BINS[j]) { k = j; break; }
      if (k >= 0) {
        bins[k] += len; const kind = `s${SKI_BINS[k]}`;
        if (cur && cur.kind === kind && a.d - cur.d1 < 15) cur.d1 = b.d; else { if (cur) stretches.push(cur); cur = { d0: a.d, d1: b.d, kind }; }
      }
    } else distUp += len;
  }
  if (cur) stretches.push(cur);
  const upHours = (distUp / 1000 + up / 100) / 4, downHours = Math.max(down / 1000, distDown / 15000);
  return { up, down, dist: distUp + distDown, upHours, downHours, hours: upHours + downHours, bins, stretches };
}
