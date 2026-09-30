// 3D forests from the IGN vegetation height model (LiDAR HD MNH: canopy height above the ground, ~0.5 m).
// For every zoom-16 tile (≈ 425 m) near the camera the model is fetched once (256 × 256 samples, ≈ 1.7 m),
// every tree top is found (a local maximum above 3 m with a real crown around it), and a conifer is planted
// there at its measured height, coloured by the aerial photo under it. Instanced: one draw per tile.
// What the canopy model also contains and must not become trees: cable-car cables (thin lines, no crown),
// flat roofs (no peak), and anything above 50 m.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tileMerc, mercToLonLat, lonLatToL93, l93ToLonLat, lonLatToWorld } from './geo.js?v=202609301758';
import { cachedFetch, TransientError } from './net.js?v=202609301758';

const MNH = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93';
const Z = 16, RES = 256, NEAR = 700; // metres: beyond, the simple tree

// unit tree (1 m tall), attribute "part": 0 trunk, 1 foliage
function tree(detailed) {
  const parts = [];
  const add = (g, part, y) => { g.translate(0, y, 0); g.deleteAttribute('uv'); g.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(part), 1)); parts.push(g); };
  if (detailed) {
    add(new THREE.CylinderGeometry(0.025, 0.04, 0.3, 5, 1, true), 0, 0.15);
    [[0.36, 0.46, 0.14], [0.28, 0.38, 0.38], [0.18, 0.34, 0.62]].forEach(([r, h, y]) => add(new THREE.ConeGeometry(r, h, 7, 1, true), 1, y + h / 2));
  } else add(new THREE.ConeGeometry(0.3, 0.9, 5, 1, true), 1, 0.1 + 0.45);
  return mergeGeometries(parts);
}

const VS = `
attribute vec3 aPos; attribute vec2 aSize; attribute vec2 aUv; attribute float aRnd; attribute float part;
uniform sampler2D map; uniform float exag, fadeFar;
varying vec3 vW, vN, vCol; varying float vPart, vUp, vRnd;
void main(){
  float a = aRnd * 6.2831853, c = cos(a), s = sin(a);
  vec3 p = position, n = normal;
  p.xz = mat2(c, -s, s, c) * p.xz; n.xz = mat2(c, -s, s, c) * n.xz;
  vec3 base = vec3(aPos.x, aPos.y * exag - 1.0, aPos.z);        // 1 m into the ground: never floating
  float g = 1.0 - smoothstep(fadeFar * 0.75, fadeFar, length(cameraPosition - base)); // grow in, no popping
  vec3 w = base + vec3(p.x * aSize.y, p.y * aSize.x, p.z * aSize.y) * g;
  vW = w; vN = n; vPart = part; vUp = p.y; vRnd = aRnd;
  vCol = textureLod(map, aUv, 1.0).rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

export class Forest {
  // sceneGLSL: the shared light/air shader chunk (sunShadow, aerial…); uniforms: the shared uniform object
  constructor({ scene, engine, uniforms, sceneGLSL }) {
    this.engine = engine; this.uniforms = uniforms; this.maxTrees = 40000;
    this.group = new THREE.Group(); scene.add(this.group);
    this.geo = [tree(true), tree(false)];
    this.fadeFar = { value: 2000 };
    this.fs = `${sceneGLSL}
      varying vec3 vW, vN, vCol; varying float vPart, vUp, vRnd;
      void main(){
        vec3 n = normalize(vN), photo = pow(vCol, vec3(2.2));
        // needles: the canopy colour of the photo, darker inside the crown and towards the bottom
        vec3 alb = vPart < 0.5 ? vec3(0.07, 0.05, 0.035) : mix(photo, vec3(0.035, 0.07, 0.035), 0.3) * (0.55 + 0.55 * vUp) * (0.85 + 0.3 * vRnd);
        vec3 col;
        if (light < 0.5) { const vec3 PL = vec3(0.196, 0.819, 0.539); col = alb * (0.6 + 0.6 * max(dot(n, PL), 0.0)); }
        else {
          float sh = shOn > 0.5 ? sunShadow(vW) : 1.0;
          col = alb * 1.3 * (sunCol * max(dot(n, sunDir), 0.0) * sh + skyCol * 0.5 * (0.6 + 0.4 * n.y));
        }
        gl_FragColor = vec4(pow(max(aerial(col, vW), 0.0), vec3(1.0/2.2)), 1.0);
      }`;
    this.tiles = new Map(); // tile -> { meshes:[near, far], count, state }
    engine.onTileBuilt = t => { if (t.z === Z) this.load(t); };
    engine.onTileDisposed = t => { if (t.z === Z) this.drop(t); };
  }

  async load(t) {
    const entry = { state: 'loading', meshes: null, count: 0 }; this.tiles.set(t, entry);
    let trees;
    try { trees = await this.detect(t); }
    catch (e) { if (this.tiles.get(t) === entry) this.tiles.delete(t); if (e instanceof TransientError) setTimeout(() => { if (t.state === 'ready' && !this.tiles.has(t)) this.load(t); }, 8000); return; }
    if (this.tiles.get(t) !== entry || t.state !== 'ready') return;
    entry.count = trees.length; entry.state = 'ready';
    if (!trees.length) return;
    const n = trees.length, pos = new Float32Array(n * 3), size = new Float32Array(n * 2), uv = new Float32Array(n * 2), rnd = new Float32Array(n);
    trees.forEach((tr, i) => { pos.set([tr.x, tr.base, tr.z], i * 3); size.set([tr.h, tr.r], i * 2); uv.set([tr.u, tr.v], i * 2); rnd[i] = tr.rnd; });
    const attrs = { aPos: new THREE.InstancedBufferAttribute(pos, 3), aSize: new THREE.InstancedBufferAttribute(size, 2), aUv: new THREE.InstancedBufferAttribute(uv, 2), aRnd: new THREE.InstancedBufferAttribute(rnd, 1) };
    const mat = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, map: { value: t.mesh.material.uniforms.map.value }, fadeFar: this.fadeFar }, vertexShader: VS, fragmentShader: this.fs });
    const cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2, sphere = new THREE.Sphere(new THREE.Vector3(cx, (t.minH + t.maxH) / 2, cz), t.size + 60);
    entry.meshes = this.geo.map(base => {
      const g = new THREE.InstancedBufferGeometry();
      g.setIndex(base.index); for (const k of ['position', 'normal', 'part']) g.setAttribute(k, base.attributes[k]);
      for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
      g.instanceCount = n; g.boundingSphere = sphere;
      const m = new THREE.Mesh(g, mat); m.visible = false; this.group.add(m); return m;
    });
    entry.center = [cx, cz];
  }
  drop(t) {
    const e = this.tiles.get(t); if (!e) return; this.tiles.delete(t);
    e.meshes?.forEach((m, i) => {
      this.group.remove(m);
      // the unit tree's buffers are shared by every tile: detach them so only this tile's instances are freed
      const g = m.geometry; g.setIndex(null); for (const k of ['position', 'normal', 'part']) g.deleteAttribute(k);
      g.dispose(); if (i === 0) m.material.dispose();
    });
  }

  // tree tops of one tile, from the canopy height model
  async detect(t) {
    const m = tileMerc(t.z, t.x, t.y), corners = [[m.minx, m.miny], [m.maxx, m.miny], [m.minx, m.maxy], [m.maxx, m.maxy]].map(([a, b]) => lonLatToL93(...mercToLonLat(a, b)));
    const bx0 = Math.min(...corners.map(c => c[0])) - 4, bx1 = Math.max(...corners.map(c => c[0])) + 4, by0 = Math.min(...corners.map(c => c[1])) - 4, by1 = Math.max(...corners.map(c => c[1])) + 4;
    const url = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${MNH}&STYLES=&CRS=EPSG:2154&BBOX=${[bx0, by0, bx1, by1].join(',')}&WIDTH=${RES}&HEIGHT=${RES}&FORMAT=image/x-bil;bits=32`;
    const r = await cachedFetch(url);
    if (!r.ok) return []; // outside the LiDAR coverage (Italy, Switzerland): no model, no trees
    const buf = await r.arrayBuffer(); if (buf.byteLength !== RES * RES * 4) return [];
    const v = new Float32Array(buf), rx = (bx1 - bx0) / RES, ry = (by1 - by0) / RES, out = [];
    for (let k = 0; k < v.length; k++) if (!(v[k] > 0 && v[k] < 80)) v[k] = 0; // no-data and outliers
    for (let j = 2; j < RES - 2; j++) for (let i = 2; i < RES - 2; i++) {
      const k = j * RES + i, h = v[k];
      if (h < 3 || h > 50) continue;
      let top = true;
      for (let dj = -2; dj <= 2 && top; dj++) for (let di = -2; di <= 2; di++) {
        if (!di && !dj) continue; const q = v[k + dj * RES + di];
        if (q > h || (q === h && dj * RES + di < 0)) { top = false; break; }
      }
      if (!top) continue;
      // a crown: most of the 8 neighbours are well above the ground (a cable or a thin pole is not)
      let crown = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && v[k + dj * RES + di] > h * 0.55) crown++;
      if (crown < 6) continue;
      // a peak: the crown drops away 3 samples out (a flat roof does not)
      const ring = (v[k - 3] + v[k + 3] + v[k - 3 * RES] + v[k + 3 * RES]) / 4;
      if (h - ring < 1.2) continue;
      const [lon, lat] = l93ToLonLat(bx0 + (i + 0.5) * rx, by1 - (j + 0.5) * ry), [x, z] = lonLatToWorld(lon, lat);
      if (x < t.x0 || x >= t.x1 || z < t.z0 || z >= t.z1) continue; // each tree belongs to one tile only
      // no trees above the Alpine tree line: what stands up there (summit stations, huts, pylons) is not forest
      const ground = t.heightAt(x, z); if (ground > 2500) continue;
      const rnd = Math.abs(((i + t.x * 977) * 73856093 ^ (j + t.y * 991) * 19349663) % 1000) / 1000; // stable per tree
      // r: horizontal scale of the unit tree (lower crown radius 0.36): crown radius ≈ 0.14 × height + 1 m
      out.push({ x, z, base: ground, h, r: (0.14 * h + 1.0 + rnd * 0.6) / 0.36, u: (x - t.x0) / t.size, v: (z - t.z0) / (t.z1 - t.z0), rnd });
    }
    return out;
  }

  // every frame: show the forests of the tiles drawn at zoom 16 or finer, nearest first, within the budget
  update(camera, hidden) {
    this.group.visible = !hidden; if (hidden) return;
    const shown = new Set();
    for (const mesh of this.engine.drawn) { let t = mesh.userData.tile; while (t && t.z > Z) t = t.parent; if (t?.z === Z) shown.add(t); }
    const cam = camera.position, list = [];
    for (const [t, e] of this.tiles) {
      if (!e.meshes) continue;
      e.meshes[0].visible = e.meshes[1].visible = false;
      if (shown.has(t)) list.push([Math.hypot(e.center[0] - cam.x, e.center[1] - cam.z), e]);
    }
    list.sort((a, b) => a[0] - b[0]);
    let budget = this.maxTrees;
    for (const [d, e] of list) { if (budget <= 0) break; budget -= e.count; e.meshes[d < NEAR ? 0 : 1].visible = true; }
    // trees shrink away where zoom-16 tiles stop being drawn (a zoom-15 tile splits within size × splitK)
    this.fadeFar.value = 850 * this.engine.splitK * 1.05;
  }
  get treeCount() { let n = 0; for (const e of this.tiles.values()) if (e.meshes?.[0].visible || e.meshes?.[1].visible) n += e.count; return n; }
}
