// Recording the outing: the GPS positions (tracker in gps.js) kept along the way, drawn on the relief in blue,
// with distance, climb (relief altitudes, as for itineraries), time and speed, saved on the device as they come
// (a closed app resumes the recording) and exportable as GPX with the times.
// A web app is stopped when the screen locks (iOS, Android): while recording, the screen is kept on
// (Screen Wake Lock API) and the app says so.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { lonLatToWorld } from './geo.js?v=202610041920';

const STORE = 'midi3d-track', MIN_STEP = 6, MAX_ACC = 35; // metres

export class TrackRecorder {
  constructor({ scene, groundAt }) {
    this.groundAt = groundAt; this.pts = []; this.recording = false; this.wake = null; this.dirty = true;
    this.mat = new LineMaterial({ color: 0x1e88ff, linewidth: 4, transparent: true });
    this.under = new LineMaterial({ color: 0x08203a, linewidth: 7, transparent: true, opacity: 0.6 });
    // the parts hidden behind the relief: dashes drawn over it, so the line is never cut
    this.hidden = new LineMaterial({ color: 0x1e88ff, linewidth: 3, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, dashed: true, dashSize: 14, gapSize: 10 });
    this.group = new THREE.Group(); scene.add(this.group); this.lines = [];
    // positions in the scene's metres are recomputed from longitude/latitude: they depend on the massif open
    try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s?.pts) { this.pts = s.pts.map(p => { const [x, z] = lonLatToWorld(p.lon, p.lat); return { ...p, x, z }; }); this.recording = !!s.recording; this.started = s.started; } } catch { }
    // the screen lock released by the system (app hidden) is asked for again when the app comes back
    document.addEventListener('visibilitychange', () => { if (this.recording && document.visibilityState === 'visible') this.keepAwake(); });
  }
  setResolution(w, h) { for (const m of [this.mat, this.under, this.hidden]) m.resolution.set(w, h); }
  save() { try { localStorage.setItem(STORE, JSON.stringify({ pts: this.pts, recording: this.recording, started: this.started })); } catch { } }
  async keepAwake() { try { this.wake = await navigator.wakeLock?.request('screen'); } catch { this.wake = null; } }
  start() {
    if (!this.recording) { this.recording = true; if (!this.pts.length) this.started = Date.now(); }
    this.keepAwake(); this.save();
  }
  stop() { this.recording = false; this.wake?.release().catch(() => { }); this.wake = null; this.save(); }
  clear() { this.stop(); this.pts = []; this.started = null; this.dirty = true; this.save(); }
  // a new GPS fix: kept if accurate enough and far enough from the last kept one
  addFix(p) {
    if (!this.recording || !p || p.acc > MAX_ACC) return false;
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < Math.max(MIN_STEP, p.acc * 0.3)) return false;
    this.pts.push({ x: p.x, z: p.z, lon: p.lon, lat: p.lat, t: +p.time, g: p.gpsAlt ?? null });
    this.dirty = true; this.save(); return true;
  }
  // distance, climb on the relief (steps of at least 3 m), time since start, speed over the last 10 minutes
  stats() {
    const P = this.pts; if (!P.length) return null;
    let dist = 0, up = 0, down = 0, ref = null;
    P.forEach((p, i) => {
      if (i) dist += Math.hypot(p.x - P[i - 1].x, p.z - P[i - 1].z);
      const h = this.groundAt(p.x, p.z) ?? p.g; if (h == null) return;
      if (ref == null) ref = h; else if (h - ref >= 3) { up += h - ref; ref = h; } else if (ref - h >= 3) { down += ref - h; ref = h; }
    });
    const t0 = this.started ?? P[0].t, t1 = this.recording ? Date.now() : P[P.length - 1].t, recent = P.filter(p => t1 - p.t < 600e3);
    let rd = 0; for (let i = 1; i < recent.length; i++) rd += Math.hypot(recent[i].x - recent[i - 1].x, recent[i].z - recent[i - 1].z);
    const span = recent.length > 1 ? (recent[recent.length - 1].t - recent[0].t) / 3600e3 : 0;
    return { dist, up, down, hours: (t1 - t0) / 3600e3, speed: span > 0.02 ? rd / 1000 / span : null, count: P.length };
  }
  toGPX(name = 'Ma sortie') {
    const esc = s => s.replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
    const trk = this.pts.map(p => { const h = this.groundAt(p.x, p.z) ?? p.g; return `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${h != null ? `<ele>${h.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`; }).join('\n      ');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Montagne 3D" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${esc(name)}</name><trkseg>\n      ${trk}\n  </trkseg></trk>\n</gpx>\n`;
  }
  // the blue line on the relief, laid again when points arrive or finer relief has loaded
  update(frameN, exag) {
    if (!this.dirty && exag === this.exag && frameN % 240 !== 0) return;
    this.dirty = false; this.exag = exag;
    this.lines.forEach(l => { this.group.remove(l); l.geometry.dispose(); }); this.lines = [];
    if (this.pts.length < 2) return;
    let last = 0; const pos = [];
    for (const p of this.pts) { const h = this.groundAt(p.x, p.z) ?? p.g ?? last; last = h; pos.push(p.x, h * exag + 3, p.z); }
    for (const m of [this.hidden, this.under, this.mat]) { const g = new LineGeometry(); g.setPositions(pos); const l = new Line2(g, m); l.computeLineDistances(); l.renderOrder = m === this.mat ? 7 : 6; this.group.add(l); this.lines.push(l); }
  }
}

// Where one stands along a planned itinerary (route.js samples): distance off the line, and what remains
export function progressOn(samples, x, z) {
  if (!samples?.length) return null;
  let best = Infinity, bi = 0;
  for (let i = 0; i < samples.length; i++) { const d = Math.hypot(samples[i].x - x, samples[i].z - z); if (d < best) { best = d; bi = i; } }
  // climb and DIN 33466 time of a stretch of the samples
  const part = (i0, i1) => {
    let up = 0, down = 0, ref = samples[i0].h;
    for (let i = i0 + 1; i <= i1; i++) { const h = samples[i].h; if (h == null || ref == null) { ref = h ?? ref; continue; } if (h - ref >= 3) { up += h - ref; ref = h; } else if (ref - h >= 3) { down += ref - h; ref = h; } }
    const th = (samples[i1].d - samples[i0].d) / 4000, tv = up / 300 + down / 500;
    return { up, down, hours: Math.max(th, tv) + Math.min(th, tv) / 2 };
  };
  const ahead = part(bi, samples.length - 1), behind = part(0, bi), total = samples[samples.length - 1].d;
  return { off: best, done: samples[bi].d, left: total - samples[bi].d, up: ahead.up, down: ahead.down, hours: ahead.hours, doneHours: behind.hours, total };
}
