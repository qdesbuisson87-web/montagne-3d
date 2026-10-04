// The itineraries kept on the device ("Mes itinéraires"), compared side by side; an outing split into days at the
// huts along the way; and when to leave, from the Météo-France forecast at the itinerary's highest point and the
// daylight. Everything is computed from the relief under the line (route.js samples) and official forecasts; the
// walking times are the DIN 33466 ones (average hiker, no breaks), said as such on screen.
import { pathStats } from './route.js?v=202610042126';
import { sunPosition, sunTimes } from './live.js?v=202610042126';

const BOOK = 'midi3d-routes';
export const loadBook = () => { try { return JSON.parse(localStorage.getItem(BOOK) || '[]'); } catch { return []; } };
export const saveBook = list => { try { localStorage.setItem(BOOK, JSON.stringify(list)); return true; } catch { return false; } };

// the numbers kept with an itinerary (computed once, with the relief loaded when it is kept): those of the
// itinerary card, plus the length walked across slopes of 30° and more (where avalanches start)
export function routeFacts(samples, slopeAt) {
  const st = pathStats(samples); if (!st) return null;
  let steep30 = 0;
  for (let i = 1; i < samples.length; i++) { const s = slopeAt(samples[i].x, samples[i].z); if (s && s.deg >= 30) steep30 += samples[i].d - samples[i - 1].d; }
  return { dist: st.dist, up: st.up, down: st.down, max: st.max, min: st.min, steepDeg: st.steepDeg, hours: st.hours, steep30, complete: st.complete };
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
export function walkability(samples, { slopeAt, onGlacier, pathDist }) {
  const out = { total: 0, path: 0, off: 0, unknown: 0, glacier: 0, steep: 0, rock: 0, rockMax: 0, stretches: [] };
  let cur = null;
  const push = (d0, d1, kind) => { if (cur && cur.kind === kind && d0 - cur.d1 < 15) cur.d1 = d1; else { if (cur) out.stretches.push(cur); cur = { d0, d1, kind }; } };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], len = b.d - a.d, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    out.total += len;
    const s = slopeAt(mx, mz), deg = s?.deg ?? 0, ice = onGlacier(mx, mz), pd = pathDist(mx, mz);
    const onPath = pd != null && pd <= 40;
    if (pd == null) out.unknown += len; else if (onPath) out.path += len; else out.off += len;
    if (ice) out.glacier += len;
    // steepness counts off the paths only: a path cut into a steep slope is a path (its own grade is measured apart)
    if (!onPath && deg >= 45) { out.rock += len; out.rockMax = Math.max(out.rockMax, deg); }
    else if (!onPath && deg >= 35) out.steep += len;
    const kind = !onPath && deg >= 45 ? 'rock' : ice ? 'glacier' : !onPath && deg >= 35 ? 'steep' : pd != null && !onPath ? 'off' : null;
    if (kind) push(a.d, b.d, kind);
  }
  if (cur) out.stretches.push(cur);
  // the verdict, the worst first
  out.level = out.rock > 30 ? 'rock' : out.glacier > 50 ? 'glacier' : out.steep > 50 ? 'steep' : out.off > 200 ? 'off' : out.unknown > out.total * 0.3 ? 'unknown' : 'path';
  return out;
}
