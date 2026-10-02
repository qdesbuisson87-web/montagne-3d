// Glaciers from IGN BD TOPO ("plan_d_eau" of nature "Glacier, névé": the real outlines, named). They are not
// drawn as such: their polygons are painted from above into the relief's light maps (shadows.js, a mask per
// cascade), and the terrain shader turns the photo inside them into ice where it is not covered by snow:
// blue-grey bare ice, deep blue crevasses, a sheen in the sun.
import * as THREE from 'three';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610021825';
import { cachedFetch } from './net.js?v=202610021825';

const CELL = 0.1; // degrees (≈ 8 × 11 km): few requests, a massif's glaciers in a handful of cells
const WFS = (s, w, n, e) => 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:plan_d_eau&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=2000'
  + '&CQL_FILTER=' + encodeURIComponent(`nature='Glacier, névé' AND BBOX(geometrie,${w},${s},${e},${n},'EPSG:4326')`);

export class Glaciers {
  constructor() {
    this.group = new THREE.Group(); // painted into the masks only, never added to the scene
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.cells = new Set(); this.ids = new Set(); this.version = 0; this.count = 0;
  }
  // fetch the glaciers of the cells around a point (once per cell; kept for offline use)
  ensure(x, z, radius = 15000) {
    const [lon, lat] = worldToLonLat(x, z), dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue; this.cells.add(key);
      cachedFetch(WFS(a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL)).then(r => r.ok ? r.json() : null).then(j => {
        if (!j) { this.cells.delete(key); return; }
        let added = 0;
        for (const f of j.features ?? []) if (!this.ids.has(f.properties.cleabs)) { this.ids.add(f.properties.cleabs); if (this.add(f)) added++; }
        if (added) this.version++;
      }).catch(() => this.cells.delete(key)); // no answer: asked again later
    }
  }
  add(f) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    const pos = [], idx = [];
    for (const poly of polys) {
      const ring = r => r.map(([lon, lat]) => { const [x, z] = lonLatToWorld(lon, lat); return new THREE.Vector2(x, z); });
      const contour = ring(poly[0]), holes = poly.slice(1).map(ring), base = pos.length / 3;
      if (contour.length < 3) continue;
      const tri = THREE.ShapeUtils.triangulateShape(contour, holes);
      [...contour, ...holes.flat()].forEach(v => pos.push(v.x, 0, v.y));
      tri.forEach(t => idx.push(base + t[0], base + t[1], base + t[2]));
    }
    if (!idx.length) return false;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material); m.frustumCulled = false; this.group.add(m); this.count++;
    return true;
  }
}
