// Decodes one node of an IGN LiDAR HD point cloud (COPC: LAZ chunks) off the main thread, so the view never
// stutters while points arrive. For each point: position in the scene's frame, colour from the aerial photo under
// it, a normal estimated from its neighbours (so points take the same sun and shadows as the relief) and its class.
// laz-perf is the LAZ decoder of PDAL, compiled to WebAssembly.
const LAZPERF = 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/worker/';
importScripts(LAZPERF + 'laz-perf.js');
const lazPerf = createLazPerf({ locateFile: f => LAZPERF + f });

// noise and artefacts are never drawn: low/high noise (7, 18), IGN artefacts (65) and virtual points (66)
const SKIP = new Set([7, 18, 65, 66]);

self.onmessage = async ({ data: m }) => {
  try {
    const out = decode(await lazPerf, m);
    self.postMessage({ id: m.id, ...out }, [out.pos.buffer, out.col.buffer, out.nrm.buffer]);
  } catch (e) { self.postMessage({ id: m.id, error: String(e?.message || e) }); }
};

function decode(L, m) {
  const { count, len, scale, offset, X0, Y0, Z0, A, photo } = m;
  const src = new Uint8Array(m.buf);
  const blob = L._malloc(src.byteLength), one = L._malloc(len), dec = new L.ChunkDecoder();
  // ground-frame (x east, y up, z south) relative to the node centre, class, intensity
  const P = new Float32Array(count * 3), cls = new Uint8Array(count), inten = new Uint16Array(count);
  let n = 0;
  try {
    L.HEAPU8.set(src, blob);
    dec.open(6, len, blob);
    let dv = new DataView(L.HEAPU8.buffer, one, len);
    for (let i = 0; i < count; i++) {
      dec.getPoint(one);
      // the WebAssembly memory may grow while decoding, which replaces its buffer: follow it
      if (dv.buffer !== L.HEAPU8.buffer) dv = new DataView(L.HEAPU8.buffer, one, len);
      const c = dv.getUint8(16);
      if (SKIP.has(c)) continue;
      const X = dv.getInt32(0, true) * scale[0] + offset[0] - X0, Y = dv.getInt32(4, true) * scale[1] + offset[1] - Y0;
      P[n * 3] = A[0] * X + A[1] * Y; P[n * 3 + 2] = A[2] * X + A[3] * Y;
      P[n * 3 + 1] = dv.getInt32(8, true) * scale[2] + offset[2] - Z0;
      cls[n] = c; inten[n] = dv.getUint16(12, true); n++;
    }
  } finally { L._free(blob); L._free(one); dec.delete(); }

  // normals: principal axes of the neighbourhood (a 3×3×3 block of voxels 2.5 point spacings wide)
  const nrm = new Int8Array(n * 4), v = m.spacing * 2.5, cells = new Map();
  const key = (i, j, k) => (i + 512) + (j + 512) * 1024 + (k + 512) * 1048576;
  for (let p = 0; p < n; p++) {
    const k = key(Math.floor(P[p * 3] / v), Math.floor(P[p * 3 + 1] / v), Math.floor(P[p * 3 + 2] / v));
    let s = cells.get(k); if (!s) cells.set(k, s = new Float64Array(10));
    const x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    s[0]++; s[1] += x; s[2] += y; s[3] += z; s[4] += x * x; s[5] += y * y; s[6] += z * z; s[7] += x * y; s[8] += x * z; s[9] += y * z;
  }
  const normalOf = new Map(), acc = new Float64Array(10);
  for (const k of cells.keys()) {
    const i = k % 1024, j = Math.floor(k / 1024) % 1024, kk = Math.floor(k / 1048576);
    acc.fill(0);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const s = cells.get((i + a) + (j + b) * 1024 + (kk + c) * 1048576); if (s) for (let q = 0; q < 10; q++) acc[q] += s[q];
    }
    normalOf.set(k, acc[0] >= 4 ? smallestAxis(acc) : [0, 1, 0]); // too few neighbours: facing up
  }
  for (let p = 0; p < n; p++) {
    const k = key(Math.floor(P[p * 3] / v), Math.floor(P[p * 3 + 1] / v), Math.floor(P[p * 3 + 2] / v)), N = normalOf.get(k);
    const up = N[1] < 0 ? -1 : 1; // unoriented: towards the sky (the scanner flew above); flipped to the viewer when drawn
    nrm[p * 4] = Math.round(N[0] * up * 127); nrm[p * 4 + 1] = Math.round(N[1] * up * 127); nrm[p * 4 + 2] = Math.round(N[2] * up * 127);
    nrm[p * 4 + 3] = cls[p];
  }

  // colour: the aerial photo under the point (bilinear), and the laser's own return strength as a gentle
  // brightness variation (it shows real texture on rock faces, where the vertical photo is smeared)
  const col = new Uint8Array(n * 4), sample = [];
  for (let p = 0; p < n; p += Math.max(1, Math.floor(n / 512))) sample.push(inten[p]);
  sample.sort((a, b) => a - b);
  const med = Math.max(1, sample[sample.length >> 1] || 1);
  const B = photo?.B, px = photo?.pix, W = photo?.w, H = photo?.h;
  for (let p = 0; p < n; p++) {
    let r = 128, g = 128, b = 124, ok = false;
    if (px) {
      // back to node-local Lambert-93 (A is a rotation and scale: invert it) then to photo pixels
      const x = P[p * 3], z = P[p * 3 + 2], X = m.Ainv[0] * x + m.Ainv[1] * z, Y = m.Ainv[2] * x + m.Ainv[3] * z;
      const fx = B[0] * X + B[1] * Y + B[2] - 0.5, fy = B[3] * X + B[4] * Y + B[5] - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix >= 0 && iy >= 0 && ix < W - 1 && iy < H - 1) {
        const tx = fx - ix, ty = fy - iy, k0 = (iy * W + ix) * 4, k1 = k0 + W * 4;
        if (px[k0 + 3] && px[k0 + 7] && px[k1 + 3] && px[k1 + 7]) {
          const bl = o => (px[k0 + o] * (1 - tx) + px[k0 + 4 + o] * tx) * (1 - ty) + (px[k1 + o] * (1 - tx) + px[k1 + 4 + o] * tx) * ty;
          r = bl(0); g = bl(1); b = bl(2); ok = true;
        }
      }
    }
    col[p * 4] = r; col[p * 4 + 1] = g; col[p * 4 + 2] = b;
    // alpha: intensity ratio to the node's median, 0.4–1.8 stored as 0–255; 0 = no photo here
    col[p * 4 + 3] = ok ? Math.max(1, Math.round((Math.min(1.8, Math.max(0.4, inten[p] / med)) - 0.4) / 1.4 * 254) + 1) : 0;
  }
  // ground points last: the view can then leave them out (setDrawRange) where the relief mesh, built from these
  // very ground points, already draws the ground. Low vegetation (< 0.5 m) goes with them: in the mountains it is
  // mostly rough rock taken for vegetation, and on a meadow it is the meadow the photo already shows.
  const surface = c => c === 2 || c === 3;
  const order = new Uint32Array(n); let above = 0;
  for (let p = 0; p < n; p++) if (!surface(cls[p])) order[above++] = p;
  let g = above; for (let p = 0; p < n; p++) if (surface(cls[p])) order[g++] = p;
  const pos = new Float32Array(n * 3), col2 = new Uint8Array(n * 4), nrm2 = new Int8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = order[i];
    pos[i * 3] = P[p * 3]; pos[i * 3 + 1] = P[p * 3 + 1]; pos[i * 3 + 2] = P[p * 3 + 2];
    for (let q = 0; q < 4; q++) { col2[i * 4 + q] = col[p * 4 + q]; nrm2[i * 4 + q] = nrm[p * 4 + q]; }
  }
  return { n, above, pos, col: col2, nrm: nrm2 };
}

// eigenvector of the smallest eigenvalue of the covariance of a point set (sums in s): the surface normal
function smallestAxis(s) {
  const n = s[0], mx = s[1] / n, my = s[2] / n, mz = s[3] / n;
  const a = s[4] / n - mx * mx, d = s[5] / n - my * my, f = s[6] / n - mz * mz, b = s[7] / n - mx * my, c = s[8] / n - mx * mz, e = s[9] / n - my * mz;
  // eigenvalues of [[a b c][b d e][c e f]] (trigonometric solution for symmetric matrices)
  const p1 = b * b + c * c + e * e, q = (a + d + f) / 3;
  let lmin;
  if (p1 < 1e-12) lmin = Math.min(a, d, f);
  else {
    const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1, p = Math.sqrt(p2 / 6);
    const B = [(a - q) / p, b / p, c / p, (d - q) / p, e / p, (f - q) / p];
    const r = (B[0] * (B[3] * B[5] - B[4] * B[4]) - B[1] * (B[1] * B[5] - B[4] * B[2]) + B[2] * (B[1] * B[4] - B[3] * B[2])) / 2;
    const phi = Math.acos(Math.min(1, Math.max(-1, r))) / 3;
    lmin = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  }
  // the normal is orthogonal to the rows of (C - λ I): cross product of the two best-conditioned rows
  const r0 = [a - lmin, b, c], r1 = [b, d - lmin, e], r2 = [c, e, f - lmin];
  const cr = (u, w) => [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  let best = [0, 1, 0], bl = 0;
  for (const v of [cr(r0, r1), cr(r0, r2), cr(r1, r2)]) { const l = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]; if (l > bl) { bl = l; best = v; } }
  const l = Math.sqrt(bl); return l > 0 ? [best[0] / l, best[1] / l, best[2] / l] : [0, 1, 0];
}
