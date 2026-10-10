// Ski pistes from OpenStreetMap (© its contributors, ODbL), copied each morning into data/pistes-<site>.json by
// the daily job (scripts/pistes.py; the public Overpass servers are too often busy to be asked live).
// Laid on the relief in the colours of their difficulty; cross-country and ski-touring routes dashed.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { lonLatToWorld } from './geo.js?v=202610101215';

// style per kind of piste: colour, width (px), dashed
const STYLES = {
  novice: [0x2fa84f, 3.2], easy: [0x2f6fd8, 3.2], intermediate: [0xd8322a, 3.2], advanced: [0x15171a, 3.4], expert: [0x15171a, 3.4],
  freeride: [0xf08a24, 2.6, true], nordic: [0x8a5cd8, 2.4, true], skitour: [0xf0a020, 2.2, true]
};
export const PISTE_LEGEND = [['novice', 'Verte'], ['easy', 'Bleue'], ['intermediate', 'Rouge'], ['advanced', 'Noire'], ['freeride', 'Hors-piste balisé'], ['nordic', 'Ski de fond'], ['skitour', 'Ski de rando']];
const CELL = 0.04;

export class Pistes {
  constructor({ scene, groundAt }) {
    this.groundAt = groundAt; this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    this.on = false; this.exag = 1; this.cells = new Map(); this.data = null;
    this.mats = Object.fromEntries(Object.entries(STYLES).map(([k, [c, w, dash]]) => [k, new LineMaterial({ color: c, linewidth: w, transparent: true, opacity: 0.95, dashed: !!dash, dashSize: 12, gapSize: 9 })]));
  }
  setResolution(w, h) { for (const m of Object.values(this.mats)) m.resolution.set(w, h); }
  async load(site) {
    try { const r = await fetch(`data/pistes-${site.id}.json`); if (!r.ok) return null; this.data = await r.json(); } catch { return null; }
    for (const p of this.data.pistes) {
      const kind = p.type === 'downhill' ? (STYLES[p.diff] ? p.diff : 'intermediate') : p.type === 'nordic' ? 'nordic' : p.type === 'skitour' ? 'skitour' : null;
      if (!kind) continue;
      const pts = p.line.map(([lon, lat]) => lonLatToWorld(lon, lat)), key = `${Math.floor(p.line[0][1] / CELL)}/${Math.floor(p.line[0][0] / CELL)}`;
      let cell = this.cells.get(key); if (!cell) { cell = { ways: [], meshes: [], draped: 0, cx: pts[0][0], cz: pts[0][1] }; this.cells.set(key, cell); }
      cell.ways.push({ kind, pts });
    }
    return this.data;
  }
  drape(cell) {
    for (const m of cell.meshes) { this.group.remove(m); m.geometry.dispose(); } cell.meshes = [];
    const by = {};
    for (const w of cell.ways) {
      const arr = by[w.kind] ??= []; let prev = null;
      for (const [x, z] of w.pts) { const g = this.groundAt(x, z); if (g == null) { prev = null; continue; } const p = [x, (g + 1.5) * this.exag, z]; if (prev) arr.push(...prev, ...p); prev = p; }
    }
    for (const [k, pos] of Object.entries(by)) {
      if (!pos.length) continue;
      const g = new LineSegmentsGeometry(); g.setPositions(pos); const m = new LineSegments2(g, this.mats[k]); m.computeLineDistances(); m.renderOrder = 4;
      this.group.add(m); cell.meshes.push(m);
    }
    cell.draped = performance.now();
  }
  update(camera, exag, hidden) {
    this.group.visible = this.on && !hidden && !!this.data; if (!this.group.visible) return;
    const now = performance.now(), c = camera.position, reExag = exag !== this.exag; this.exag = exag;
    let budget = 1;
    for (const cell of this.cells.values()) {
      const vis = Math.hypot(cell.cx - c.x, cell.cz - c.z) < 15000;
      cell.meshes.forEach(m => { m.visible = vis; });
      if (!vis || budget <= 0) continue;
      if (!cell.draped || reExag || now - cell.draped > 8000) { this.drape(cell); budget--; }
    }
  }
}
