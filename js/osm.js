// Paths, huts, lifts and ski runs from OpenStreetMap (Overpass API, © OpenStreetMap contributors, ODbL),
// fetched by cells of ≈ 4 km around the view (cached for offline use) and laid on the relief.
// Paths as on IGN maps: red for hiking, black dashes for alpine routes (SAC scale T4 and above), brown tracks.
// Lifts hang between their pylons, ski runs keep the French colours (green, blue, red, black).
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202609301740';
import { cachedFetch } from './net.js?v=202609301740';

const CELL = 0.04, RANGE = 5000, SHOW = 9000;
const Q = (s, w, n, e) => `[out:json][timeout:40];(way["highway"~"^(path|footway|track|bridleway|steps)$"](${s},${w},${n},${e});way["aerialway"~"^(cable_car|gondola|chair_lift|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow)$"](${s},${w},${n},${e});way["piste:type"="downhill"](${s},${w},${n},${e});node["tourism"~"^(alpine_hut|wilderness_hut)$"](${s},${w},${n},${e}););out geom tags;`;
const URL_ = q => `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`;

// kind -> [colour, width px, dashed, lift offset above ground (m)]
const STYLE = {
  hike: [0xe0261b, 2.6, false, 1.2], alpine: [0x151515, 2.4, true, 1.2], track: [0x8a5a2b, 2.2, false, 1.0],
  lift: [0x202428, 2.0, false, 0], green: [0x2e9e44, 4, false, 0.8], blue: [0x2166d9, 4, false, 0.8], red: [0xd92121, 4, false, 0.8], black: [0x111111, 4, false, 0.8]
};
function kindOf(t) {
  if (t.aerialway) return 'lift';
  if (t['piste:type'] === 'downhill') return { novice: 'green', easy: 'blue', intermediate: 'red', advanced: 'black', expert: 'black', freeride: 'black' }[t['piste:difficulty']] ?? 'blue';
  if (t.highway === 'track') return 'track';
  return /demanding_alpine|difficult_alpine|alpine_hiking|demanding_mountain/.test(t.sac_scale ?? '') ? 'alpine' : 'hike';
}

export class OsmLayer {
  constructor({ scene, groundAt, onHuts }) {
    this.group = new THREE.Group(); scene.add(this.group); this.groundAt = groundAt; this.onHuts = onHuts;
    this.cells = new Map(); this.on = true; this.exag = 1; this.resolution = new THREE.Vector2(1, 1);
    this.mats = Object.fromEntries(Object.entries(STYLE).map(([k, [c, w, dash]]) => [k, new LineMaterial({ color: c, linewidth: w, dashed: dash, dashSize: 6, gapSize: 5, transparent: true, opacity: ['green', 'blue', 'red', 'black'].includes(k) ? 0.7 : 0.95 })])); // ski runs half see-through
  }
  setResolution(w, h) { this.resolution.set(w, h); for (const m of Object.values(this.mats)) m.resolution.set(w, h); }

  ensure(x, z) {
    const [lon, lat] = worldToLonLat(x, z), dLat = RANGE / 111000, dLon = RANGE / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue;
      const cell = { ways: null, meshes: [], draped: 0 }; this.cells.set(key, cell);
      [cell.cx, cell.cz] = lonLatToWorld((b + 0.5) * CELL, (a + 0.5) * CELL);
      cachedFetch(URL_(Q(a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL))).then(r => r.ok ? r.json() : null).then(j => {
        if (!j || this.cells.get(key) !== cell) { if (!j) this.cells.delete(key); return; }
        cell.ways = j.elements.filter(e => e.type === 'way' && e.geometry?.length > 1).map(e => ({ kind: kindOf(e.tags ?? {}), pts: e.geometry.map(g => lonLatToWorld(g.lon, g.lat)) }));
        const huts = j.elements.filter(e => e.type === 'node' && e.tags?.name).map(e => ({ id: e.id, name: e.tags.name, alt: +e.tags.ele || null, lon: e.lon, lat: e.lat, kind: e.tags.tourism, url: e.tags.website || e.tags['contact:website'] || null }));
        if (huts.length) this.onHuts?.(huts);
      }).catch(() => this.cells.delete(key)); // offline or refused: try again later
    }
  }
  // (re)lay a cell's lines on the relief: once loaded, then when finer tiles arrive
  drape(cell) {
    for (const m of cell.meshes) { this.group.remove(m); m.geometry.dispose(); } cell.meshes = [];
    const by = {};
    for (const w of cell.ways) {
      const off = STYLE[w.kind][3], arr = by[w.kind] ??= [];
      let prev = null;
      for (const [x, z] of w.pts) {
        const g = this.groundAt(x, z); if (g == null) { prev = null; continue; }
        const p = [x, (g + (w.kind === 'lift' ? 14 : off)) * this.exag, z]; // lifts hang ~14 m above the ground at each pylon
        if (prev) arr.push(...prev, ...p); prev = p;
      }
    }
    for (const [k, pos] of Object.entries(by)) {
      if (!pos.length) continue;
      const g = new LineSegmentsGeometry(); g.setPositions(pos);
      const m = new LineSegments2(g, this.mats[k]); m.computeLineDistances(); m.renderOrder = 4; this.group.add(m); cell.meshes.push(m);
    }
    cell.draped = performance.now();
  }
  update(camera, target, frameN, exag, hidden) {
    this.group.visible = this.on && !hidden; if (!this.group.visible) return;
    if (frameN % 50 === 0) this.ensure(target.x, target.z);
    const now = performance.now(), c = camera.position, reExag = exag !== this.exag; this.exag = exag;
    let budget = 1; // one cell re-laid per frame at most: no stutter
    for (const cell of this.cells.values()) {
      const d = Math.hypot(cell.cx - c.x, cell.cz - c.z), vis = d < SHOW;
      cell.meshes.forEach(m => { m.visible = vis; });
      if (!cell.ways || !vis || budget <= 0) continue;
      if (!cell.draped || reExag || now - cell.draped > 6000) { this.drape(cell); budget--; }
    }
  }
}
