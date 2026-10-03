// An itinerary: imported from a GPX file or drawn with the finger, laid on the relief, with its numbers
// (distance, climb, descent, highest point, steepest stretch, walking time) and its altitude profile.
// Altitudes come from the relief under the path (IGN LiDAR), not from the file: GPS altitudes are noisy.
// Walking time: standard DIN 33466 (average hiker, no breaks): 4 km/h on the flat, 300 m/h up, 500 m/h down,
// the longer of the horizontal and vertical times plus half the shorter one.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610031135';

const STEP = 10, STORE = 'midi3d-route'; // metres between resampled points

// points every STEP metres along a path [[x, z], …], with the relief's altitude (null where nothing is loaded)
export function resamplePath(pts, groundAt) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 0; k < n; k++) out.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n });
  }
  if (pts.length) { const [x, z] = pts[pts.length - 1]; out.push({ x, z }); }
  let d = 0; out.forEach((p, i) => { if (i) d += Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z); p.d = d; p.h = groundAt(p.x, p.z); });
  return out;
}
// the numbers of a resampled path (see the header for the rules)
export function pathStats(samples) {
  const s = samples.filter(p => p.h != null); if (s.length < 2) return null;
  let up = 0, down = 0, ref = s[0].h, min = Infinity, max = -Infinity, steep = 0;
  for (const p of s) {
    min = Math.min(min, p.h); max = Math.max(max, p.h);
    // climb counted in steps of at least 3 m, so that the relief's roughness does not add up
    if (p.h - ref >= 3) { up += p.h - ref; ref = p.h; } else if (ref - p.h >= 3) { down += ref - p.h; ref = p.h; }
  }
  for (let i = 0, j = 0; i < s.length; i++) { while (j < s.length && s[j].d - s[i].d < 30) j++; if (j < s.length) steep = Math.max(steep, Math.abs(s[j].h - s[i].h) / (s[j].d - s[i].d)); }
  const dist = s[s.length - 1].d, th = dist / 4000, tv = up / 300 + down / 500;
  return { dist, up, down, min, max, steepDeg: Math.atan(steep) * 180 / Math.PI, hours: Math.max(th, tv) + Math.min(th, tv) / 2, complete: s.length === samples.length };
}

// An itinerary is a line (pts, scene metres). One drawn on the map is also a list of steps: the points touched
// (ends: index in pts where each step lies), so the last step and the stretch leading to it can be taken back.
export class RouteLayer {
  constructor({ scene, groundAt }) {
    this.groundAt = groundAt; this.pts = []; this.ends = []; this.keep = 0; this.name = ''; this.drawing = false; this.samples = []; this.dirty = true;
    this.mat = new LineMaterial({ color: 0xff3b30, linewidth: 4, transparent: true, depthTest: true });
    this.under = new LineMaterial({ color: 0x3a0a08, linewidth: 7, transparent: true, opacity: 0.6, depthTest: true });
    // the parts hidden behind the relief: dashes drawn over it, so the line is never cut
    this.hidden = new LineMaterial({ color: 0xff3b30, linewidth: 3, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, dashed: true, dashSize: 14, gapSize: 10 });
    this.group = new THREE.Group(); scene.add(this.group);
    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.cursor.renderOrder = 11; this.cursor.visible = false; this.group.add(this.cursor);
    this.lines = [];
    // kept in longitude/latitude: the scene's metres depend on the massif open (older saves in metres are dropped)
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s?.ll?.length) {
        this.pts = s.ll.map(([lon, lat]) => lonLatToWorld(lon, lat)); this.name = s.name || '';
        this.ends = Array.isArray(s.ends) && s.ends.every(i => i < this.pts.length) ? s.ends : [];
        this.keep = this.ends.length ? Math.min(+s.keep || 0, this.ends.length) : 0;
      }
    } catch { }
  }
  setResolution(w, h) { for (const m of [this.mat, this.under, this.hidden]) m.resolution.set(w, h); }
  save() { try { localStorage.setItem(STORE, JSON.stringify({ ll: this.pts.map(([x, z]) => worldToLonLat(x, z).map(v => +v.toFixed(6))), name: this.name, ends: this.ends, keep: this.keep })); } catch { } }

  // ----- drawing step by step -----
  // the steps of the line: those touched, or for a line from elsewhere (GPX, planner) its two ends, so that
  // drawing can carry on from its end
  get steps() { return this.ends.length ? this.ends.map(i => this.pts[i]) : this.pts.length ? [this.pts[0], this.pts[this.pts.length - 1]] : []; }
  get last() { return this.pts[this.pts.length - 1] ?? null; }
  // start drawing: a new line (the one there is kept aside, to come back to if the drawing is abandoned), or
  // carrying on the one there is
  beginDraw(fresh) {
    this.backup = { pts: this.pts, ends: this.ends, keep: this.keep, name: this.name };
    // a line from elsewhere (GPX, planner, topo) stays whole: "undo" only takes back the steps added to it
    // (keep = how many steps are kept, remembered with the line)
    if (fresh) { this.pts = []; this.ends = []; this.keep = 0; this.name = ''; }
    else if (!this.ends.length && this.pts.length) { this.ends = [0, this.pts.length - 1]; this.keep = 2; }
    this.drawing = true; this.dirty = true;
  }
  // abandon the drawing: the line as it was before
  cancelDraw() { if (this.backup) Object.assign(this, this.backup); this.backup = null; this.drawing = false; this.dirty = true; this.save(); }
  endDraw() {
    if (this.keep && this.ends.length === this.keep) { this.ends = []; this.keep = 0; } // nothing added: still the line from elsewhere
    this.backup = null; this.drawing = false; this.dirty = true; this.save();
  }
  // a new step, reached by the stretch "via" (the points from the previous step to this one, both included)
  addStep(x, z, via) {
    if (!this.pts.length) { this.pts = [[x, z]]; this.ends = [0]; }
    else {
      const seg = via?.length ? via : [this.last, [x, z]];
      const skip = Math.hypot(seg[0][0] - this.last[0], seg[0][1] - this.last[1]) < 0.5 ? 1 : 0; // the previous step itself
      this.pts = this.pts.concat(seg.slice(skip)); this.ends = [...this.ends, this.pts.length - 1];
    }
    this.dirty = true; this.save();
  }
  // move the first step (the start, put on the path found from it)
  moveStart(x, z) { if (this.pts.length) { this.pts = [[x, z], ...this.pts.slice(1)]; this.dirty = true; this.save(); } }
  // take back the last step and the stretch that led to it
  undo() {
    if (this.ends.length <= this.keep) return;
    if (this.ends.length <= 1) { this.pts = []; this.ends = []; }
    else { this.ends = this.ends.slice(0, -1); this.pts = this.pts.slice(0, this.ends[this.ends.length - 1] + 1); }
    this.dirty = true; this.save();
  }
  clear() { this.pts = []; this.ends = []; this.keep = 0; this.name = ''; this.dirty = true; this.save(); }
  importGPX(text, fileName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error("ce fichier n'est pas un GPX lisible");
    let nodes = [...doc.getElementsByTagName('trkpt')]; if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    if (nodes.length < 2) throw new Error('aucun tracé dans ce fichier (il faut des points de trace ou de route)');
    this.pts = nodes.map(n => lonLatToWorld(+n.getAttribute('lon'), +n.getAttribute('lat'))); this.ends = []; this.keep = 0;
    this.name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent.trim() || fileName.replace(/\.gpx$/i, '');
    this.dirty = true; this.save();
  }
  toGPX() {
    const pts = this.samples.length ? this.samples : this.pts.map(([x, z]) => ({ x, z, h: this.groundAt(x, z) }));
    const esc = s => s.replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
    const trk = pts.map(p => { const [lon, lat] = worldToLonLat(p.x, p.z); return `<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${p.h != null ? `<ele>${p.h.toFixed(1)}</ele>` : ''}</trkpt>`; }).join('\n      ');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Montagne 3D" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${esc(this.name || 'Itinéraire')}</name><trkseg>\n      ${trk}\n  </trkseg></trk>\n</gpx>\n`;
  }

  // ----- geometry and numbers -----
  resample() { return resamplePath(this.pts, this.groundAt); }
  stats() { return pathStats(this.samples); }
  setPath(pts, name) { this.pts = pts; this.ends = []; this.keep = 0; this.name = name; this.drawing = false; this.dirty = true; this.save(); }
  pointAt(d) {
    const s = this.samples; if (!s.length) return null;
    let i = 1; while (i < s.length - 1 && s[i].d < d) i++;
    const a = s[i - 1], b = s[i], f = Math.min(1, Math.max(0, (d - a.d) / ((b.d - a.d) || 1)));
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, h: (a.h ?? b.h ?? 0) + ((b.h ?? a.h ?? 0) - (a.h ?? b.h ?? 0)) * f };
  }
  get length() { return this.samples.length ? this.samples[this.samples.length - 1].d : 0; }

  // lay the line on the relief (again when finer tiles have arrived or the relief exaggeration changed)
  drape(exag) {
    this.samples = this.resample(); this.dirty = false; this.exag = exag;
    this.lines.forEach(l => { this.group.remove(l); l.geometry.dispose(); }); this.lines = [];
    if (this.samples.length < 2) return;
    let last = 0; const pos = [];
    for (const p of this.samples) { const h = p.h ?? last; last = h; pos.push(p.x, h * exag + 2.5, p.z); }
    // dashes first, over everything; then the solid line where the relief does not hide it
    for (const m of [this.hidden, this.under, this.mat]) { const g = new LineGeometry(); g.setPositions(pos); const l = new Line2(g, m); l.computeLineDistances(); l.renderOrder = m === this.mat ? 6 : 5; this.group.add(l); this.lines.push(l); }
  }
  // true when the line was laid again (its numbers may have changed)
  update(frameN, exag, loading) {
    if (this.dirty || exag !== this.exag || (frameN % 120 === 0 && loading === 0 && this.samples.some(p => p.h == null))) { this.drape(exag); return true; }
    if (frameN % 300 === 0 && this.samples.length) { this.drape(exag); return true; } // finer relief keeps arriving: refresh now and then
    return false;
  }
  showCursor(d, camera, exag) {
    const p = d == null ? null : this.pointAt(d); this.cursor.visible = !!p; if (!p) return;
    this.cursor.position.set(p.x, p.h * exag + 3, p.z); this.cursor.scale.setScalar(Math.max(1.5, camera.position.distanceTo(this.cursor.position) * 0.007));
  }

  // altitude profile as SVG (distance in km across, altitude in m up)
  profileSVG() {
    const s = this.samples.filter(p => p.h != null); if (s.length < 2) return '';
    const W = 320, H = 130, L = 42, R = 8, T = 8, B = 22, dist = s[s.length - 1].d;
    let lo = Math.min(...s.map(p => p.h)), hi = Math.max(...s.map(p => p.h)); const pad = Math.max(20, (hi - lo) * 0.1); lo -= pad; hi += pad;
    const x = d => L + d / dist * (W - L - R), y = h => T + (hi - h) / (hi - lo) * (H - T - B);
    const step = s.length > 400 ? Math.ceil(s.length / 400) : 1, line = s.filter((_, i) => i % step === 0 || i === s.length - 1).map(p => `${x(p.d).toFixed(1)},${y(p.h).toFixed(1)}`).join(' ');
    const nice = v => { const e = 10 ** Math.floor(Math.log10(v)), m = v / e; return (m < 2 ? 1 : m < 5 ? 2 : 5) * e; };
    let g = ''; const dh = nice((hi - lo) / 3), dd = nice(dist / 4);
    for (let h = Math.ceil(lo / dh) * dh; h <= hi; h += dh) g += `<line x1="${L}" x2="${W - R}" y1="${y(h)}" y2="${y(h)}" class="gl"/><text x="${L - 5}" y="${y(h) + 3.5}" text-anchor="end">${Math.round(h).toLocaleString('fr-FR')}</text>`;
    for (let d = 0; d <= dist; d += dd) g += `<text x="${x(d)}" y="${H - 7}" text-anchor="middle">${(d / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km</text>`;
    return `<figure class="chart profile"><svg viewBox="0 0 ${W} ${H}" data-l="${L}" data-w="${W - L - R}" data-dist="${dist}" role="img" aria-label="Profil d'altitude de l'itinéraire">${g}
      <polygon points="${L},${H - B} ${line} ${W - R},${H - B}" class="area"/><polyline points="${line}" class="ln n"/><line class="cur" x1="0" x2="0" y1="${T}" y2="${H - B}" visible="false"/></svg>
      <figcaption>Profil d'altitude (relief LiDAR IGN) — touche le profil pour situer le point sur la carte</figcaption></figure>`;
  }
}
