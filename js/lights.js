// Lights at night, under the "real sun" light once the sun has set: one warm point per dwelling of every IGN
// BD TOPO building (usage and number of dwellings), a few for each mountain hut. Drawn as glowing points that
// the final image pass makes shine; near the eye (where buildings stand in 3D) they fade out and the lit
// windows of buildings.js take over. Fetched only at night, by cells of ≈ 3 × 4.5 km, kept for offline use.
import * as THREE from 'three';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610021731';
import { cachedFetch } from './net.js?v=202610021731';

const CELL = 0.04, RANGE = 15000;
const WFS = (s, w, n, e) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=10000&PROPERTYNAME=geometrie,usage_1,nombre_de_logements&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
// stable pseudo-random numbers per building
const rnd = (a, b) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export class NightLights {
  constructor({ scene, groundAt, renderer }) {
    this.groundAt = groundAt; this.renderer = renderer; this.cells = new Map(); this.huts = null; this.exag = 1;
    this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    this.u = { night: { value: 0 }, px: { value: 2 }, exag: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float px, exag, night; attribute vec4 tint; varying vec3 vC; varying float vA;
        void main(){
          vec4 w = modelMatrix * vec4(position.x, position.y * exag, position.z, 1.0);
          float d = length(cameraPosition - w.xyz);
          // near the eye the buildings' own windows are lit instead; far away the air dims the lights
          vA = night * smoothstep(3000.0, 4500.0, d) * exp(-d * 0.000012) * tint.a;
          vC = tint.rgb;
          vec4 mv = viewMatrix * w; gl_Position = projectionMatrix * mv;
          gl_PointSize = px * (0.8 + 0.4 * tint.a);
        }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float r = dot(c, c) * 4.0; if (r > 1.0) discard;
          gl_FragColor = vec4(vC * vA * (1.0 - r) * 2.2, 1.0); }` // brighter than white: they glow in the final pass
    });
  }

  ensure(x, z) {
    const [lon, lat] = worldToLonLat(x, z), dLat = RANGE / 111000, dLon = RANGE / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue;
      const cell = { pts: null, mesh: null, draped: 0 }; this.cells.set(key, cell);
      cachedFetch(WFS(a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL)).then(r => r.ok ? r.json() : null).then(j => {
        if (!j) { this.cells.delete(key); return; }
        cell.pts = [];
        for (const f of j.features) {
          const p = f.properties, use = p.usage_1 ?? '', homes = p.nombre_de_logements || 0;
          if (/Annexe|Agricole|Industriel/.test(use)) continue; // barns, sheds, workshops stay dark at night
          const g = f.geometry, ring = g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.coordinates[0];
          const lon0 = ring.reduce((s, q) => s + q[0], 0) / ring.length, lat0 = ring.reduce((s, q) => s + q[1], 0) / ring.length;
          const [cx, cz] = lonLatToWorld(lon0, lat0), seed = Math.round(cx * 7) ^ Math.round(cz * 13);
          // lit at this hour: most homes and shops, some of the rest (second homes, offices)
          const n = homes ? Math.min(6, Math.ceil(homes * 0.6)) : use === 'Commercial et services' ? 2 : rnd(seed, 1) < 0.35 ? 1 : 0;
          for (let k = 0; k < n; k++) {
            if (homes && rnd(seed, k + 7) > 0.75) continue;
            const warm = rnd(seed, k + 31); // most lights warm (2 700 K), a few cold white (LED, street lamps)
            cell.pts.push({ x: cx + (rnd(seed, k + 3) - 0.5) * 8, z: cz + (rnd(seed, k + 5) - 0.5) * 8, up: 2 + rnd(seed, k + 9) * 5,
              c: warm < 0.8 ? [1.0, 0.68, 0.36] : [0.85, 0.9, 1.0], a: 0.6 + 0.4 * rnd(seed, k + 11) });
          }
        }
      }).catch(() => this.cells.delete(key));
    }
  }
  // the mountain huts (from trails.js): a few lights each, they are lit in season
  setHuts(huts) { this.huts = { pts: huts.flatMap((h, i) => [0, 1, 2].map(k => ({ x: h.x + (rnd(i, k) - 0.5) * 10, z: h.z + (rnd(i, k + 3) - 0.5) * 10, up: 3, c: [1.0, 0.7, 0.4], a: 0.9 }))), mesh: null, draped: 0 }; }

  // lay a cell's lights on the relief (again when finer relief has arrived): points whose ground is not
  // loaded yet wait for the next pass
  drape(cell) {
    const pos = [], tint = [];
    for (const p of cell.pts) { const g = this.groundAt(p.x, p.z); if (g == null) continue; pos.push(p.x, g + p.up, p.z); tint.push(...p.c, p.a); }
    if (cell.mesh) { this.group.remove(cell.mesh); cell.mesh.geometry.dispose(); cell.mesh = null; }
    if (pos.length) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 4));
      geo.computeBoundingSphere(); geo.boundingSphere.radius += 3000;
      cell.mesh = new THREE.Points(geo, this.material); this.group.add(cell.mesh);
    }
    cell.draped = performance.now();
  }
  // night: 0 by day, 1 in the night (real-sun light only); hidden: Google view
  update(target, frameN, night, exag, hidden) {
    this.u.night.value = night; this.u.exag.value = exag;
    this.group.visible = night > 0.01 && !hidden; if (!this.group.visible) return;
    this.u.px.value = 2.2 * Math.min(2, this.renderer.getPixelRatio());
    if (frameN % 90 === 0) this.ensure(target.x, target.z);
    const now = performance.now(); let budget = 2; // a couple of cells re-laid per frame at most
    for (const cell of [...this.cells.values(), ...(this.huts ? [this.huts] : [])]) {
      if (!cell.pts || budget <= 0) continue;
      if (!cell.draped || now - cell.draped > 8000) { this.drape(cell); budget--; }
    }
  }
}
