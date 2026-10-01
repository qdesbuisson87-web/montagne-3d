// Footpaths, lifts and mountain huts from IGN BD TOPO (WFS Géoplateforme), fetched by cells of ≈ 4 km around
// the view (cached for offline use) and laid on the relief. Paths drawn as on IGN maps (red for footpaths,
// brown for tracks); lifts hang between their stations; huts become small labels.
// (OpenStreetMap's Overpass servers were tried first: unreachable from here, so the official IGN data is used.)
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610011842';
import { cachedFetch } from './net.js?v=202610011842';

const CELL = 0.04, RANGE = 5000, SHOW = 9000;
const WFS = (layer, cql, [s, w, n, e]) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${layer}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=5000`
  // in a CQL filter the box is lon/lat ('EPSG:4326'); in the BBOX parameter with the URN it is lat/lon
  + (cql ? `&CQL_FILTER=${encodeURIComponent(`${cql} AND BBOX(geometrie,${w},${s},${e},${n},'EPSG:4326')`)}` : `&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`);
// kind -> [colour, width in px, height above ground (m)]
const STYLE = { path: [0xe0261b, 2.6, 1.2], track: [0x8a5a2b, 2.4, 1.0], lift: [0x202428, 2.0, 14] };

export class TrailsLayer {
  constructor({ scene, groundAt, onHuts }) {
    this.group = new THREE.Group(); scene.add(this.group); this.groundAt = groundAt; this.onHuts = onHuts;
    this.cells = new Map(); this.on = true; this.exag = 1;
    this.mats = Object.fromEntries(Object.entries(STYLE).map(([k, [c, w]]) => [k, new LineMaterial({ color: c, linewidth: w, transparent: true, opacity: 0.95 })]));
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
        json(WFS('BDTOPO_V3:troncon_de_route', "nature IN ('Sentier','Chemin')", box)),
        json(WFS('BDTOPO_V3:transport_par_cable', null, box)),
        json(WFS('BDTOPO_V3:zone_d_activite_ou_d_interet', "nature IN ('Refuge','Abri de montagne')", box))
      ]).then(([roads, lifts, zones]) => {
        if (this.cells.get(key) !== cell) return;
        if (!roads && !lifts) { this.cells.delete(key); return; } // no answer: try again later
        const lines = (f, kind) => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]).map(l => ({ kind, pts: l.map(([lon, lat]) => lonLatToWorld(lon, lat)) }));
        cell.ways = [
          ...(roads?.features ?? []).flatMap(f => lines(f, f.properties.nature === 'Chemin' ? 'track' : 'path')),
          ...(lifts?.features ?? []).flatMap(f => lines(f, 'lift'))
        ].filter(w => w.pts.length > 1);
        const huts = (zones?.features ?? []).filter(f => f.properties.toponyme).map(f => {
          const ring = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : [f.geometry.coordinates]);
          const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length, lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          return { id: f.properties.cleabs, name: f.properties.toponyme, lon, lat, alt: null };
        });
        if (huts.length) this.onHuts?.(huts);
      }).catch(() => this.cells.delete(key));
    }
  }
  // (re)lay a cell's lines on the relief: once loaded, then when finer tiles have arrived
  drape(cell) {
    for (const m of cell.meshes) { this.group.remove(m); m.geometry.dispose(); } cell.meshes = [];
    const by = {};
    for (const w of cell.ways) {
      const lift = w.kind === 'lift', arr = by[w.kind] ??= [];
      if (lift) { // a cable: straight from station to station, sagging a little in the middle
        const g0 = this.groundAt(...w.pts[0]), g1 = this.groundAt(...w.pts[w.pts.length - 1]); if (g0 == null || g1 == null) continue;
        const [ax, az] = w.pts[0], [bx, bz] = w.pts[w.pts.length - 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(2, Math.ceil(L / 40));
        let prev = null;
        for (let i = 0; i <= n; i++) { const f = i / n, p = [ax + (bx - ax) * f, (g0 + 12 + (g1 - g0) * f - 4 * f * (1 - f) * L * 0.03) * this.exag, az + (bz - az) * f]; if (prev) arr.push(...prev, ...p); prev = p; }
        continue;
      }
      let prev = null;
      for (const [x, z] of w.pts) {
        const g = this.groundAt(x, z); if (g == null) { prev = null; continue; }
        const p = [x, (g + STYLE[w.kind][2]) * this.exag, z]; if (prev) arr.push(...prev, ...p); prev = p;
      }
    }
    for (const [k, pos] of Object.entries(by)) {
      if (!pos.length) continue;
      const g = new LineSegmentsGeometry(); g.setPositions(pos);
      const m = new LineSegments2(g, this.mats[k]); m.renderOrder = 4; this.group.add(m); cell.meshes.push(m);
    }
    cell.draped = performance.now();
  }
  update(camera, target, frameN, exag, hidden) {
    this.group.visible = this.on && !hidden; if (!this.group.visible) return;
    if (frameN % 50 === 0) this.ensure(target.x, target.z);
    const now = performance.now(), c = camera.position, reExag = exag !== this.exag; this.exag = exag;
    let budget = 1; // one cell re-laid per frame at most: no stutter
    for (const cell of this.cells.values()) {
      const vis = Math.hypot(cell.cx - c.x, cell.cz - c.z) < SHOW;
      cell.meshes.forEach(m => { m.visible = vis; });
      if (!cell.ways || !vis || budget <= 0) continue;
      if (!cell.draped || reExag || now - cell.draped > 6000) { this.drape(cell); budget--; }
    }
  }
}
