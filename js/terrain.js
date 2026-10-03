// Streaming terrain: a quadtree of web-mercator tiles. Each tile is a 64×64 mesh with its own
// elevation grid and photo. Close to the camera the tree goes down to zoom 19 (IGN photos 20 cm,
// LiDAR HD elevation); far away it stays coarse. Nothing is pre-packaged: every tile is fetched live.
import * as THREE from 'three';
import { tileMerc, mercToWorld, mercToLonLat, worldToLonLat, lonLatToL93, lonLatToTile, K } from './geo.js?v=202610031153';
import { cachedFetch, TransientError } from './net.js?v=202610031153';
// avalanches of the past (CLPA, INRAE/IGN, served by Géorisques): areas seen on aerial photos and in the field
// (magenta) and from witnesses (orange), as the map draws them
const CLPA_WMS = ([x0, y0, x1, y1]) => `https://mapsref.brgm.fr/wxs/georisques/risques?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=CLPA_interpretation,CLPA_temoignage&STYLES=&CRS=EPSG:3857&BBOX=${x0},${y0},${x1},${y1}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`;
import { FOREST_WMS, decodeForest } from './foresttypes.js?v=202610031153';

// NE: the grid plus a one-sample ring taken beyond the tile edge, so that normals and slopes at the edge
// use the same central differences as the neighbour tile does (no seam in lighting or slope colours)
const N = 64, NV = N + 1, NE = NV + 2;
export const GRID = N;
const URL_IGN_PHOTO = (z, x, y, layer = 'ORTHOIMAGERY.ORTHOPHOTOS', fmt = 'jpeg') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/${fmt}`;
// Aerial photos of earlier times (IGN historical mosaics), for "back in time": id -> [layer, format, label]. Not
// every period covers every place (1965–1995 are missing around Chamonix); where a period has nothing, the
// current photo is used and the app says so. Black and white before 1970.
export const EPOCHS = {
  current: ['ORTHOIMAGERY.ORTHOPHOTOS', 'jpeg', 'Actuelle'],
  '2021': ['ORTHOIMAGERY.ORTHOPHOTOS2021-2023', 'jpeg', '2021–2023'],
  '2016': ['ORTHOIMAGERY.ORTHOPHOTOS2016-2020', 'jpeg', '2016–2020'],
  '2011': ['ORTHOIMAGERY.ORTHOPHOTOS2011-2015', 'jpeg', '2011–2015'],
  '2006': ['ORTHOIMAGERY.ORTHOPHOTOS2006-2010', 'jpeg', '2006–2010'],
  '2000': ['ORTHOIMAGERY.ORTHOPHOTOS2000-2005', 'jpeg', '2000–2005'],
  '1980': ['ORTHOIMAGERY.ORTHOPHOTOS.1980-1995', 'png', '1980–1995'],
  '1965': ['ORTHOIMAGERY.ORTHOPHOTOS.1965-1980', 'png', '1965–1980'],
  '1950': ['ORTHOIMAGERY.ORTHOPHOTOS.1950-1965', 'png', '1950–1965']
};
const URL_EOX = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
const URL_TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const URL_IGN_ELEV = (layer, b, w, h) => `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:2154&BBOX=${b.join(',')}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/x-bil;bits=32`;
// bare-earth model: the surface model (MNS) also records cable-car cables, which show up as curtains
const LIDAR = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93';
const RGE = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
// zoom 20 (≈ 26 m tiles, 0.4 m mesh) matches the 0.5 m LiDAR close up; the photo there is the zoom-19 one
// (20 cm, the finest IGN makes), cropped to the quarter
export const MAXZ = 20, PHOTO_MAXZ = 19;
export const LIDAR_LAYER = LIDAR;

// ---------- shared geometry (index + uv), per-tile positions ----------
const SKIRT = 4 * NV;
const sharedIndex = (() => {
  const idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * NV + i, b = a + 1, c = a + NV, d = c + 1; idx.push(a, c, b, b, c, d); }
  const edge = [t => t, t => t * NV + N, t => N * NV + (N - t), t => (N - t) * NV];
  for (let e = 0; e < 4; e++) for (let t = 0; t < N; t++) {
    const a = edge[e](t), b = edge[e](t + 1), c = NV * NV + e * NV + t, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  return new THREE.Uint32BufferAttribute(idx, 1);
})();
const sharedUV = (() => {
  const uv = new Float32Array((NV * NV + SKIRT) * 2);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) { const k = j * NV + i; uv[k * 2] = i / N; uv[k * 2 + 1] = j / N; }
  const edge = [t => [t, 0], t => [N, t], t => [N - t, N], t => [0, N - t]];
  for (let e = 0; e < 4; e++) for (let t = 0; t < NV; t++) { const [i, j] = edge[e](t), k = NV * NV + e * NV + t; uv[k * 2] = i / N; uv[k * 2 + 1] = j / N; }
  return new THREE.BufferAttribute(uv, 2);
})();
const skirtSrc = (() => { const s = []; const edge = [t => t, t => t * NV + N, t => N * NV + (N - t), t => (N - t) * NV]; for (let e = 0; e < 4; e++) for (let t = 0; t < NV; t++) s.push(edge[e](t)); return s; })();

// a refused or unanswered request (TransientError) propagates: the tile is retried later, never degraded for it
async function fetchBitmap(url, store = true) {
  const r = await cachedFetch(url, store);
  if (!r.ok) throw new Error(r.status);
  return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}
const unlessTransient = fallback => e => { if (e instanceof TransientError) throw e; return fallback; };
export const photoUrl = (z, x, y) => URL_IGN_PHOTO(z, x, y), terrariumUrl = (z, x, y) => URL_TERRARIUM(z, x, y);
// LiDAR request for one tile: Lambert-93 box around the tile at the tile's own resolution.
// L holds the Lambert-93 position of every point of the extended grid (ring included); the box is set by the
// tile itself (the ring lies inside its 2-sample margin), so URLs already in the cache and offline packs stay valid.
export function elevRequest(z, x, y) {
  const m = tileMerc(z, x, y), L = new Float64Array(NE * NE * 2);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let j = -1; j <= NV; j++) for (let i = -1; i <= NV; i++) {
    const [lon, lat] = mercToLonLat(m.minx + i / N * m.size, m.maxy - j / N * m.size), [X, Y] = lonLatToL93(lon, lat), k = ((j + 1) * NE + i + 1) * 2;
    L[k] = X; L[k + 1] = Y;
    if (i < 0 || j < 0 || i > N || j > N) continue;
    if (X < bx0) bx0 = X; if (X > bx1) bx1 = X; if (Y < by0) by0 = Y; if (Y > by1) by1 = Y;
  }
  const [wx0] = mercToWorld(m.minx, 0), [wx1] = mercToWorld(m.maxx, 0), res = (wx1 - wx0) / N, pad = res * 2;
  bx0 -= pad; by0 -= pad; bx1 += pad; by1 += pad;
  const w = Math.min(160, Math.ceil((bx1 - bx0) / res)), hgt = Math.min(160, Math.ceil((by1 - by0) / res)), bbox = [bx0, by0, bx1, by1];
  return { L, bbox, w, hgt, url: layer => URL_IGN_ELEV(layer, bbox, w, hgt) };
}
// Sentinel-2 cloudless (EOX), used where IGN has no photo (Italy, Switzerland), is darker in the mid-tones and
// three times as saturated as the IGN photos: the border showed along the ridges. Measured on 12 zoom-14 tiles of
// the French side where both exist (Chamonix valley, Aiguilles Rouges, Les Houches, Contamines, Buet, Megève;
// 01/10/2026): its brightness is mapped onto IGN's by histogram matching (control points every 16 values) and its
// saturation scaled by the ratio of mean chroma, 10.0 / 32.6. The three channels move together, so hues stay
// (matching each channel on its own turned grey rock purple).
const EOX_LUM = (p => Float32Array.from({ length: 256 }, (_, v) => { const i = Math.min(15, v >> 4), t = (v - i * 16) / (i === 15 ? 15 : 16); return p[i] + (p[i + 1] - p[i]) * t; }))(
  [0, 40, 67, 90, 121, 145, 160, 170, 180, 189, 197, 204, 210, 217, 221, 225, 255]), EOX_SAT = 0.31;
function eoxToIgn(b, k) {
  const r = b[k], g = b[k + 1], bl = b[k + 2], y = 0.2126 * r + 0.7152 * g + 0.0722 * bl, s = EOX_LUM[Math.round(y)] / Math.max(y, 1);
  b[k] = (y + (r - y) * EOX_SAT) * s; b[k + 1] = (y + (g - y) * EOX_SAT) * s; b[k + 2] = (y + (bl - y) * EOX_SAT) * s; // clamped by the array
}
const scratch = document.createElement('canvas'); scratch.width = scratch.height = 256;
const sctx = scratch.getContext('2d', { willReadFrequently: true });
function pixels(bitmap, sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height) {
  sctx.clearRect(0, 0, 256, 256); sctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 256, 256);
  return sctx.getImageData(0, 0, 256, 256);
}

// ---------- tile ----------
class Tile {
  constructor(engine, z, x, y, parent) {
    this.engine = engine; this.z = z; this.x = x; this.y = y; this.parent = parent; this.children = null;
    const m = tileMerc(z, x, y);
    [this.x0, this.z0] = mercToWorld(m.minx, m.maxy); [this.x1, this.z1] = mercToWorld(m.maxx, m.miny);
    this.size = this.x1 - this.x0;
    this.state = 'idle'; this.lastSeen = 0; this.h = null; this.minH = parent ? parent.minH : 0; this.maxH = parent ? parent.maxH : 5000;
    this.mesh = null; this.box = new THREE.Box3();
  }
  contains(x, z) { return x >= this.x0 && x <= this.x1 && z >= this.z0 && z <= this.z1; }
  sampleGrid(gx, gz) { // grid coords (0..N) -> metres
    const i = Math.min(Math.max(gx, 0), N - 1e-6), j = Math.min(Math.max(gz, 0), N - 1e-6), i0 = i | 0, j0 = j | 0, tx = i - i0, ty = j - j0, k = j0 * NV + i0, h = this.h;
    return h[k] * (1 - tx) * (1 - ty) + h[k + 1] * tx * (1 - ty) + h[k + NV] * (1 - tx) * ty + h[k + NV + 1] * tx * ty;
  }
  heightAt(x, z) { return this.sampleGrid((x - this.x0) / this.size * N, (z - this.z0) / (this.z1 - this.z0) * N); }
  fromParent(i, j) { const p = this.parent; return p.sampleGrid((this.x & 1) * N / 2 + i / 2, (this.y & 1) * N / 2 + j / 2); }
  ensureChildren() {
    if (!this.children) { const z = this.z + 1, x = this.x * 2, y = this.y * 2; this.children = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([a, b]) => new Tile(this.engine, z, a, b, this)); }
    return this.children;
  }

  async load() {
    // each load has its own number: a tile disposed while loading (new photo period, roots dropped) and asked for
    // again starts a second load, and only the latest may build (two would leave a mesh nobody frees)
    const gen = this.gen = (this.gen || 0) + 1;
    this.state = 'loading';
    const [hr, pr] = await Promise.allSettled([this.loadHeights(), this.loadPhoto()]);
    const tex = pr.status === 'fulfilled' ? pr.value : null;
    if (this.state !== 'loading' || gen !== this.gen) { tex?.dispose(); return; } // disposed or reloaded meanwhile
    if ([hr, pr].some(r => r.status === 'rejected' && r.reason instanceof TransientError)) {
      // no answer for now (offline, server busy): the parent stays on screen and the tile is retried later
      tex?.dispose(); this.fails = (this.fails || 0) + 1;
      this.retryAt = performance.now() + Math.min(60e3, 1500 * 2 ** this.fails); this.state = 'idle';
      return;
    }
    this.fails = 0;
    const g = hr.status === 'fulfilled' ? hr.value : this.parentGrid();
    this.src = g.src;
    this.build(tex, g.e);
    this.state = 'ready';
  }
  // whole grid from the parent tile (no data of our own at this level)
  parentGrid() {
    const e = new Float32Array(NE * NE).fill(NaN);
    if (this.parent?.h) for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) e[(j + 1) * NE + i + 1] = this.fromParent(i, j);
    else for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) e[(j + 1) * NE + i + 1] = 0;
    return { e: extrapolateRing(e), src: this.parent?.src ?? 'global' };
  }
  async loadHeights() {
    const { z, x, y } = this;
    if (z <= 13) { // global Terrarium DEM (~30 m) for the far field
      const bm = await fetchBitmap(URL_TERRARIUM(z, x, y));
      const d = pixels(bm).data, e = new Float32Array(NE * NE).fill(NaN); bm.close?.();
      const at = (px, py) => { const k = (py * 256 + px) * 4; return d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768; };
      for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
        const fx = Math.min(Math.max(i / N * 256 - 0.5, 0), 254.999), fy = Math.min(Math.max(j / N * 256 - 0.5, 0), 254.999);
        const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
        e[(j + 1) * NE + i + 1] = at(ix, iy) * (1 - tx) * (1 - ty) + at(ix + 1, iy) * tx * (1 - ty) + at(ix, iy + 1) * (1 - tx) * ty + at(ix + 1, iy + 1) * tx * ty;
      }
      return { e: extrapolateRing(e), src: 'global' };
    }
    // IGN LiDAR HD (0.5–1 m) in Lambert-93, resampled onto this tile's grid; gaps filled by RGE ALTI, then by the parent tile
    const req = elevRequest(z, x, y), { L, w, hgt } = req, [bx0, by0, bx1, by1] = req.bbox;
    const grab = async layer => {
      const r = await cachedFetch(req.url(layer));
      if (!r.ok) throw new Error(r.status);
      const buf = await r.arrayBuffer(); if (buf.byteLength !== w * hgt * 4) throw new Error('size'); // e.g. an XML error page
      return new Float32Array(buf); // little-endian on every platform we target
    };
    const rx = (bx1 - bx0) / w, ry = (by1 - by0) / hgt;
    const sample = (src, X, Y) => {
      const fx = (X - bx0) / rx - 0.5, fy = (by1 - Y) / ry - 0.5, ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= hgt - 1) return NaN;
      const tx = fx - ix, ty = fy - iy, k = iy * w + ix, a = src[k], b = src[k + 1], c = src[k + w], d = src[k + w + 1];
      if (a < -500 || b < -500 || c < -500 || d < -500) return NaN;
      return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    };
    const e = new Float32Array(NE * NE), inner = k => { const i = k % NE, j = (k / NE) | 0; return i > 0 && j > 0 && i <= NV && j <= NV; };
    const count = { lidar: 0, rge: 0, parent: 0 };
    const lid = await grab(LIDAR).catch(unlessTransient(null));
    let miss = 0;
    for (let k = 0; k < NE * NE; k++) { const v = lid ? sample(lid, L[k * 2], L[k * 2 + 1]) : NaN; e[k] = v; if (isNaN(v)) { if (inner(k)) miss++; } else if (inner(k)) count.lidar++; }
    if (miss) { // a gap inside the tile: RGE ALTI (1–5 m), then the parent; a gap only in the ring is extrapolated
      const rge = await grab(RGE).catch(unlessTransient(null));
      for (let k = 0; k < NE * NE; k++) if (isNaN(e[k])) {
        const v = rge ? sample(rge, L[k * 2], L[k * 2 + 1]) : NaN;
        if (!isNaN(v)) { e[k] = v; if (inner(k)) count.rge++; }
        else if (inner(k)) { e[k] = this.fromParent(k % NE - 1, ((k / NE) | 0) - 1); count.parent++; }
      }
    }
    const src = count.parent > count.lidar + count.rge ? this.parent?.src ?? 'global' : count.lidar >= count.rge ? 'lidar' : 'rge';
    return { e: extrapolateRing(e), src };
  }
  async loadPhoto() {
    const ep = this.engine.epoch;
    // historical mosaics stop at zoom 18 (≈ 50 cm, as fine as the old films go): finer tiles enlarge their parent
    if (this.z > (ep === 'current' ? PHOTO_MAXZ : 18)) return this.loadPhotoCrop();
    const { z, x, y } = this;
    if (ep !== 'current') {
      const [layer, fmt] = EPOCHS[ep];
      const old = await fetchBitmap(URL_IGN_PHOTO(z, x, y, layer, fmt)).catch(unlessTransient(null));
      if (old) { // a period that has nothing here answers transparent (PNG) or all white (JPEG): then today's photo
        // (white alone is not enough on a PNG period: snow and glaciers are white on those films)
        const d = pixels(old).data, n = d.length / 64; let clear = 0, white = 0;
        for (let k = 0; k < d.length; k += 64) { if (d[k + 3] < 128) clear++; else if (d[k] >= 254 && d[k + 1] >= 254 && d[k + 2] >= 254) white++; }
        if (clear < n * 0.05 && !(fmt === 'jpeg' && white > n * 0.98)) { this.epochOk = true; return this.engine.makeTexture(old); }
        old.close?.();
      }
      this.epochOk = false;
    }
    // a missing photo (404) is replaced below; a refused one makes the whole tile wait and retry
    const ign = await fetchBitmap(URL_IGN_PHOTO(z, x, y)).catch(unlessTransient(null));
    // outside France IGN returns white: fill those pixels from Sentinel-2 cloudless
    let needFill = !ign, data = null;
    if (ign) {
      data = pixels(ign); const d = data.data; let white = 0;
      for (let k = 0; k < d.length; k += 16) if (d[k] >= 254 && d[k + 1] >= 254 && d[k + 2] >= 254) white++;
      needFill = white > d.length / 16 * 0.01;
      if (!needFill) return this.engine.makeTexture(ign);
    }
    const ez = Math.min(z, 15), f = 2 ** (z - ez);
    const eox = await fetchBitmap(URL_EOX(ez, x >> (z - ez), y >> (z - ez))).catch(unlessTransient(null));
    const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d');
    if (eox) { const s = 256 / f; c.drawImage(eox, (x % f) * s, (y % f) * s, s, s, 0, 0, 256, 256); eox.close?.(); } else { c.fillStyle = '#9a9a96'; c.fillRect(0, 0, 256, 256); }
    const base = c.getImageData(0, 0, 256, 256), b = base.data, d = data?.data;
    for (let k = 0; k < b.length; k += 4) {
      if (d && !(d[k] >= 254 && d[k + 1] >= 254 && d[k + 2] >= 254)) { b[k] = d[k]; b[k + 1] = d[k + 1]; b[k + 2] = d[k + 2]; }
      else if (eox) eoxToIgn(b, k);
    }
    c.putImageData(base, 0, 0); ign?.close?.();
    return this.engine.makeTexture(await createImageBitmap(cv));
  }
  // beyond the finest photo: the quarter of the parent's photo (already in memory), smoothly enlarged
  async loadPhotoCrop() {
    const img = this.parent?.mesh?.material.uniforms.map.value?.image;
    if (!img) throw new TransientError('photo du parent absente');
    const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, (this.x & 1) * img.width / 2, (this.y & 1) * img.height / 2, img.width / 2, img.height / 2, 0, 0, 256, 256);
    return this.engine.makeTexture(await createImageBitmap(cv));
  }

  build(tex, e) {
    const cx = (this.x0 + this.x1) / 2, cz = (this.z0 + this.z1) / 2, dz = this.z1 - this.z0;
    const h = this.h = new Float32Array(NV * NV), E = (i, j) => e[(j + 1) * NE + i + 1];
    const pos = new Float32Array((NV * NV + SKIRT) * 3), nor = new Float32Array((NV * NV + SKIRT) * 3);
    // slope texture: the ground gradient at every grid point, in true metres (the scene's metres are web-mercator
    // metres scaled at the origin's latitude, off by up to 0.5 % at the edges of the area), as half floats that
    // the GPU interpolates per pixel. Slopes are measured on the ground, never on the exaggerated relief.
    const grad = new Uint16Array(NV * NV * 2), toHalf = THREE.DataUtils.toHalfFloat;
    const ground = Math.cos(worldToLonLat(cx, cz)[1] * Math.PI / 180) / K;
    let mn = Infinity, mx = -Infinity;
    const sx = this.size / N, sz = dz / N;
    for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
      const k = j * NV + i, v = h[k] = E(i, j); if (v < mn) mn = v; if (v > mx) mx = v;
      pos[k * 3] = this.x0 + i * sx - cx; pos[k * 3 + 1] = v; pos[k * 3 + 2] = this.z0 + j * sz - cz;
      const gx = (E(i + 1, j) - E(i - 1, j)) / (2 * sx), gz = (E(i, j + 1) - E(i, j - 1)) / (2 * sz);
      const l = Math.hypot(gx, 1, gz); nor[k * 3] = -gx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -gz / l;
      grad[k * 2] = toHalf(gx / ground); grad[k * 2 + 1] = toHalf(gz / ground);
    }
    const slopeTex = new THREE.DataTexture(grad, NV, NV, THREE.RGFormat, THREE.HalfFloatType);
    slopeTex.magFilter = slopeTex.minFilter = THREE.LinearFilter; slopeTex.generateMipmaps = false; slopeTex.needsUpdate = true;
    const drop = Math.max(5, this.size / N * 3);
    skirtSrc.forEach((src, t) => { const k = NV * NV + t; pos[k * 3] = pos[src * 3]; pos[k * 3 + 1] = pos[src * 3 + 1] - drop; pos[k * 3 + 2] = pos[src * 3 + 2]; nor.copyWithin(k * 3, src * 3, src * 3 + 3); });
    this.minH = mn - drop; this.maxH = mx;
    const g = new THREE.BufferGeometry();
    g.setIndex(sharedIndex); g.setAttribute('uv', sharedUV);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (mn + mx) / 2, 0), Math.hypot(this.size, dz, mx - mn));
    const mat = this.engine.makeMaterial(tex, this.size, slopeTex);
    this.mesh = new THREE.Mesh(g, mat); this.mesh.position.set(cx, 0, cz); this.mesh.matrixAutoUpdate = false; this.mesh.updateMatrix();
    this.mesh.frustumCulled = false; this.mesh.visible = false;
    this.mesh.userData.tile = this;
    this.engine.group.add(this.mesh);
    this.engine.attachOverlays(this);
    this.engine.onTileBuilt?.(this); // layers standing on the ground (forests…) hook here
  }
  dispose() {
    this.engine.onTileDisposed?.(this); this.engine.releaseOverlays(this);
    if (this.mesh) {
      this.engine.group.remove(this.mesh);
      // detach the shared index/uv first so dispose() only frees this tile's own buffers
      this.mesh.geometry.setIndex(null); this.mesh.geometry.deleteAttribute('uv');
      const u = this.mesh.material.uniforms;
      this.mesh.geometry.dispose(); u.map.value?.dispose(); u.slopeMap.value?.dispose(); this.mesh.material.dispose(); this.mesh = null;
    }
    this.h = null; this.state = 'idle'; this.gen = (this.gen || 0) + 1;
  }
}

// Does a Sentinel-2 image cover part of a tile? Its footprint (GeoJSON polygon, lon/lat) is a slanted swath edge,
// not a rectangle, so the tile is probed on a 9×9 grid of points after a quick bounding-box test.
function footprintCovers(item, z, x, y) {
  const m = tileMerc(z, x, y), [w, s] = mercToLonLat(m.minx, m.miny), [e, n] = mercToLonLat(m.maxx, m.maxy), b = item.bbox;
  if (b && !(e > b[0] && w < b[2] && n > b[1] && s < b[3])) return false;
  const g = item.footprint; if (!g) return true;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null; if (!polys) return true;
  const inRing = (px, py, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c; } return c; };
  const inside = (px, py) => polys.some(p => inRing(px, py, p[0]) && !p.slice(1).some(h => inRing(px, py, h)));
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) if (inside(w + (e - w) * i / 8, s + (n - s) * j / 8)) return true;
  return false;
}

// Fill the missing (NaN) samples of the outer ring by linear extrapolation from inside the tile. Used where the
// data stops at the tile edge (Terrarium tiles, the edge of the LiDAR coverage): the edge gradient then equals
// a one-sided difference, as before the ring existed.
function extrapolateRing(e) {
  const at = (i, j) => e[(j + 1) * NE + i + 1];
  for (let j = -1; j <= NV; j++) for (let i = -1; i <= NV; i++) {
    if (i >= 0 && j >= 0 && i <= N && j <= N) continue;
    const k = (j + 1) * NE + i + 1; if (!isNaN(e[k])) continue;
    const ci = Math.min(Math.max(i, 0), N), cj = Math.min(Math.max(j, 0), N);
    e[k] = 2 * at(ci, cj) - at(2 * ci - i, 2 * cj - j);
  }
  return e;
}

// ---------- engine ----------
export class TerrainEngine {
  constructor({ renderer, scene, uniforms, vertexShader, fragmentShader, bounds }) {
    this.renderer = renderer; this.uniforms = uniforms; this.vs = vertexShader; this.fs = fragmentShader;
    this.group = new THREE.Group(); scene.add(this.group);
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.frame = 0; this.loading = 0; this.maxLoads = 8; this.splitK = 2; this.maxTiles = 700; this.exag = 1; this.epoch = 'current';
    this.frustum = new THREE.Frustum(); this.pv = new THREE.Matrix4();
    this.overlay = { item: null, snow: false, vis: false, forest: true, clpa: false, cache: new Map(), pending: new Set(), active: 0 };
    // roots: zoom-11 tiles, first over the massif and its surroundings, then wherever the camera goes (ensureRoots)
    const [ax, ay] = lonLatToTile(bounds[0], bounds[3], 11), [bx, by] = lonLatToTile(bounds[2], bounds[1], 11);
    this.roots = []; this.rootKeys = new Map();
    for (let y = Math.floor(ay); y <= Math.floor(by); y++) for (let x = Math.floor(ax); x <= Math.floor(bx); x++) this.addRoot(x, y);
    this.drawn = [];
  }
  addRoot(x, y) { const t = new Tile(this, 11, x, y, null); this.roots.push(t); this.rootKeys.set(`${x}/${y}`, t); }
  // Free navigation: keep zoom-11 tiles loaded within `radius` metres of a point (the view's centre), drop those
  // far behind (1.6 × radius) so memory stays bounded however far one travels.
  ensureRoots(x, z, radius) {
    const [lon, lat] = worldToLonLat(x, z), [tx, ty] = lonLatToTile(lon, lat, 11);
    const span = Math.ceil(radius / this.roots[0].size) + 1;
    for (let y = Math.floor(ty) - span; y <= Math.floor(ty) + span; y++) for (let xx = Math.floor(tx) - span; xx <= Math.floor(tx) + span; xx++) {
      if (this.rootKeys.has(`${xx}/${y}`)) continue;
      const m = tileMerc(11, xx, y), [cx, cz] = mercToWorld((m.minx + m.maxx) / 2, (m.miny + m.maxy) / 2);
      if (Math.hypot(cx - x, cz - z) < radius) this.addRoot(xx, y);
    }
    const kill = n => { n.children?.forEach(kill); n.children = null; n.dispose(); };
    this.roots = this.roots.filter(r => {
      if (Math.hypot((r.x0 + r.x1) / 2 - x, (r.z0 + r.z1) / 2 - z) < radius * 1.6) return true;
      kill(r); this.rootKeys.delete(`${r.x}/${r.y}`); return false;
    });
  }
  makeTexture(bitmap) {
    const t = new THREE.Texture(bitmap); t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.anisotropy = this.aniso;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
    return t;
  }
  makeMaterial(tex, tileSize, slopeTex) {
    return new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, map: { value: tex }, slopeMap: { value: slopeTex }, ndsiMap: { value: null }, cloudMap: { value: null }, visMap: { value: null }, forestMap: { value: null }, clpaMap: { value: null }, ovRect: { value: new THREE.Vector4(0, 0, 1, 1) }, clpaRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        hasNdsi: { value: 0 }, hasCloud: { value: 0 }, hasVis: { value: 0 }, hasForest: { value: 0 }, hasClpa: { value: 0 }, tileSize: { value: tileSize } },
      vertexShader: this.vs, fragmentShader: this.fs
    });
  }

  // ----- Sentinel-2 overlays, shared per zoom-<=14 tile -----
  // ndsi: continuous snow index (B03-B11)/(B03+B11) - smooth to interpolate, unlike the 10 m class map
  // cloud: clouds and cloud shadows from the scene classification, softened into a mask
  // vis: true colours of the day, used to re-colour the 20 cm photo rather than to replace it
  // forest: what grows in the forests (IGN BD Forêt, foresttypes.js), for the colours of the season; not a satellite image
  setOverlayItem(item) {
    if (item?.id === this.overlay.item?.id) return; // the same pass: its tiles are already there
    this.overlay.item = item;
    for (const [k, o] of this.overlay.cache) if (o.kind !== 'forest') { o.tex?.dispose(); this.overlay.cache.delete(k); this.overlay.pending.delete(k); }
    this.forEachReady(t => this.attachOverlays(t));
  }
  setOverlay(kind, on) { this.overlay[kind] = on; this.forEachReady(t => this.attachOverlays(t)); }
  forEachReady(fn) { const walk = t => { if (t.state === 'ready') fn(t); t.children?.forEach(walk); }; this.roots.forEach(walk); }
  overlayUrl(kind, z, x, y) {
    if (kind === 'forest') { const m = tileMerc(z, x, y); return FOREST_WMS([m.minx, m.miny, m.maxx, m.maxy], 256, 256); }
    if (kind === 'clpa') { const m = tileMerc(z, x, y); return CLPA_WMS([m.minx, m.miny, m.maxx, m.maxy]); }
    const base = `https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/${z}/${x}/${y}@1x.png?collection=sentinel-2-l2a&item=${this.overlay.item.id}`;
    if (kind === 'ndsi') return base + '&expression=' + encodeURIComponent('(B03-B11)/(B03+B11)') + '&asset_as_band=true&rescale=-1,1';
    if (kind === 'cloud') return base + '&assets=SCL&nodata=0&resampling=nearest';
    return base + '&assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0';
  }
  async overlayTexture(kind, z, x, y) {
    // maps that do not change are kept offline, and so are the tiles of the pass chosen to be kept (today's snow);
    // not those of every date of the snow film, which would fill the device
    const keep = kind === 'forest' || kind === 'clpa' || this.overlay.item?.id === this.overlay.keepId;
    let bm = await fetchBitmap(this.overlayUrl(kind, z, x, y), keep);
    if (kind === 'forest') { // legend colours -> shares of broadleaf, larch, pine (foresttypes.js)
      const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(bm, 0, 0); const img = c.getImageData(0, 0, 256, 256); img.data.set(decodeForest(img.data)); c.putImageData(img, 0, 0);
      bm.close?.(); bm = await createImageBitmap(cv, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    }
    if (kind === 'cloud') { // class map -> soft mask (red = cloud or cloud shadow, alpha = data)
      const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(bm, 0, 0); const img = c.getImageData(0, 0, 256, 256), d = img.data;
      for (let k = 0; k < d.length; k += 4) { const v = d[k], ok = d[k + 3] > 0 && v > 0, cl = ok && (v === 3 || (v >= 8 && v <= 10)); d[k] = d[k + 1] = d[k + 2] = cl ? 255 : 0; d[k + 3] = ok ? 255 : 0; }
      c.putImageData(img, 0, 0);
      const cv2 = document.createElement('canvas'); cv2.width = cv2.height = 256; const c2 = cv2.getContext('2d');
      c2.filter = 'blur(1.2px)'; c2.drawImage(cv, 0, 0); bm.close?.(); bm = await createImageBitmap(cv2);
    }
    const tx = new THREE.Texture(bm); tx.flipY = false; tx.colorSpace = THREE.NoColorSpace; tx.generateMipmaps = false;
    tx.minFilter = tx.magFilter = THREE.LinearFilter; tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping; tx.needsUpdate = true;
    return tx;
  }
  // Satellite tiles are slow to come (the server renders them on demand): at most `max` in flight, and always
  // the nearest to the camera first, so the slope one looks at does not wait behind the far distance.
  pumpOverlays(max = 8) {
    const ov = this.overlay; if (!ov.pending.size || ov.active >= max || !this.cam) return;
    const list = [...ov.pending].map(k => [k, ov.cache.get(k)]).filter(([, o]) => o && !o.started);
    list.sort((a, b) => Math.hypot(a[1].cx - this.cam.x, a[1].cz - this.cam.z) - Math.hypot(b[1].cx - this.cam.x, b[1].cz - this.cam.z));
    for (const [key, o] of list.slice(0, max - ov.active)) {
      o.started = true; ov.pending.delete(key); ov.active++;
      this.overlayTexture(o.kind, o.oz, o.ox, o.oy).then(tx => { if (ov.cache.get(key) !== o) return tx.dispose(); o.tex = tx; o.waiters.forEach(w => w()); o.waiters = []; })
        .catch(err => { if (err instanceof TransientError && ov.cache.get(key) === o) ov.cache.delete(key); }) // asked again by the next tile built here
        .finally(() => { ov.active--; });
    }
  }
  attachOverlays(t) {
    if (!t.mesh) return;
    const u = t.mesh.material.uniforms;
    // zoom-13 overlay tiles (≈ 13 m per pixel, close to Sentinel-2's 10 m): 4× fewer requests than zoom 14,
    // which the tile server could not serve fast enough (the summit waited behind a thousand requests)
    const oz = Math.min(t.z, 13), f = 2 ** (t.z - oz), ox = t.x >> (t.z - oz), oy = t.y >> (t.z - oz);
    u.ovRect.value.set((t.x % f) / f, (t.y % f) / f, 1 / f, 1 / f);
    // with today's snow on, the true colours of the same clear pass are needed too: they replace the snow that
    // the (older) aerial photo shows where the satellite now sees bare ground
    const kinds = { ndsi: this.overlay.snow, cloud: this.overlay.snow || this.overlay.vis, vis: this.overlay.vis || this.overlay.snow, forest: this.overlay.forest, clpa: this.overlay.clpa };
    // the avalanche map has narrow gullies: its own tiles, at zoom 15 (≈ 5 m per pixel)
    const cz = Math.min(t.z, 15), cf = 2 ** (t.z - cz);
    u.clpaRect.value.set((t.x % cf) / cf, (t.y % cf) / cf, 1 / cf, 1 / cf);
    // only ask for tiles that the satellite image covers (outside its footprint the server answers 404)
    const covered = !this.overlay.item || footprintCovers(this.overlay.item, oz, ox, oy);
    this.releaseOverlays(t);
    for (const [kind, on] of Object.entries(kinds)) {
      const has = 'has' + kind[0].toUpperCase() + kind.slice(1), map = kind + 'Map';
      const sat = kind !== 'forest' && kind !== 'clpa'; // the satellite overlays need a pass that covers the tile
      if (!on || (sat && (!this.overlay.item || !covered))) { u[has].value = 0; continue; }
      const kz = kind === 'clpa' ? cz : oz, kx = t.x >> (t.z - kz), ky = t.y >> (t.z - kz);
      const key = `${kind}/${kz}/${kx}/${ky}`;
      let o = this.overlay.cache.get(key);
      if (!o) { // queued; pumpOverlays() starts the ones nearest the camera first
        const m = tileMerc(kz, kx, ky), [mx, mz] = mercToWorld((m.minx + m.maxx) / 2, (m.miny + m.maxy) / 2);
        o = { tex: null, waiters: [], users: new Set(), kind, oz: kz, ox: kx, oy: ky, cx: mx, cz: mz, started: false }; this.overlay.cache.set(key, o); this.overlay.pending.add(key);
      }
      o.users.add(t); t.ovUsed.push(o);
      const apply = () => { if (!t.mesh) return; u[map].value = o.tex; u[has].value = 1; };
      if (o.tex) apply(); else { u[has].value = 0; o.waiters.push(apply); }
    }
  }

  // ----- per-frame selection -----
  update(camera) {
    this.frame++;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.pv);
    this.cam = camera.position;
    for (const m of this.drawn) m.visible = false;
    this.drawn = []; this.wanted = [];
    for (const r of this.roots) this.visit(r);
    // start the most urgent loads
    this.wanted.sort((a, b) => a.p - b.p);
    const now = performance.now();
    for (const w of this.wanted) {
      if (this.loading >= this.maxLoads) break;
      if (w.t.state !== 'idle' || w.t.retryAt > now) continue;
      this.loading++;
      w.t.load().catch(() => { w.t.state = 'idle'; }).finally(() => { this.loading--; });
    }
    if (this.frame % 30 === 0) this.evict();
    if (this.frame % 600 === 0) this.evictOverlays();
    if (this.frame % 5 === 0) this.pumpOverlays();
    for (const m of this.drawn) m.visible = true;
  }
  want(t, p) { t.lastSeen = this.frame; if (t.state === 'idle') this.wanted.push({ t, p }); }
  visit(t) {
    t.lastSeen = this.frame;
    if (t.state !== 'ready') { this.want(t, -100 + t.z); return; }
    const e = this.exag;
    t.box.min.set(t.x0, t.minH * e, t.z0); t.box.max.set(t.x1, t.maxH * e, t.z1);
    if (!this.frustum.intersectsBox(t.box)) return;
    const d = Math.max(t.box.distanceToPoint(this.cam), 1);
    if (t.z < MAXZ && d < t.size * this.splitK) {
      const kids = t.ensureChildren();
      let ready = true;
      for (const c of kids) if (c.state !== 'ready') { ready = false; this.want(c, d / t.size + (MAXZ - c.z) * 0.01); }
      if (ready) { for (const c of kids) this.visit(c); return; }
    }
    this.drawn.push(t.mesh);
  }
  evict() {
    const all = []; const walk = t => { if (t.state === 'ready' && t.parent) all.push(t); t.children?.forEach(walk); };
    this.roots.forEach(walk);
    this.tileCount = all.length;
    if (all.length <= this.maxTiles) return;
    all.sort((a, b) => a.lastSeen - b.lastSeen);
    for (let i = 0; i < all.length - this.maxTiles; i++) {
      const t = all[i]; if (this.frame - t.lastSeen < 90) break;
      const kill = n => { n.children?.forEach(kill); n.children = null; n.dispose(); };
      kill(t);
    }
  }
  // overlay tiles no relief tile uses any more (its tiles were evicted, or the camera went elsewhere) are freed
  // from the graphics memory; needed again, they come back (from the device's cache for most of them)
  releaseOverlays(t) { for (const o of t.ovUsed ?? []) o.users.delete(t); t.ovUsed = []; }
  evictOverlays() {
    for (const [k, o] of this.overlay.cache) {
      if (o.users.size || (o.started && !o.tex)) continue; // (in flight: left to finish)
      o.tex?.dispose(); this.overlay.cache.delete(k); this.overlay.pending.delete(k);
    }
  }
  setExaggeration(e) { this.exag = e; }
  // aerial photos of another period: every tile is rebuilt (relief from the cache, photos of that period)
  setEpoch(e) {
    if (!EPOCHS[e] || e === this.epoch) return;
    this.epoch = e;
    const kill = n => { n.children?.forEach(kill); n.children = null; n.dispose(); };
    this.roots.forEach(kill);
  }
  // share of the drawn tiles that have a photo of the chosen period (the others show today's)
  get epochCover() {
    if (this.epoch === 'current') return 1;
    const ts = this.drawn.map(m => m.userData.tile).filter(t => t && t.z >= 13); if (!ts.length) return null;
    return ts.filter(t => t.epochOk || (t.z > 18 && t.parent?.epochOk)).length / ts.length;
  }

  // deepest loaded tile under a point (null when nothing is loaded yet)
  tileAt(x, z) {
    let t = this.roots.find(r => r.contains(x, z));
    if (!t || t.state !== 'ready') return null;
    for (;;) {
      const c = t.children?.find(k => k.state === 'ready' && k.contains(x, z));
      if (!c) return t; t = c;
    }
  }
  heightAt(x, z) { return this.tileAt(x, z)?.heightAt(x, z) ?? null; }
  // ground slope at a point, as drawn by the slope map: degrees, direction the slope faces (degrees from north,
  // clockwise), the distance it is measured over, and where the relief comes from
  slopeAt(x, z) {
    const t = this.tileAt(x, z); if (!t) return null;
    const d = t.size / N, ground = Math.cos(worldToLonLat(x, z)[1] * Math.PI / 180) / K;
    const h = (a, b) => this.heightAt(a, b) ?? t.heightAt(a, b);
    const gx = (h(x + d, z) - h(x - d, z)) / (2 * d * ground), gz = (h(x, z + d) - h(x, z - d)) / (2 * d * ground);
    return { deg: Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI, aspect: (Math.atan2(-gx, gz) * 180 / Math.PI + 360) % 360, step: d * ground, src: t.src };
  }
  get busy() { return this.loading; }
}
