// 3D forests from the IGN vegetation height model (LiDAR HD MNH: canopy height above the ground, ~0.5 m).
// For every zoom-16 tile (≈ 425 m) near the camera the model is fetched once (256 × 256 samples, ≈ 1.7 m),
// every tree top is found (a local maximum above 3 m with a real crown around it), and a tree is planted there
// at its measured height, coloured by the aerial photo under it. Its kind comes from the IGN forest map (BD Forêt,
// foresttypes.js): fir/spruce, pine (incl. arolla), larch, broadleaf, drawn with their own shapes, and the larch
// and broadleaf trees follow the season of the date shown (gold in autumn, bare in winter). Instanced: a few
// draws per tile. What the canopy model also contains and must not become trees: cable-car cables (thin lines,
// no crown), flat roofs (no peak), and anything above 50 m.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tileMerc, mercToLonLat, lonLatToL93, l93ToLonLat, lonLatToWorld } from './geo.js?v=202610042107';
import { cachedFetch, TransientError } from './net.js?v=202610042107';
import { FOREST_WMS, decodeForest } from './foresttypes.js?v=202610042107';

const MNH = 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93';
const Z = 16, RES = 256, NEAR = 700; // metres: beyond, the simple tree
const SPRUCE = 0, PINE = 1, LARCH = 2, BROAD = 3;

// unit trees (1 m tall), attribute "part": 0 trunk, 1 foliage
function conifer(detailed) {
  const parts = [];
  const add = (g, part, y) => { g.translate(0, y, 0); g.deleteAttribute('uv'); g.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(part), 1)); parts.push(g); };
  if (detailed) {
    add(new THREE.CylinderGeometry(0.025, 0.04, 0.3, 5, 1, true), 0, 0.15);
    [[0.36, 0.46, 0.14], [0.28, 0.38, 0.38], [0.18, 0.34, 0.62]].forEach(([r, h, y]) => add(new THREE.ConeGeometry(r, h, 7, 1, true), 1, y + h / 2));
  } else add(new THREE.ConeGeometry(0.3, 0.9, 5, 1, true), 1, 0.1 + 0.45);
  return mergeGeometries(parts);
}
// broadleaf: a trunk to about a third, then a round, slightly flattened crown
function broadleaf(detailed) {
  const parts = [];
  // all parts without index (the icosahedra have none): merging indexed and non-indexed parts fails
  const add = (g, part) => { if (g.index) g = g.toNonIndexed(); g.deleteAttribute('uv'); g.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(part), 1)); parts.push(g); };
  const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.45, 5, 1, true); trunk.translate(0, 0.225, 0); add(trunk, 0);
  if (detailed) {
    [[0, 0.66, 0, 0.36], [0.13, 0.58, 0.08, 0.24], [-0.12, 0.6, -0.07, 0.24], [0.02, 0.8, -0.1, 0.2]].forEach(([x, y, z, r]) => {
      const g = new THREE.IcosahedronGeometry(r, 1); g.scale(1, 0.85, 1); g.translate(x, y, z); add(g, 1);
    });
  } else { const g = new THREE.IcosahedronGeometry(0.38, 0); g.scale(1, 0.9, 1); g.translate(0, 0.64, 0); add(g, 1); }
  return mergeGeometries(parts);
}

const VS = `
attribute vec3 aPos; attribute vec2 aSize; attribute vec2 aUv; attribute float aRnd; attribute float aKind; attribute float part;
uniform sampler2D map; uniform float exag, fadeFar;
varying vec3 vW, vN, vCol; varying float vPart, vUp, vRnd, vKind, vAlt;
void main(){
  float a = aRnd * 6.2831853, c = cos(a), s = sin(a);
  vec3 p = position, n = normal;
  p.xz = mat2(c, -s, s, c) * p.xz; n.xz = mat2(c, -s, s, c) * n.xz;
  vec3 base = vec3(aPos.x, aPos.y * exag - 1.0, aPos.z);        // 1 m into the ground: never floating
  float g = 1.0 - smoothstep(fadeFar * 0.75, fadeFar, length(cameraPosition - base)); // grow in, no popping
  vec3 w = base + vec3(p.x * aSize.y, p.y * aSize.x, p.z * aSize.y) * g;
  vW = w; vN = n; vPart = part; vUp = p.y; vRnd = aRnd; vKind = aKind; vAlt = aPos.y;
  vCol = textureLod(map, aUv, 1.0).rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

export class Forest {
  // sceneGLSL: the shared light/air shader chunk (sunShadow, aerial, seasonColour…); uniforms: the shared uniform object
  constructor({ scene, engine, uniforms, sceneGLSL }) {
    this.engine = engine; this.uniforms = uniforms; this.maxTrees = 40000;
    this.group = new THREE.Group(); scene.add(this.group);
    this.geo = [[conifer(true), conifer(false)], [broadleaf(true), broadleaf(false)]]; // [conifers, broadleaf] × [near, far]
    this.fadeFar = { value: 2000 };
    this.fs = `${sceneGLSL}
      varying vec3 vW, vN, vCol; varying float vPart, vUp, vRnd, vKind, vAlt;
      void main(){
        vec3 n = normalize(vN), photo = pow(vCol, vec3(2.2));
        // foliage: the canopy colour of the photo, darker inside the crown and towards the bottom; larch lighter,
        // pine a little greyer; then the season for larch and broadleaf trees
        vec3 leaf = mix(photo, vec3(0.035, 0.07, 0.035), 0.3);
        if (vKind > 1.5 && vKind < 2.5) leaf = mix(leaf, vec3(0.06, 0.1, 0.03), 0.35);
        if (vKind > 0.5 && vKind < 1.5) leaf = mix(leaf, vec3(0.05, 0.065, 0.045), 0.3);
        float lum = dot(leaf, vec3(0.2126, 0.7152, 0.0722));
        if (vKind > 1.5) leaf = seasonColour(leaf, lum, vKind > 2.5 ? 1.0 : 0.0, vKind > 2.5 ? 0.0 : 1.0, vec3(vW.x, vAlt * exag, vW.z));
        vec3 alb = vPart < 0.5 ? vec3(0.07, 0.05, 0.035) : leaf * (0.55 + 0.55 * vUp) * (0.85 + 0.3 * vRnd);
        vec3 col;
        if (light < 0.5) { const vec3 PL = vec3(0.196, 0.819, 0.539); col = alb * (0.6 + 0.6 * max(dot(n, PL), 0.0)); }
        else {
          float sh = shOn > 0.5 ? sunShadow(vW) : 1.0;
          col = alb * 1.3 * (sunCol * max(dot(n, sunDir), 0.0) * sh + skyCol * 0.5 * (0.6 + 0.4 * n.y) * skyVis(vW));
        }
        gl_FragColor = vec4(pow(max(aerial(col, vW), 0.0), vec3(1.0/2.2)), 1.0);
      }`;
    this.tiles = new Map(); // tile -> { groups: [{ meshes:[near, far], count }], count, state }
    engine.onTileBuilt = t => { if (t.z === Z) this.load(t); };
    engine.onTileDisposed = t => { if (t.z === Z) this.drop(t); };
  }

  async load(t) {
    const entry = { state: 'loading', groups: null, count: 0 }; this.tiles.set(t, entry);
    let trees;
    try { trees = await this.detect(t); }
    catch (e) { if (this.tiles.get(t) === entry) this.tiles.delete(t); if (e instanceof TransientError) setTimeout(() => { if (t.state === 'ready' && !this.tiles.has(t)) this.load(t); }, 8000); return; }
    if (this.tiles.get(t) !== entry || t.state !== 'ready') return;
    entry.count = trees.length; entry.state = 'ready';
    if (!trees.length) return;
    const mat = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, map: { value: t.mesh.material.uniforms.map.value }, fadeFar: this.fadeFar }, vertexShader: VS, fragmentShader: this.fs });
    const cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2, sphere = new THREE.Sphere(new THREE.Vector3(cx, (t.minH + t.maxH) / 2, cz), t.size + 60);
    entry.groups = [trees.filter(tr => tr.kind !== BROAD), trees.filter(tr => tr.kind === BROAD)].map((list, gi) => {
      if (!list.length) return null;
      const n = list.length, pos = new Float32Array(n * 3), size = new Float32Array(n * 2), uv = new Float32Array(n * 2), rnd = new Float32Array(n), kind = new Float32Array(n);
      list.forEach((tr, i) => { pos.set([tr.x, tr.base, tr.z], i * 3); size.set([tr.h, tr.r], i * 2); uv.set([tr.u, tr.v], i * 2); rnd[i] = tr.rnd; kind[i] = tr.kind; });
      const attrs = { aPos: new THREE.InstancedBufferAttribute(pos, 3), aSize: new THREE.InstancedBufferAttribute(size, 2), aUv: new THREE.InstancedBufferAttribute(uv, 2), aRnd: new THREE.InstancedBufferAttribute(rnd, 1), aKind: new THREE.InstancedBufferAttribute(kind, 1) };
      const meshes = this.geo[gi].map(base => {
        const g = new THREE.InstancedBufferGeometry();
        g.setIndex(base.index); for (const k of ['position', 'normal', 'part']) g.setAttribute(k, base.attributes[k]);
        for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
        g.instanceCount = n; g.boundingSphere = sphere;
        const m = new THREE.Mesh(g, mat); m.visible = false; this.group.add(m); return m;
      });
      return { meshes, count: n };
    }).filter(Boolean);
    entry.mat = mat; entry.center = [cx, cz];
  }
  drop(t) {
    const e = this.tiles.get(t); if (!e) return; this.tiles.delete(t);
    for (const grp of e.groups ?? []) for (const m of grp.meshes) {
      this.group.remove(m);
      // the unit tree's buffers are shared by every tile: detach them so only this tile's instances are freed
      const g = m.geometry; g.setIndex(null); for (const k of ['position', 'normal', 'part']) g.deleteAttribute(k);
      g.dispose();
    }
    e.mat?.dispose();
  }

  // tree tops of one tile, from the canopy height model; their kind from the forest map
  async detect(t) {
    const m = tileMerc(t.z, t.x, t.y), corners = [[m.minx, m.miny], [m.maxx, m.miny], [m.minx, m.maxy], [m.maxx, m.maxy]].map(([a, b]) => lonLatToL93(...mercToLonLat(a, b)));
    const bx0 = Math.min(...corners.map(c => c[0])) - 4, bx1 = Math.max(...corners.map(c => c[0])) + 4, by0 = Math.min(...corners.map(c => c[1])) - 4, by1 = Math.max(...corners.map(c => c[1])) + 4;
    const url = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${MNH}&STYLES=&CRS=EPSG:2154&BBOX=${[bx0, by0, bx1, by1].join(',')}&WIDTH=${RES}&HEIGHT=${RES}&FORMAT=image/x-bil;bits=32`;
    const [r, kinds] = await Promise.all([cachedFetch(url), this.kinds(m)]);
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
      const u = (x - t.x0) / t.size, vv = (z - t.z0) / (t.z1 - t.z0), kind = this.kindAt(kinds, u, vv, rnd);
      // r: horizontal scale of the unit tree: crown radius ≈ 0.14 × height + 1 m (lower cone 0.36; broadleaf crowns
      // are wider and pines a little rounder)
      const crownR = (0.14 * h + 1.0 + rnd * 0.6) * (kind === BROAD ? 1.45 : kind === PINE ? 1.15 : kind === LARCH ? 0.9 : 1);
      out.push({ x, z, base: ground, h, r: crownR / 0.36, u, v: vv, rnd, kind });
    }
    return out;
  }
  // the forest map over a tile (shares of broadleaf, larch, pine per pixel), or null where IGN has none
  async kinds(m) {
    try {
      const r = await cachedFetch(FOREST_WMS([m.minx, m.miny, m.maxx, m.maxy], 64, 64)); if (!r.ok) return null;
      const bm = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = new OffscreenCanvas(64, 64), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0); bm.close?.();
      return decodeForest(g.getImageData(0, 0, 64, 64).data);
    } catch (e) { if (e instanceof TransientError) throw e; return null; }
  }
  // the kind of one tree: drawn among the shares of its pixel (the same tree always gets the same kind)
  kindAt(d, u, v, rnd) {
    if (!d) return SPRUCE;
    const k = (Math.min(63, Math.floor(v * 64)) * 64 + Math.min(63, Math.floor(u * 64))) * 4;
    if (!d[k + 3]) return SPRUCE;
    const b = d[k] / 255, l = d[k + 1] / 255, p = d[k + 2] / 255, x = (rnd * 7.31) % 1;
    return x < b ? BROAD : x < b + l ? LARCH : x < b + l + p ? PINE : SPRUCE;
  }

  // every frame: show the forests of the tiles drawn at zoom 16 or finer, nearest first, within the budget
  // masked(x, z): places drawn by the LiDAR points, whose trees are the real ones
  update(camera, hidden, masked) {
    this.group.visible = !hidden; if (hidden) return;
    const shown = new Set();
    for (const mesh of this.engine.drawn) { let t = mesh.userData.tile; while (t && t.z > Z) t = t.parent; if (t?.z === Z) shown.add(t); }
    const cam = camera.position, list = [];
    for (const [t, e] of this.tiles) {
      if (!e.groups) continue;
      for (const g of e.groups) g.meshes[0].visible = g.meshes[1].visible = false;
      if (shown.has(t) && !masked?.(...e.center)) list.push([Math.hypot(e.center[0] - cam.x, e.center[1] - cam.z), e]);
    }
    list.sort((a, b) => a[0] - b[0]);
    let budget = this.maxTrees;
    for (const [d, e] of list) { if (budget <= 0) break; budget -= e.count; for (const g of e.groups) g.meshes[d < NEAR ? 0 : 1].visible = true; }
    // trees shrink away where zoom-16 tiles stop being drawn (a zoom-15 tile splits within size × splitK)
    this.fadeFar.value = 850 * this.engine.splitK * 1.05;
  }
  get treeCount() { let n = 0; for (const e of this.tiles.values()) if (e.groups?.some(g => g.meshes[0].visible || g.meshes[1].visible)) n += e.count; return n; }
}
