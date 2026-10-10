// An itinerary: imported from a GPX file or drawn with the finger, laid on the relief, with its numbers
// (distance, climb, descent, highest point, steepest stretch, walking time) and its altitude profile.
// Altitudes come from the relief under the path (IGN LiDAR), not from the file: GPS altitudes are noisy.
// Walking time: standard DIN 33466 (average hiker, no breaks): 4 km/h on the flat, 300 m/h up, 500 m/h down,
// the longer of the horizontal and vertical times plus half the shorter one.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610101153';

const STEP = 10, STORE = 'midi3d-route'; // metres between resampled points

// What each point of a line is (route.net): OFF the IGN network, ON it (the route service's paths and roads), or
// on a LIFT (a ride: no walking, no climb, no walking time; drawn straight from station to station)
export const OFF = 0, ON = 1, LIFT = 2;
export const netString = net => net.map(v => v === LIFT ? '2' : v ? '1' : '0').join('');

// points every STEP metres along a path [[x, z], …], with the relief's altitude (null where nothing is loaded)
// net (optional): per point, OFF / ON / LIFT; a sample's stretch (to the next sample) is on the network when both
// ends of it are, a ride when both ends are on a lift. A ride's altitudes go straight from one station to the other.
export function resamplePath(pts, groundAt, net = null) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
    const on = !!(net?.[i] && net?.[i + 1]), lift = net?.[i] === LIFT && net?.[i + 1] === LIFT;
    for (let k = 0; k < n; k++) out.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n, net: on, lift });
  }
  if (pts.length) { const [x, z] = pts[pts.length - 1]; out.push({ x, z }); }
  let d = 0; out.forEach((p, i) => { if (i) d += Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z); p.d = d; p.h = p.lift && i && out[i - 1].lift ? null : groundAt(p.x, p.z); });
  // rides: straight between the stations' ground
  for (let i = 0; i < out.length; i++) {
    if (!out[i].lift) continue;
    let j = i; while (j < out.length - 1 && out[j].lift) j++;
    const a = out[i], b = out[j]; if (b.h == null) b.h = groundAt(b.x, b.z);
    for (let k = i + 1; k < j; k++) out[k].h = a.h != null && b.h != null ? a.h + (b.h - a.h) * (out[k].d - a.d) / (b.d - a.d) : null;
    i = j - 1;
  }
  return out;
}
// the numbers of a resampled path (see the header for the rules)
// dist is the distance walked; rides (lifts) are counted apart (ride, rideUp) and add nothing to the walking time
export function pathStats(samples) {
  const s = samples.filter(p => p.h != null); if (s.length < 2) return null;
  let up = 0, down = 0, ref = s[0].h, min = Infinity, max = -Infinity, steep = 0, dist = 0, ride = 0, rideUp = 0;
  const rides = new Int32Array(s.length + 1); // rides before each sample, to keep the steepest stretch off the cables
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    min = Math.min(min, p.h); max = Math.max(max, p.h);
    if (i && s[i - 1].lift) { ride += p.d - s[i - 1].d; rideUp += Math.max(0, p.h - s[i - 1].h); ref = p.h; rides[i + 1] = rides[i] + 1; continue; }
    rides[i + 1] = rides[i];
    if (i) dist += p.d - s[i - 1].d;
    // climb counted in steps of at least 3 m, so that the relief's roughness does not add up
    if (p.h - ref >= 3) { up += p.h - ref; ref = p.h; } else if (ref - p.h >= 3) { down += ref - p.h; ref = p.h; }
  }
  for (let i = 0, j = 0; i < s.length; i++) { while (j < s.length && s[j].d - s[i].d < 30) j++; if (j < s.length && rides[j + 1] === rides[i + 1]) steep = Math.max(steep, Math.abs(s[j].h - s[i].h) / (s[j].d - s[i].d)); }
  const th = dist / 4000, tv = up / 300 + down / 500;
  return { dist, up, down, min, max, ride, rideUp, steepDeg: Math.atan(steep) * 180 / Math.PI, hours: Math.max(th, tv) + Math.min(th, tv) / 2, complete: s.length === samples.length };
}

// An itinerary is a line (pts, scene metres). One drawn on the map is also a list of steps: the points touched
// (ends: index in pts where each step lies), so the last step and the stretch leading to it can be taken back.
export class RouteLayer {
  constructor({ scene, groundAt }) {
    this.groundAt = groundAt; this.pts = []; this.net = []; this.ends = []; this.keep = 0; this.nights = []; this.name = ''; this.drawing = false; this.samples = []; this.dirty = true;
    this.mat = new LineMaterial({ color: 0xff3b30, linewidth: 4, transparent: true, depthTest: true });
    this.under = new LineMaterial({ color: 0x3a0a08, linewidth: 7, transparent: true, opacity: 0.6, depthTest: true });
    // the parts hidden behind the relief: dashes drawn over it, so the line is never cut
    this.hidden = new LineMaterial({ color: 0xff3b30, linewidth: 3, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, dashed: true, dashSize: 14, gapSize: 10 });
    // stretches that are not a walk (routebook.js walkability), drawn over the line in their own colour
    this.hazMats = {
      rock: new LineMaterial({ color: 0xd61fff, linewidth: 7, transparent: true, depthTest: false, depthWrite: false }),
      glacier: new LineMaterial({ color: 0x8fdcff, linewidth: 7, transparent: true, depthTest: false, depthWrite: false }),
      steep: new LineMaterial({ color: 0xff8a00, linewidth: 7, transparent: true, depthTest: false, depthWrite: false }),
      under: new LineMaterial({ color: 0x00e0c0, linewidth: 4, transparent: true, depthTest: false, depthWrite: false, dashed: true, dashSize: 6, gapSize: 6 }),
      // ski descents by slope, the colours of the slope map (45° and more lighter than the map's, to stand out)
      s30: new LineMaterial({ color: 0xff9419, linewidth: 6, transparent: true, depthTest: false, depthWrite: false }),
      s35: new LineMaterial({ color: 0xe3261f, linewidth: 6, transparent: true, depthTest: false, depthWrite: false }),
      s40: new LineMaterial({ color: 0x9a37d0, linewidth: 6, transparent: true, depthTest: false, depthWrite: false }),
      s45: new LineMaterial({ color: 0xb8bcc8, linewidth: 6, transparent: true, depthTest: false, depthWrite: false }),
      lift: new LineMaterial({ color: 0xffffff, linewidth: 5, transparent: true, depthTest: false, depthWrite: false, dashed: true, dashSize: 16, gapSize: 9 }),
      off: new LineMaterial({ color: 0xffd400, linewidth: 5, transparent: true, depthTest: false, depthWrite: false, dashed: true, dashSize: 10, gapSize: 8 })
    };
    // dark edge under them: the slope map uses the same yellow / orange / purple, the line must read as a line
    this.hazEdge = new LineMaterial({ color: 0x14161c, linewidth: 11, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
    this.hazards = [];
    this.group = new THREE.Group(); scene.add(this.group);
    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.cursor.renderOrder = 11; this.cursor.visible = false; this.group.add(this.cursor);
    this.lines = [];
    // kept in longitude/latitude: the scene's metres depend on the massif open (older saves in metres are dropped)
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s?.ll?.length) {
        this.pts = s.ll.map(([lon, lat]) => lonLatToWorld(lon, lat)); this.name = s.name || '';
        this.net = typeof s.net === 'string' && s.net.length === this.pts.length ? [...s.net].map(Number) : [];
        this.ends = Array.isArray(s.ends) && s.ends.every(i => i < this.pts.length) ? s.ends : [];
        this.keep = this.ends.length ? Math.min(+s.keep || 0, this.ends.length) : 0;
        this.nights = Array.isArray(s.nights) ? s.nights.filter(d => typeof d === 'number') : [];
      }
    } catch { }
  }
  setResolution(w, h) { for (const m of [this.mat, this.under, this.hidden, ...Object.values(this.hazMats), this.hazEdge]) m.resolution.set(w, h); }
  // [{ d0, d1, kind }] along the line (metres), shown until the line changes
  setHazards(list) { this.hazards = list; this.dirty = true; }
  save() { try { localStorage.setItem(STORE, JSON.stringify({ ll: this.pts.map(([x, z]) => worldToLonLat(x, z).map(v => +v.toFixed(6))), name: this.name, ends: this.ends, keep: this.keep, nights: this.nights, net: netString(this.net) })); } catch { } }

  // ----- drawing step by step -----
  // the steps of the line: those touched, or for a line from elsewhere (GPX, planner) its two ends, so that
  // drawing can carry on from its end
  get steps() { return this.ends.length ? this.ends.map(i => this.pts[i]) : this.pts.length ? [this.pts[0], this.pts[this.pts.length - 1]] : []; }
  get last() { return this.pts[this.pts.length - 1] ?? null; }
  // start drawing: a new line (the one there is kept aside, to come back to if the drawing is abandoned), or
  // carrying on the one there is
  beginDraw(fresh) {
    this.backup = { pts: this.pts, net: this.net, ends: this.ends, keep: this.keep, nights: this.nights, name: this.name };
    // a line from elsewhere (GPX, planner, topo) stays whole: "undo" only takes back the steps added to it
    // (keep = how many steps are kept, remembered with the line)
    if (fresh) { this.pts = []; this.net = []; this.ends = []; this.keep = 0; this.nights = []; this.name = ''; }
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
  // net: per point of "via", whether it is on the IGN network (route service); a straight stretch has none
  addStep(x, z, via, net = null) {
    if (!this.pts.length) { this.pts = [[x, z]]; this.net = [false]; this.ends = [0]; }
    else {
      const seg = via?.length ? via : [this.last, [x, z]];
      const skip = Math.hypot(seg[0][0] - this.last[0], seg[0][1] - this.last[1]) < 0.5 ? 1 : 0; // the previous step itself
      this.net = this.net.concat((net ?? seg.map(() => false)).slice(skip));
      if (skip && net?.[0]) this.net[this.pts.length - 1] = true; // the previous step lies where the path starts
      this.pts = this.pts.concat(seg.slice(skip)); this.ends = [...this.ends, this.pts.length - 1];
    }
    this.dirty = true; this.save();
  }
  // move the first step (the start, put on the path found from it)
  moveStart(x, z) { if (this.pts.length) { this.pts = [[x, z], ...this.pts.slice(1)]; this.net[0] = true; this.dirty = true; this.save(); } }
  // take back the last step and the stretch that led to it
  undo() {
    if (this.ends.length <= this.keep) return;
    if (this.ends.length <= 1) { this.pts = []; this.net = []; this.ends = []; }
    else { this.ends = this.ends.slice(0, -1); this.pts = this.pts.slice(0, this.ends[this.ends.length - 1] + 1); this.net = this.net.slice(0, this.pts.length); }
    this.dirty = true; this.save();
  }
  clear() { this.pts = []; this.net = []; this.ends = []; this.keep = 0; this.nights = []; this.name = ''; this.dirty = true; this.save(); }
  importGPX(text, fileName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error("ce fichier n'est pas un GPX lisible");
    let nodes = [...doc.getElementsByTagName('trkpt')]; if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    if (nodes.length < 2) throw new Error('aucun tracé dans ce fichier (il faut des points de trace ou de route)');
    this.pts = nodes.map(n => lonLatToWorld(+n.getAttribute('lon'), +n.getAttribute('lat'))); this.net = []; this.ends = []; this.keep = 0; this.nights = [];
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
  resample() { return resamplePath(this.pts, this.groundAt, this.net); }
  stats() { return pathStats(this.samples); }
  // nights: distances along the line (m) where an outing of several days stops for the night
  // net: what each point is (OFF / ON / LIFT), or true when the whole line comes from the IGN route service
  // (planner, catalogue); false for GPS tracks and GPX files
  setPath(pts, name, nights = [], net = false) { this.pts = pts; this.net = Array.isArray(net) ? net : pts.map(() => net ? ON : OFF); this.ends = []; this.keep = 0; this.nights = nights; this.name = name; this.drawing = false; this.dirty = true; this.save(); }
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
    // rides, from station to station
    for (let i = 0; i < this.samples.length - 1; i++) {
      if (!this.samples[i].lift) continue;
      let j = i; while (j < this.samples.length - 1 && this.samples[j].lift) j++;
      const seg = []; for (let k = i; k <= j; k++) seg.push(pos[k * 3], pos[k * 3 + 1] + 6, pos[k * 3 + 2]);
      for (const m of [this.hazEdge, this.hazMats.lift]) { const g = new LineGeometry(); g.setPositions(seg); const l = new Line2(g, m); l.computeLineDistances(); l.renderOrder = m === this.hazEdge ? 7 : 8; this.group.add(l); this.lines.push(l); }
      i = j;
    }
    for (const hz of this.hazards) {
      // under avalanche slopes: a little above the others, as it can overlap them
      const up = hz.kind === 'under' ? 7 : 1, seg = []; this.samples.forEach((p, i) => { if (p.d >= hz.d0 - 5 && p.d <= hz.d1 + 5) seg.push(pos[i * 3], pos[i * 3 + 1] + up, pos[i * 3 + 2]); });
      if (seg.length < 6) continue;
      for (const m of [this.hazEdge, this.hazMats[hz.kind]]) { const g = new LineGeometry(); g.setPositions(seg); const l = new Line2(g, m); l.computeLineDistances(); l.renderOrder = m === this.hazEdge ? 7 : 8; this.group.add(l); this.lines.push(l); }
    }
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
