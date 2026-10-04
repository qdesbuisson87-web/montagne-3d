// Torrents and waterfalls from IGN BD TOPO (WFS: "troncon_hydrographique", natural surface streams, drawn in
// the direction they flow; "detail_hydrographique" for the named waterfalls). The streams are laid on the relief
// as a blue line with light dashes moving downstream (faster where the stream is steeper is not modelled: one
// pace for all); intermittent ones are fainter. Waterfalls become small labels. Fetched by cells of ≈ 4 km
// around the view, kept for offline use.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610042126';
import { cachedFetch } from './net.js?v=202610042126';

const CELL = 0.04, RANGE = 5000, SHOW = 5000;
const WFS = (layer, cql, [s, w, n, e]) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${layer}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=5000`
  + `&CQL_FILTER=${encodeURIComponent(`${cql} AND BBOX(geometrie,${w},${s},${e},${n},'EPSG:4326')`)}`;

export class Streams {
  constructor({ scene, groundAt, onFalls }) {
    this.group = new THREE.Group(); scene.add(this.group); this.groundAt = groundAt; this.onFalls = onFalls;
    this.cells = new Map(); this.on = true; this.exag = 1;
    const mat = (o) => new LineMaterial({ transparent: true, depthWrite: false, ...o });
    this.mats = {
      perm: mat({ color: 0x4aa3e8, linewidth: 2.6, opacity: 0.85 }),
      permFlow: mat({ color: 0xe8f6ff, linewidth: 1.6, opacity: 0.9, dashed: true, dashSize: 4, gapSize: 9 }),
      inter: mat({ color: 0x6fb4e6, linewidth: 1.6, opacity: 0.45 })
    };
  }
  setResolution(w, h) { for (const m of Object.values(this.mats)) m.resolution.set(w, h); }

  ensure(x, z) {
    const [lon, lat] = worldToLonLat(x, z), dLat = RANGE / 111000, dLon = RANGE / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue;
      const cell = { ways: null, meshes: [], draped: 0 }; this.cells.set(key, cell);
      [cell.cx, cell.cz] = lonLatToWorld((b + 0.5) * CELL, (a + 0.5) * CELL);
      const box = [a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL], json = u => cachedFetch(u).then(r => r.ok ? r.json() : null);
      Promise.all([
        json(WFS('BDTOPO_V3:troncon_hydrographique', "nature='Ecoulement naturel' AND position_par_rapport_au_sol='0'", box)),
        json(WFS('BDTOPO_V3:detail_hydrographique', "nature='Cascade'", box))
      ]).then(([st, falls]) => {
        if (this.cells.get(key) !== cell) return;
        if (!st) { this.cells.delete(key); return; } // no answer: try again later
        cell.ways = st.features.flatMap(f => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates])
          .map(l => ({ perm: f.properties.persistance === 'Permanent', reverse: f.properties.sens_de_l_ecoulement === 'Sens inverse', pts: l.map(([lo, la]) => lonLatToWorld(lo, la)) })))
          .filter(w => w.pts.length > 1);
        const named = (falls?.features ?? []).filter(f => f.properties.toponyme).map(f => {
          const [lo, la] = f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0];
          return { id: f.properties.cleabs, name: f.properties.toponyme, lon: lo, lat: la };
        });
        if (named.length) this.onFalls?.(named);
      }).catch(() => this.cells.delete(key));
    }
  }
  // lay a cell's streams on the relief (again when finer relief has arrived); segments in the direction of flow
  drape(cell) {
    for (const m of cell.meshes) { this.group.remove(m); m.geometry.dispose(); } cell.meshes = [];
    const perm = [], inter = [];
    for (const w of cell.ways) {
      const pts = w.reverse ? [...w.pts].reverse() : w.pts, arr = w.perm ? perm : inter;
      let prev = null;
      for (const [x, z] of pts) {
        const g = this.groundAt(x, z); if (g == null) { prev = null; continue; }
        const p = [x, (g + 0.8) * this.exag, z]; if (prev) arr.push(...prev, ...p); prev = p;
      }
    }
    const add = (pos, mat, order) => { if (!pos.length) return; const g = new LineSegmentsGeometry(); g.setPositions(pos); const m = new LineSegments2(g, mat); m.computeLineDistances(); m.renderOrder = order; this.group.add(m); cell.meshes.push(m); };
    add(perm, this.mats.perm, 3); add(perm, this.mats.permFlow, 3); add(inter, this.mats.inter, 3);
    cell.draped = performance.now();
  }
  update(camera, target, frameN, exag, hidden, dt) {
    this.group.visible = this.on && !hidden; if (!this.group.visible) return;
    if (frameN % 50 === 7) this.ensure(target.x, target.z);
    this.mats.permFlow.dashOffset -= dt * 3; // the water runs downstream (≈ 3 m/s)
    const now = performance.now(), c = camera.position, reExag = exag !== this.exag; this.exag = exag;
    // cells far behind are freed (see trails.js)
    if (frameN % 300 === 160) for (const [k, cell] of this.cells) if (Math.hypot(cell.cx - c.x, cell.cz - c.z) > 25000) { cell.meshes.forEach(m => { this.group.remove(m); m.geometry.dispose(); }); this.cells.delete(k); }
    let budget = 1;
    for (const cell of this.cells.values()) {
      const vis = Math.hypot(cell.cx - c.x, cell.cz - c.z) < SHOW;
      cell.meshes.forEach(m => { m.visible = vis; });
      if (!cell.ways || !vis || budget <= 0) continue;
      if (!cell.draped || reExag || now - cell.draped > 6000) { this.drape(cell); budget--; }
    }
  }
}
