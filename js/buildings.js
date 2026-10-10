// 3D buildings from IGN BD TOPO (WFS "batiment"): real footprints, the measured ground altitude, eave and ridge
// altitudes. Walls rise from the lowest ground to the eaves; the roof goes up to the ridge, as a gable along
// the long side for rectangular footprints (most chalets), a hip towards the middle otherwise.
// Fetched by cells of ≈ 1 km around the view, one merged mesh per cell.
import * as THREE from 'three';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610101118';
import { cachedFetch } from './net.js?v=202610101118';

const CELL = 0.01, RANGE = 2600, SHOW = 5000; // degrees; metres around the view to fetch; metres to draw
const WFS = (s, w, n, e) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=5000&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;

const VS = `
uniform float exag; attribute vec3 color; varying vec3 vW, vN, vC;
void main(){ vec3 p = position; p.y *= exag; vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz; vN = normal; vC = color; gl_Position = projectionMatrix * viewMatrix * w; }`;

// smallest-area rectangle around a footprint (rotating the hull's edges): axis, half sizes, centre
function orientedBox(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of pts) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  return best;
}
const ringArea = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

export class Buildings {
  constructor({ scene, uniforms, sceneGLSL }) {
    this.group = new THREE.Group(); scene.add(this.group);
    this.cells = new Map(); this.on = true;
    this.material = new THREE.ShaderMaterial({
      uniforms, vertexShader: VS, side: THREE.DoubleSide, // footprints come in either winding
      fragmentShader: `${sceneGLSL}
        uniform float night;
        varying vec3 vW, vN, vC;
        float hashCell(vec2 p){ uvec2 q = uvec2(ivec2(p) + 1048576); uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u); h = (h ^ (h >> 16)) * 2246822519u; h ^= h >> 13; return float(h) * (1.0 / 4294967295.0); }
        void main(){
          vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0), alb = pow(vC, vec3(2.2)), col;
          if (light < 0.5) { const vec3 PL = vec3(0.196, 0.819, 0.539); col = alb * (0.5 + 0.65 * max(dot(n, PL), 0.0)); }
          else { float sh = shOn > 0.5 ? sunShadow(vW) : 1.0; col = alb * 1.2 * (sunCol * max(dot(n, sunDir), 0.0) * sh + skyCol * 0.5 * (0.6 + 0.4 * n.y) * skyVis(vW)); }
          // at night, windows: on the walls, one every 2.6 m along the wall and every 2.9 m up (a storey), about a
          // third of them lit, in warm light of slightly varying colour
          if (night > 0.01 && abs(n.y) < 0.3) {
            float along = dot(vW.xz, normalize(vec2(-n.z, n.x))), up = vW.y / exag;
            vec2 cell = floor(vec2(along / 2.6, up / 2.9)), f = fract(vec2(along / 2.6, up / 2.9));
            float win = step(0.3, f.x) * step(f.x, 0.72) * step(0.32, f.y) * step(f.y, 0.78);
            float h = hashCell(cell + floor(vW.xz / 40.0) * 131.0);
            vec3 lamp = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.82, 0.55), fract(h * 7.3));
            col += lamp * win * step(0.66, h) * night * 1.6;
          }
          gl_FragColor = vec4(pow(max(aerial(col, vW), 0.0), vec3(1.0/2.2)), 1.0);
        }`
    });
  }

  ensure(x, z) {
    const [lon, lat] = worldToLonLat(x, z), dLat = RANGE / 111000, dLon = RANGE / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue;
      const cell = { mesh: null, cx: 0, cz: 0 }; this.cells.set(key, cell);
      [cell.cx, cell.cz] = lonLatToWorld((b + 0.5) * CELL, (a + 0.5) * CELL);
      cachedFetch(WFS(a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL)).then(r => r.ok ? r.json() : null)
        .then(j => { if (j && this.cells.get(key) === cell) this.build(cell, j.features, [b * CELL, a * CELL]); })
        .catch(() => this.cells.delete(key)); // try again later
    }
  }

  // corner: [lon, lat] of the cell's south-west corner
  build(cell, features, corner) {
    const pos = [], nor = [], col = [];
    const tri = (a, b, c, color) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const p of [a, b, c]) { pos.push(p[0] - cell.cx, p[1], p[2] - cell.cz); nor.push(nx, ny, nz); col.push(...color); }
    };
    for (const f of features) {
      const p = f.properties;
      // a building on a cell border is returned for both cells: it belongs to the cell holding its first corner
      const first = (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0])[0][0];
      if (first[0] < corner[0] || first[0] >= corner[0] + CELL || first[1] < corner[1] || first[1] >= corner[1] + CELL) continue;
      const ground = p.altitude_minimale_sol, eave = p.altitude_minimale_toit ?? (ground != null && p.hauteur ? ground + p.hauteur : null);
      if (ground == null || eave == null) continue;
      const ridge = Math.max(eave, p.altitude_maximale_toit ?? eave), base = ground - 1.5; // walls go into the slope
      const light = !!p.construction_legere, wood = /bois/i.test(p.materiaux_des_murs ?? '') || (p.usage_1 === 'Résidentiel' && (p.nombre_d_etages ?? 3) <= 3);
      const rnd = (parseInt(String(p.cleabs).slice(-4), 36) % 100) / 100;
      const wall = light ? [0.55, 0.55, 0.52] : wood ? [0.36 + rnd * 0.07, 0.28 + rnd * 0.05, 0.21 + rnd * 0.03] : [0.72 + rnd * 0.08, 0.69 + rnd * 0.06, 0.62];
      const roof = [0.24 + rnd * 0.1, 0.23 + rnd * 0.08, 0.23 + rnd * 0.06];
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        let ring = poly[0].map(([lon, lat]) => lonLatToWorld(lon, lat));
        if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
        if (ring.length < 3) continue;
        if (ringArea(ring) < 0) ring.reverse(); // counter-clockwise in (x, z): walls face outwards
        // walls
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          tri([a[0], base, a[1]], [b[0], base, b[1]], [b[0], eave, b[1]], wall);
          tri([a[0], base, a[1]], [b[0], eave, b[1]], [a[0], eave, a[1]], wall);
        }
        const area = Math.abs(ringArea(ring)), box = orientedBox(ring);
        if (ridge - eave < 0.5 || !box) { // flat roof
          THREE.ShapeUtils.triangulateShape(ring.map(q => new THREE.Vector2(q[0], q[1])), []).forEach(t => tri(...[t[0], t[2], t[1]].map(k => [ring[k][0], eave, ring[k][1]]), roof));
          continue;
        }
        const { ux, uy, u0, u1, v0, v1 } = box, rect = area / box.area > 0.85;
        const at = (u, v) => [u * ux - v * uy, u * uy + v * ux];
        const long = (u1 - u0) >= (v1 - v0), um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
        if (rect) { // gable along the long side, over the footprint's rectangle
          const c = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
          const r0 = long ? at(u0, vm) : at(um, v0), r1 = long ? at(u1, vm) : at(um, v1);
          const E = q => [q[0], eave, q[1]], R = q => [q[0], ridge, q[1]];
          if (long) {
            tri(E(c[0]), R(r1), E(c[1]), roof); tri(E(c[0]), R(r0), R(r1), roof);
            tri(E(c[2]), R(r0), E(c[3]), roof); tri(E(c[2]), R(r1), R(r0), roof);
            tri(E(c[1]), R(r1), E(c[2]), wall); tri(E(c[3]), R(r0), E(c[0]), wall); // gable ends
          } else {
            tri(E(c[1]), R(r1), E(c[2]), roof); tri(E(c[1]), R(r0), R(r1), roof);
            tri(E(c[3]), R(r0), E(c[0]), roof); tri(E(c[3]), R(r1), R(r0), roof);
            tri(E(c[0]), R(r0), E(c[1]), wall); tri(E(c[2]), R(r1), E(c[3]), wall);
          }
        } else { // hip: every eave edge rises to the middle of the footprint
          const m = at(um, vm);
          for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; tri([a[0], eave, a[1]], [m[0], ridge, m[1]], [b[0], eave, b[1]], roof); }
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere(); g.boundingSphere.radius += 3000; // heights are exaggerated in the shader
    const m = new THREE.Mesh(g, this.material); m.position.set(cell.cx, 0, cell.cz); this.group.add(m); cell.mesh = m;
  }

  // masked(x, z): places drawn by the LiDAR points, where the real buildings are already there
  update(camera, target, frameN, hidden, masked) {
    this.group.visible = this.on && !hidden; if (!this.group.visible) return;
    if (frameN % 45 === 0) this.ensure(target.x, target.z);
    const c = camera.position;
    for (const [key, cell] of this.cells) {
      const d = Math.hypot(cell.cx - c.x, cell.cz - c.z);
      if (cell.mesh) cell.mesh.visible = d < SHOW && !masked?.(cell.cx, cell.cz);
      if (d > SHOW * 3 && cell.mesh) { this.group.remove(cell.mesh); cell.mesh.geometry.dispose(); this.cells.delete(key); } // far behind: free it
    }
  }
}
