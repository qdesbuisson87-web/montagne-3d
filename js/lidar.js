// IGN LiDAR HD point clouds, read directly from IGN's download service (nothing hosted here, nothing to pay).
// Each 1 km² tile is a COPC file (cloud-optimised LAZ): an octree whose levels add points (6.8 m apart at the
// root, ~0.2 m at the deepest level), so only the part in view, at the density the screen needs, is fetched
// with partial (range) requests. Points close to the camera come from the deepest levels; far ones stay sparse.
// Every piece fetched is kept on the device (Cache Storage, offline) within a size limit the owner chooses; the
// oldest-used pieces are dropped first. Decoding runs in workers (lidar-worker.js).
import * as THREE from 'three';
import { lonLatToWorld, l93ToLonLat, lonLatToL93, worldToLonLat, lonLatToTile } from './geo.js?v=202610101234';
import { cachedFetch, netFetch, TransientError } from './net.js?v=202610101234';
import { photoUrl } from './terrain.js?v=202610101234';

const CACHE = 'midi3d-lidar-v1', INDEX = 'midi3d-lidar-index', LIMIT = 'midi3d-lidar-limit';
export const LIMITS = [5e8, 2e9, 5e9]; // bytes the owner can allow on the device
const CELL = 0.02; // degrees: the tile list (WFS) is fetched by cells of ≈ 1.5 × 2.2 km
const META = (s, w, n, e) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=IGNF_LIDAR-HD_METADONNEE:metadata&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=200&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
const NEAR = 4000; // metres from the camera to the point looked at: beyond, the relief alone looks the same
// metres: points are never drawn smaller up close. The survey is ≈ 0.22 m apart on open ground but sparser on
// cliffs (the plane sees them edge-on): 0.3 m closes most gaps there; larger, lone points turned into confetti
const MIN_WORLD = 0.3;

// IGN LiDAR HD classes (the ones drawn); the shader and the legend both read this list
export const POINT_CLASSES = [
  [2, 'Sol', '#a8875e'], [3, 'Végétation basse', '#9ccc5a'], [4, 'Végétation moyenne', '#4f9a35'], [5, 'Végétation haute', '#1f6b25'],
  [6, 'Bâtiments', '#e0453a'], [67, 'Autres constructions', '#f08a6a'], [17, 'Ponts', '#f0a020'], [64, 'Sursol pérenne (pylônes…)', '#c060c8'],
  [9, 'Eau', '#3f80e0'], [1, 'Non classé', '#a0a0a0']
];
const lin = hex => [1, 3, 5].map(i => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2).toFixed(4));

// ---------- storage: every piece fetched, kept on the device within the chosen limit ----------
class Store {
  constructor() {
    this.index = new Map(); // key -> [bytes, last use (minutes)]
    try { for (const [k, v] of JSON.parse(localStorage.getItem(INDEX) || '[]')) this.index.set(k, v); } catch { }
    this.limit = +(localStorage.getItem(LIMIT) || 0) || LIMITS[1];
    this.dirty = false; setInterval(() => this.save(), 5000);
  }
  save() { if (!this.dirty) return; this.dirty = false; try { localStorage.setItem(INDEX, JSON.stringify([...this.index])); } catch { } }
  get used() { let s = 0; for (const [b] of this.index.values()) s += b; return s; }
  cache() { return (this.c ??= self.caches && self.isSecureContext ? caches.open(CACHE).catch(() => null) : Promise.resolve(null)); }
  // bytes [a, b] of a file: from the device, else one partial request (never the whole 200 MB file)
  async range(file, a, b) {
    const key = `${file.id}/${a}-${b}`, req = `https://lidar.cache/${key}`, c = await this.cache(), now = Math.floor(Date.now() / 60000);
    if (c) { const hit = await c.match(req).catch(() => null); if (hit) { this.touch(key, b - a + 1, now); return hit.arrayBuffer(); } }
    const ctl = new AbortController();
    const r = await netFetch(file.url, 4, { headers: { Range: `bytes=${a}-${b}` }, signal: ctl.signal });
    if (r.status !== 206) { ctl.abort(); throw new Error(`IGN ${r.status}`); } // a 200 would be the whole file: stop it
    const buf = await r.arrayBuffer();
    if (c) {
      await this.makeRoom(buf.byteLength);
      await c.put(req, new Response(buf.slice(0))).then(() => this.touch(key, buf.byteLength, now)).catch(() => { });
    }
    return buf;
  }
  touch(key, bytes, now) { const e = this.index.get(key); if (!e || e[1] !== now) { this.index.set(key, [bytes, now]); this.dirty = true; } }
  async makeRoom(extra) {
    let used = this.used; if (used + extra <= this.limit) return;
    const c = await this.cache(), old = [...this.index].sort((x, y) => x[1][1] - y[1][1]);
    for (const [k, [bytes]] of old) {
      if (used + extra <= this.limit) break;
      await c?.delete(`https://lidar.cache/${k}`).catch(() => { }); this.index.delete(k); used -= bytes; this.dirty = true;
    }
  }
  async setLimit(bytes) { this.limit = bytes; try { localStorage.setItem(LIMIT, String(bytes)); } catch { } await this.makeRoom(0); this.save(); }
  // Is this place drawn by the points? (their first level is on screen there.) The modelled trees and the BD TOPO
  // blocks then step aside: the survey shows the real ones.
  covers(x, z) {
    const c = this.coverage; if (!c || Math.hypot(x - c.x, z - c.z) > c.r) return false;
    const [X, Y] = lonLatToL93(...worldToLonLat(x, z)), id = `${String(Math.floor(X / 1000)).padStart(4, '0')}-${Math.ceil(Y / 1000)}`;
    return !!this.loaded.get(`${id}|0-0-0-0`)?.mesh;
  }

  async clear() { await caches.delete(CACHE).catch(() => { }); this.c = null; this.index.clear(); this.dirty = true; this.save(); }
}

// ---------- COPC file: header, octree hierarchy ----------
function parseHeader(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.slice(0, 4)) !== 'LASF') throw new Error('pas un fichier LAS');
  const hs = v.getUint16(94, true), fmt = v.getUint8(104) & 0x3f, len = v.getUint16(105, true);
  const d = o => v.getFloat64(o, true);
  const h = { fmt, len, scale: [d(131), d(139), d(147)], offset: [d(155), d(163), d(171)] };
  // the COPC info record is the first VLR, right after the header
  const p = hs + 54; if (String.fromCharCode(...u8.slice(hs + 2, hs + 6)) !== 'copc') throw new Error('pas un fichier COPC');
  Object.assign(h, { cx: d(p), cy: d(p + 8), cz: d(p + 16), half: d(p + 24), spacing: d(p + 32), rootOff: Number(v.getBigUint64(p + 40, true)), rootSize: Number(v.getBigUint64(p + 48, true)) });
  if (fmt !== 6 && fmt !== 7 && fmt !== 8) throw new Error(`format de points ${fmt} non pris en charge`);
  return h;
}

class CopcFile {
  constructor(store, meta) { Object.assign(this, meta); this.store = store; this.nodes = new Map(); this.state = 'idle'; }
  async open() {
    this.state = 'loading';
    try {
      this.h = parseHeader(await this.store.range(this, 0, 4095));
      await this.page(this.h.rootOff, this.h.rootSize);
      this.state = 'ready';
    } catch (e) { this.state = 'idle'; this.retryAt = performance.now() + (e instanceof TransientError ? 15000 : 600000); }
  }
  async page(off, size) { // hierarchy page: 32-byte entries (key d,x,y,z; offset; bytes; points or -1 = sub-page)
    const v = new DataView(await this.store.range(this, off, off + size - 1)), subs = [];
    for (let i = 0; i + 32 <= v.byteLength; i += 32) {
      const d = v.getInt32(i, true), x = v.getInt32(i + 4, true), y = v.getInt32(i + 8, true), z = v.getInt32(i + 12, true);
      const o = Number(v.getBigUint64(i + 16, true)), bytes = v.getInt32(i + 24, true), count = v.getInt32(i + 28, true);
      if (count < 0) subs.push([o, bytes]); else if (count > 0) this.nodes.set(`${d}-${x}-${y}-${z}`, { file: this, d, x, y, z, off: o, bytes, count });
    }
    for (const [o, b] of subs) await this.page(o, b);
  }
  // node geometry: Lambert-93 centre, cube size, point spacing at its level, and where it sits in the scene
  place(n) {
    if (n.X0 != null) return n;
    const H = this.h, size = 2 * H.half / 2 ** n.d;
    n.X0 = H.cx - H.half + (n.x + 0.5) * size; n.Y0 = H.cy - H.half + (n.y + 0.5) * size; n.Z0 = H.cz - H.half + (n.z + 0.5) * size;
    n.size = size; n.spacing = H.spacing / 2 ** n.d;
    const w = (X, Y) => lonLatToWorld(...l93ToLonLat(X, Y));
    const [cx, cz] = w(n.X0, n.Y0), [ax, az] = w(n.X0 + 50, n.Y0), [bx, bz] = w(n.X0, n.Y0 + 50);
    n.cx = cx; n.cz = cz; n.A = [(ax - cx) / 50, (bx - cx) / 50, (az - cz) / 50, (bz - cz) / 50];
    return n;
  }
}

// ---------- the layer ----------
export class PointCloud {
  constructor({ scene, uniforms, sceneGLSL, renderer }) {
    this.scene = scene; this.renderer = renderer; this.store = new Store();
    this.group = new THREE.Group(); scene.add(this.group);
    this.on = false; this.budget = 2.5e6; this.pixel = 1.7; this.colorMode = 0;
    this.cells = new Set(); this.pending = 0; this.files = new Map(); this.loaded = new Map(); this.inflight = 0; this.maxInflight = 4;
    this.workers = []; this.jobs = new Map(); this.jobId = 0; this.exag = 1; this.frameN = 0;
    this.stats = { shown: 0, loading: 0, files: 0, dates: null, why: '' };
    this.frustum = new THREE.Frustum(); this.pv = new THREE.Matrix4();
    this.u = { ...uniforms, pxSize: { value: 3 }, proj: { value: 1000 }, colorMode: { value: 0 } };
    const cases = POINT_CLASSES.map(([c, , hex]) => `if (k == ${c}) return vec3(${lin(hex).join(', ')});`).join('\n    ');
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: `
        uniform float exag, pxSize, proj; attribute vec4 color; attribute vec4 nrm;
        varying vec3 vW, vN, vCol; varying float vI, vCls, vHasPhoto, vNear;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          vec3 toCam = cameraPosition - w.xyz; float d = length(toCam);
          vW = w.xyz;
          // within a few metres the points would be large discs: they fade out there, the relief mesh (0.4 m) remains
          vNear = smoothstep(8.0, 25.0, d);
          // drawn slightly in front of the relief mesh the ground points lie on (the mesh fills the gaps between them)
          w.xyz += toCam / d * min(0.3 + d * 0.002, 3.0);
          vec4 mv = viewMatrix * w; gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(max(pxSize, ${MIN_WORLD.toFixed(2)} * proj / -mv.z), 1.0, 16.0);
          vN = normalize(vec3(nrm.x * exag, nrm.y, nrm.z * exag));
          // alpha: 0 = no photo under the point, else 1 + (laser intensity ratio - 0.4) / 1.4 × 254
          vCol = color.rgb; vHasPhoto = step(0.002, color.a); vI = 0.4 + (color.a * 255.0 - 1.0) / 254.0 * 1.4;
          vCls = floor(nrm.w * 127.0 + 0.5);
        }`,
      fragmentShader: `
        uniform float colorMode, vivid;
        ${sceneGLSL}
        varying vec3 vW, vN, vCol; varying float vI, vCls, vHasPhoto, vNear;
        const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
        vec3 classColor(int k){
          ${cases}
          return vec3(0.35);
        }
        void main(){
          vec2 c = gl_PointCoord - 0.5; if (dot(c, c) > 0.25) discard; // round points
          if (vNear < 1.0 && fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) > vNear) discard; // screen-door fade
          vec3 V = normalize(cameraPosition - vW), n = normalize(vN);
          if (dot(n, V) < 0.0) n = -n; // a normal from neighbours has no side: take the one facing the viewer
          vec3 alb = colorMode > 0.5 || vHasPhoto < 0.5 ? classColor(int(vCls)) : pow(vCol, vec3(2.2)) * mix(1.0, vI, 0.25);
          float lum = dot(alb, LUM);
          alb = max(mix(vec3(lum), alb, 1.0 + vivid), 0.0) * (1.0 + vivid * 0.15);
          float steep = smoothstep(0.3, 0.7, 1.0 - n.y);
          vec3 col;
          if (light < 0.5) { const vec3 PL = vec3(0.196, 0.819, 0.539); col = alb * mix(0.88 + 0.14 * n.y, 0.45 + 0.75 * max(dot(n, PL), 0.0), colorMode > 0.5 ? 1.0 : steep); }
          else {
            float sh = shOn > 0.5 ? sunShadow(vW) : 1.0;
            col = alb / (0.55 + 0.9 * lum) * 0.95 * (sunCol * max(dot(n, sunDir), 0.0) * sh + skyCol * 0.5 * (0.6 + 0.4 * n.y) * skyVis(vW));
          }
          gl_FragColor = vec4(pow(max(aerial(col, vW), 0.0), vec3(1.0/2.2)), 1.0);
        }`
    });
  }

  // photo colours: the ground (and the low vegetation) is left to the relief mesh (same survey, meshed; its points
  // would only add grain) and the points show what stands on it. Classes: every point.
  setColorMode(m) {
    this.colorMode = m; this.u.colorMode.value = m;
    for (const e of this.loaded.values()) if (e.mesh) e.mesh.geometry.setDrawRange(0, m ? e.all : e.above);
  }
  setQuality(budget, pixel) { this.budget = budget; this.pixel = pixel; }

  // the survey tiles around a point (IGN metadata, cached for offline use)
  ensureFiles(x, z, radius) {
    const [lon, lat] = worldToLonLat(x, z), dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue; this.cells.add(key); this.pending++;
      cachedFetch(META(a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL)).then(r => r.ok ? r.json() : null).then(j => {
        if (!j) { this.cells.delete(key); return; }
        for (const f of j.features ?? []) {
          const p = f.properties, id = p.coordonnees_nw; if (!p.url_npl || !id) continue;
          const old = this.files.get(id); if (old && old.edition >= p.date_edition) continue; // the latest edition of a tile
          const [kx, ky] = id.split('-').map(Number);
          this.files.set(id, new CopcFile(this.store, { id, url: p.url_npl, edition: p.date_edition, from: p.date_debut_acquisition, to: p.date_fin_acquisition, X: kx * 1000, Y: ky * 1000 }));
        }
      }).catch(() => this.cells.delete(key)).finally(() => this.pending--);
    }
  }

  worker() {
    if (!this.workers.length) {
      const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./lidar-worker.js?v=202610101234', import.meta.url));
        w.onmessage = ({ data }) => { const j = this.jobs.get(data.id); this.jobs.delete(data.id); data.error ? j?.reject(new Error(data.error)) : j?.resolve(data); };
        this.workers.push(w);
      }
    }
    return this.workers[this.jobId % this.workers.length];
  }

  // the aerial photo under a node, at about the node's point spacing, as one RGBA mosaic (tiles from the same
  // IGN service as the relief's photo, so mostly already on the device)
  async photo(n) {
    const lat0 = l93ToLonLat(n.X0, n.Y0)[1], ground = 156543.03 * Math.cos(lat0 * Math.PI / 180);
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => l93ToLonLat(n.X0 + a * n.size / 2, n.Y0 + b * n.size / 2));
    let z = Math.min(19, Math.max(13, Math.ceil(Math.log2(ground / (n.spacing * 0.8)))));
    let tx0, ty0, tx1, ty1;
    for (; ; z--) { // at most 4 × 4 tiles: lower the zoom for wide, sparse nodes
      const t = corners.map(([lo, la]) => lonLatToTile(lo, la, z));
      tx0 = Math.floor(Math.min(...t.map(q => q[0]))); tx1 = Math.floor(Math.max(...t.map(q => q[0])));
      ty0 = Math.floor(Math.min(...t.map(q => q[1]))); ty1 = Math.floor(Math.max(...t.map(q => q[1])));
      if ((tx1 - tx0 < 4 && ty1 - ty0 < 4) || z <= 13) break;
    }
    const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(cachedFetch(photoUrl(z, tx, ty)).then(async r => {
      if (!r.ok) return; const bm = await createImageBitmap(await r.blob()); ctx.drawImage(bm, (tx - tx0) * 256, (ty - ty0) * 256); bm.close?.();
    }).catch(e => { if (e instanceof TransientError) throw e; }));
    await Promise.all(jobs);
    // (white is kept: it is snow here. The survey covers France only, where the IGN photo exists)
    const px = ctx.getImageData(0, 0, W, H).data;
    const toPix = (dX, dY) => { const [fx, fy] = lonLatToTile(...l93ToLonLat(n.X0 + dX, n.Y0 + dY), z); return [(fx - tx0) * 256, (fy - ty0) * 256]; };
    const [c0, c1] = toPix(0, 0), [a0, a1] = toPix(50, 0), [b0, b1] = toPix(0, 50);
    return { pix: px, w: W, h: H, B: [(a0 - c0) / 50, (b0 - c0) / 50, c0, (a1 - c1) / 50, (b1 - c1) / 50, c1] };
  }

  async load(n, key) {
    const entry = { state: 'loading', mesh: null, n, count: n.count, wanted: this.frameN }; this.loaded.set(key, entry);
    this.inflight++;
    try {
      const f = n.file, H = f.h;
      const [buf, photo] = await Promise.all([this.store.range(f, n.off, n.off + n.bytes - 1), this.photo(n).catch(e => { if (e instanceof TransientError) throw e; return null; })]);
      const A = n.A, det = A[0] * A[3] - A[1] * A[2], Ainv = [A[3] / det, -A[1] / det, -A[2] / det, A[0] / det];
      const id = ++this.jobId, w = this.worker();
      const res = await new Promise((resolve, reject) => {
        this.jobs.set(id, { resolve, reject });
        w.postMessage({ id, buf, count: n.count, len: H.len, scale: H.scale, offset: H.offset, X0: n.X0, Y0: n.Y0, Z0: n.Z0, A, Ainv, spacing: n.spacing, photo }, [buf, ...(photo ? [photo.pix.buffer] : [])]);
      });
      if (this.loaded.get(key) !== entry) return; // dropped meanwhile
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(res.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(res.col, 4, true));
      g.setAttribute('nrm', new THREE.BufferAttribute(res.nrm, 4, true));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), n.size * 0.9);
      g.setDrawRange(0, this.colorMode ? res.n : res.above);
      const m = new THREE.Points(g, this.material);
      m.position.set(n.cx, n.Z0 * this.exag, n.cz); m.scale.y = this.exag; m.updateMatrix(); m.matrixAutoUpdate = false;
      m.visible = false; this.group.add(m);
      Object.assign(entry, { state: 'ready', mesh: m, count: res.n, all: res.n, above: res.above });
    } catch (e) {
      // no answer now (offline, refused): forget it, it is asked again when still wanted
      if (this.loaded.get(key) === entry) this.loaded.delete(key);
      // a piece that cannot be read is not asked again in this session (the relief stays there)
      if (!(e instanceof TransientError)) { n.bad = true; console.warn('LiDAR', key, e.message); }
    } finally { this.inflight--; }
  }
  drop(key) {
    const e = this.loaded.get(key); this.loaded.delete(key);
    if (e?.mesh) { this.group.remove(e.mesh); e.mesh.geometry.dispose(); }
  }

  // every frame: choose the nodes to draw (largest on screen first, within the point budget), load what is missing
  update(camera, target, exag, hidden) {
    this.frameN++;
    const dist = camera.position.distanceTo(target), active = this.on && !hidden && dist < NEAR;
    this.group.visible = active;
    this.coverage = null;
    if (!this.on || hidden) { this.stats.why = ''; return; }
    if (!active) { this.stats.why = 'far'; this.stats.shown = 0; return; }
    if (exag !== this.exag) { // relief exaggeration: the points follow the relief
      this.exag = exag;
      for (const e of this.loaded.values()) if (e.mesh) { e.mesh.position.y = e.n.Z0 * exag; e.mesh.scale.y = exag; e.mesh.updateMatrix(); }
    }
    const radius = Math.min(2500, Math.max(500, dist * 1.3));
    this.coverage = { x: target.x, z: target.z, r: radius };
    if (this.frameN % 30 === 1) this.ensureFiles(target.x, target.z, radius);
    const H = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y, pr = this.renderer.getPixelRatio();
    this.u.proj.value = H / (2 * Math.tan(camera.fov * Math.PI / 360));
    this.u.pxSize.value = this.pixel * pr * 1.3;
    if (this.frameN % 6 !== 0 && this.frameN > 2) return;
    this.select(camera, target, radius, pr);
  }

  select(camera, target, radius, pr) {
    const cam = camera.position, T = this.pixel * pr, proj = this.u.proj.value, exag = this.exag;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.pv);
    const sphere = new THREE.Sphere(), heap = [], dates = new Set(); let files = 0, near = 0;
    const push = n => {
      if (n.bad) return;
      n.file.place(n);
      sphere.center.set(n.cx, n.Z0 * exag, n.cz); sphere.radius = n.size * 0.9 * Math.max(1, exag);
      if (!this.frustum.intersectsSphere(sphere)) return;
      const d = Math.max(1, sphere.center.distanceTo(cam) - sphere.radius);
      heap.push({ n, px: n.spacing * proj / d });
    };
    for (const f of this.files.values()) {
      // tiles near the point looked at (their 1 km square within the radius)
      const [tx, tz] = lonLatToWorld(...l93ToLonLat(f.X + 500, f.Y - 500));
      if (Math.hypot(tx - target.x, tz - target.z) > radius + 710) continue; // the square reaches into the circle
      near++;
      if (f.state === 'idle' && !(performance.now() < (f.retryAt || 0))) f.open();
      if (f.state !== 'ready') continue;
      files++; dates.add(f.to || f.from);
      const root = f.nodes.get('0-0-0-0'); if (root) push(root);
    }
    // largest on screen first; children are visited only when the node is still coarse on screen
    const want = [], wantKeys = new Set(); let points = 0;
    while (heap.length && points < this.budget) {
      let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i].px > heap[bi].px) bi = i;
      const { n, px } = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
      const key = `${n.file.id}|${n.d}-${n.x}-${n.y}-${n.z}`;
      // budget: points drawn (ground left out in photo colours), but every point loaded counts for at least half,
      // so that the download stays reasonable where most points are ground
      const e = this.loaded.get(key), all = e?.mesh ? e.all : n.count;
      want.push([key, n, px]); wantKeys.add(key); points += this.colorMode ? all : Math.max(all * 0.5, e?.mesh ? e.above : 0);
      if (px > T) for (let c = 0; c < 8; c++) {
        const ch = n.file.nodes.get(`${n.d + 1}-${n.x * 2 + (c & 1)}-${n.y * 2 + ((c >> 1) & 1)}-${n.z * 2 + (c >> 2)}`);
        if (ch) push(ch);
      }
    }
    // draw what is wanted and ready; load the missing, most visible first
    let shown = 0, loading = 0;
    for (const [key, e] of this.loaded) {
      const w = wantKeys.has(key); if (w) e.wanted = this.frameN;
      if (e.mesh) { e.mesh.visible = w; if (w) shown += this.colorMode ? e.all : e.above; }
      if (e.state === 'loading') loading++;
    }
    for (const [key, n] of want) {
      if (this.inflight >= this.maxInflight) break;
      if (!this.loaded.has(key)) this.load(n, key);
    }
    // GPU memory: free what has not been wanted for a while once well over budget
    let total = 0; for (const e of this.loaded.values()) total += e.count; // GPU memory holds every point, ground included
    const keep = this.budget * (this.colorMode ? 1 : 2);
    if (total > keep * 1.6) {
      const old = [...this.loaded].filter(([k, e]) => e.state === 'ready' && !wantKeys.has(k)).sort((a, b) => a[1].wanted - b[1].wanted);
      for (const [k, e] of old) { if (total <= keep * 1.2) break; total -= e.count; this.drop(k); }
    }
    const missing = want.filter(([k]) => !this.loaded.get(k)?.mesh).length;
    this.stats = { shown, loading: Math.max(loading, missing ? this.inflight : 0), missing, files, dates: [...dates].filter(Boolean).sort(), why: files ? '' : near || this.pending ? 'wait' : 'none' };
  }

  // Is this place drawn by the points? (their first level is on screen there.) The modelled trees and the BD TOPO
  // blocks then step aside: the survey shows the real ones.
  covers(x, z) {
    const c = this.coverage; if (!c || Math.hypot(x - c.x, z - c.z) > c.r) return false;
    const [X, Y] = lonLatToL93(...worldToLonLat(x, z)), id = `${String(Math.floor(X / 1000)).padStart(4, '0')}-${Math.ceil(Y / 1000)}`;
    return !!this.loaded.get(`${id}|0-0-0-0`)?.mesh;
  }

  // switched off: give the GPU memory back (what was downloaded stays on the device)
  release() { for (const k of [...this.loaded.keys()]) this.drop(k); }
  async clear() { this.release(); await this.store.clear(); }
}
