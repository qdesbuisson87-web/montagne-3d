// Footpaths, lifts and mountain huts from IGN BD TOPO (WFS Géoplateforme), fetched by cells of ≈ 4 km around
// the view (cached for offline use) and laid on the relief. Paths drawn as on IGN maps (red for footpaths,
// brown for tracks); lifts hang between their stations; huts become small labels.
// (OpenStreetMap's Overpass servers were tried first: unreachable from here, so the official IGN data is used.)
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610091553';
import { cachedFetch } from './net.js?v=202610091553';

const CELL = 0.04, RANGE = 5000, SHOW = 6500; // metres: fat lines cost on phones, the far ones were barely visible
const WFS = (layer, cql, [s, w, n, e]) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${layer}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=5000`
  // in a CQL filter the box is lon/lat ('EPSG:4326'); in the BBOX parameter with the URN it is lat/lon
  + (cql ? `&CQL_FILTER=${encodeURIComponent(`${cql} AND BBOX(geometrie,${w},${s},${e},${n},'EPSG:4326')`)}` : `&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`);
// kind -> [colour, width in px, height above ground (m)]
// grid of path segments, squares of G metres, for distance queries; NEAR: farther than this is "off the paths"
const G = 100, NEAR = 150;
function gridOf(ways) {
  const grid = new Map();
  for (const w of ways) {
    if (w.kind === 'lift') continue;
    for (let i = 1; i < w.pts.length; i++) {
      const [ax, az] = w.pts[i - 1], [bx, bz] = w.pts[i], s = [ax, az, bx, bz];
      const x0 = Math.floor(Math.min(ax, bx) / G), x1 = Math.floor(Math.max(ax, bx) / G), z0 = Math.floor(Math.min(az, bz) / G), z1 = Math.floor(Math.max(az, bz) / G);
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) { const k = `${gx},${gz}`; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(s); }
    }
  }
  return grid;
}
const STYLE = { path: [0xe0261b, 2.6, 1.2], track: [0x8a5a2b, 2.4, 1.0], lift: [0x202428, 2.0, 14] };

export class TrailsLayer {
  constructor({ scene, groundAt, onHuts }) {
    this.group = new THREE.Group(); scene.add(this.group); this.groundAt = groundAt; this.onHuts = onHuts;
    this.cells = new Map(); this.on = true; this.exag = 1;
    this.mats = Object.fromEntries(Object.entries(STYLE).map(([k, [c, w]]) => [k, new LineMaterial({ color: c, linewidth: w, transparent: true, opacity: 0.95 })]));
  }
  setResolution(w, h) { for (const m of Object.values(this.mats)) m.resolution.set(w, h); }

  // returns a promise settled when the cells around the point have answered (or failed)
  ensure(x, z) {
    const [lon, lat] = worldToLonLat(x, z), dLat = RANGE / 111000, dLon = RANGE / (111000 * Math.cos(lat * Math.PI / 180)), waits = [];
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) { waits.push(this.cells.get(key).done); continue; }
      const cell = { ways: null, meshes: [], draped: 0 }; this.cells.set(key, cell);
      [cell.cx, cell.cz] = lonLatToWorld((b + 0.5) * CELL, (a + 0.5) * CELL);
      const box = [a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL], json = u => cachedFetch(u).then(r => r.ok ? r.json() : null);
      cell.done = Promise.all([
        json(WFS('BDTOPO_V3:troncon_de_route', "nature IN ('Sentier','Chemin')", box)),
        json(WFS('BDTOPO_V3:transport_par_cable', null, box)),
        json(WFS('BDTOPO_V3:zone_d_activite_ou_d_interet', "nature IN ('Refuge','Abri de montagne')", box))
      ]).then(([roads, lifts, zones]) => {
        if (this.cells.get(key) !== cell) return;
        if (!roads && !lifts) { this.cells.delete(key); return; } // no answer: try again later
        // lifts keep their kind and the altitudes of their points (−1000 in BD TOPO where unknown)
        const lines = (f, kind) => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]).map(l => ({
          kind, name: f.properties.toponyme || f.properties.nature || null, nature: f.properties.nature, pts: l.map(([lon, lat]) => lonLatToWorld(lon, lat)),
          zs: kind === 'lift' ? l.map(c => c[2] > -500 ? c[2] : null) : null
        }));
        cell.ways = [
          ...(roads?.features ?? []).flatMap(f => lines(f, f.properties.nature === 'Chemin' ? 'track' : 'path')),
          ...(lifts?.features ?? []).flatMap(f => lines(f, 'lift'))
        ].filter(w => w.pts.length > 1);
        cell.grid = gridOf(cell.ways);
        const huts = (zones?.features ?? []).filter(f => f.properties.toponyme).map(f => {
          const ring = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : [f.geometry.coordinates]);
          const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length, lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          return { id: f.properties.cleabs, name: f.properties.toponyme, lon, lat, alt: null };
        });
        if (huts.length) this.onHuts?.(huts);
      }).catch(() => this.cells.delete(key));
      waits.push(cell.done);
    }
    return Promise.all(waits.map(p => p?.catch(() => { })));
  }
  // ----- where the paths are (to tell walking from off-path, mountaineering or a lift) -----
  cellOf(x, z) { const [lon, lat] = worldToLonLat(x, z); return this.cells.get(`${Math.floor(lat / CELL)}/${Math.floor(lon / CELL)}`); }
  // distance (m) from a point to the nearest footpath or track: up to NEAR, Infinity beyond, null where the paths
  // of that place are not loaded yet
  pathDist(x, z) {
    const cell = this.cellOf(x, z); if (!cell?.grid) return null;
    let best = Infinity; const gx = Math.floor(x / G), gz = Math.floor(z / G);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) for (const s of this.segsAt(gx + i, gz + j, x, z)) {
      const [ax, az, bx, bz] = s, dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
    return best <= NEAR ? best : Infinity;
  }
  // the segments of a grid square, whatever cell they were filed in (a path crosses cell borders)
  segsAt(gx, gz, x, z) {
    const out = [], key = `${gx},${gz}`;
    for (const c of this.cellsAround(x, z)) { const l = c.grid?.get(key); if (l) out.push(...l); }
    return out;
  }
  cellsAround(x, z) {
    const [lon, lat] = worldToLonLat(x, z), a = Math.floor(lat / CELL), b = Math.floor(lon / CELL), out = [];
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const c = this.cells.get(`${a + j}/${b + i}`); if (c) out.push(c); }
    return out;
  }
  // every path and track loaded, once each (a way crossing a cell border comes with both cells)
  ways() {
    const out = [], seen = new Set();
    for (const c of this.cells.values()) for (const w of c.ways ?? []) {
      if (w.kind === 'lift') continue;
      const a = w.pts[0], b = w.pts[w.pts.length - 1], k = `${a[0].toFixed(1)},${a[1].toFixed(1)},${b[0].toFixed(1)},${b[1].toFixed(1)},${w.pts.length}`;
      if (!seen.has(k)) { seen.add(k); out.push(w); }
    }
    return out;
  }
  // the lifts loaded: name, kind (BD TOPO nature), both ends and the whole line (scene metres), altitudes of its
  // points when known. A lift crossing a cell border is in both cells: kept once.
  lifts() {
    const out = [], seen = new Set();
    for (const c of this.cells.values()) for (const w of c.ways ?? []) {
      if (w.kind !== 'lift') continue;
      const a = w.pts[0], b = w.pts[w.pts.length - 1], k = `${Math.round(a[0])},${Math.round(a[1])},${Math.round(b[0])},${Math.round(b[1])}`;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ name: w.name, nature: w.nature, a, b, pts: w.pts, zs: w.zs });
    }
    return out;
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
    // cells far behind are freed (graphics memory would otherwise grow all along a long trip); back there, they
    // come again from the device's cache
    if (frameN % 300 === 150) for (const [k, cell] of this.cells) if (Math.hypot(cell.cx - c.x, cell.cz - c.z) > 25000) { cell.meshes.forEach(m => { this.group.remove(m); m.geometry.dispose(); }); this.cells.delete(k); }
    let budget = 1; // one cell re-laid per frame at most: no stutter
    for (const cell of this.cells.values()) {
      const vis = Math.hypot(cell.cx - c.x, cell.cz - c.z) < SHOW;
      cell.meshes.forEach(m => { m.visible = vis; });
      if (!cell.ways || !vis || budget <= 0) continue;
      if (!cell.draped || reExag || now - cell.draped > 6000) { this.drape(cell); budget--; }
    }
  }
}
