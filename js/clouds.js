// Clouds in volume, where the forecast puts them. The model's cloud cover at each pressure level (with the
// level's altitude, live.js → cloudProfile) gives the share of sky covered at every altitude; a tileable 3D noise
// gives the clouds their shapes, eroded more where the cover is low (scattered cumulus) and less where it is
// full (a solid deck: the sea of clouds, or the massif inside the fog). Drawn by marching rays through the cloud
// layers at half resolution, stopping at the relief (scene depth), with light from the sun (shadowing inside the
// cloud, forward scattering) and from the sky. The final image pass (post.js) lays them over the scene.
import * as THREE from 'three';

const MAX_ALT = 12000; // metres: top of the profile texture

// tileable 3D noise, N³ texels, two channels: R = cloud shapes (value-noise fbm carved by Worley cells, billowy),
// G = small-scale detail (Worley fbm) that erodes the edges. Built once, ~100 ms.
function cloudNoise(N = 64) {
  const hash = (x, y, z) => { let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const wrap = (v, p) => ((v % p) + p) % p;
  const value = (x, y, z, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const H = (a, b, c) => hash(wrap(xi + a, p), wrap(yi + b, p), wrap(zi + c, p));
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(H(0, 0, 0), H(1, 0, 0), u), l(H(0, 1, 0), H(1, 1, 0), u), v), l(l(H(0, 0, 1), H(1, 0, 1), u), l(H(0, 1, 1), H(1, 1, 1), u), v), w);
  };
  const worley = (x, y, z, p) => { // 1 - distance to the nearest feature point, cells wrapped every p
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let best = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cx = xi + a, cy = yi + b, cz = zi + c, wx = wrap(cx, p), wy = wrap(cy, p), wz = wrap(cz, p);
      const dx = cx + hash(wx, wy, wz) - x, dy = cy + hash(wy, wz, wx) - y, dz = cz + hash(wz, wx, wy) - z;
      best = Math.min(best, dx * dx + dy * dy + dz * dz);
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  const n3 = N * N * N, shape = new Float32Array(n3), detail = new Float32Array(n3), s = 1 / N;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, a = 0.5, f = 4; for (let o = 0; o < 3; o++) { v += a * value(x * s * f, y * s * f, z * s * f, f); a *= 0.5; f *= 2; }
    const w1 = worley(x * s * 4, y * s * 4, z * s * 4, 4), w2 = worley(x * s * 8, y * s * 8, z * s * 8, 8), w3 = worley(x * s * 16, y * s * 16, z * s * 16, 16);
    const wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125, k = (z * N + y) * N + x;
    // "Perlin-Worley": the smooth noise lifted by the cells, which gives round, billowing shapes
    shape[k] = (v / 0.875 + wfbm) / 2 + v * wfbm * 0.5; detail[k] = w2 * 0.6 + w3 * 0.4;
  }
  // equalised: each value becomes its rank, so a threshold at 1 − c leaves exactly a share c of cloud, as forecast
  const equalise = arr => { const sorted = Float32Array.from(arr).sort(), out = new Uint8Array(arr.length); for (let i = 0; i < arr.length; i++) { let lo = 0, hi = sorted.length; const v = arr[i]; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } out[i] = Math.round(lo / sorted.length * 255); } return out; };
  const S = equalise(shape), D = equalise(detail), data = new Uint8Array(n3 * 4);
  for (let k = 0; k < n3; k++) { data[k * 4] = S[k]; data[k * 4 + 1] = D[k]; data[k * 4 + 3] = 255; }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}

const FS = `
precision highp sampler3D;
uniform sampler2D depthTex, profile; uniform sampler3D noise;
uniform mat4 invProj, invView; uniform vec3 camPos, sunDir, sunCol, skyCol, horizonCol;
uniform float exag, time, steps, lightSteps, hMin, hMax;
uniform vec2 wind;
varying vec2 vUv;
float cover(float alt){ return texture2D(profile, vec2(clamp(alt / ${MAX_ALT}.0, 0.0, 1.0), 0.5)).r; }
float density(vec3 p, float detail){
  float alt = p.y / exag, c = cover(alt);
  if (c < 0.01) return 0.0;
  vec3 q = vec3(p.x + wind.x * time, alt, p.z + wind.y * time);
  float base = texture(noise, q / vec3(7000.0, 2600.0, 7000.0)).r;
  // the cover decides how much of the noise becomes cloud: a few round cells at 20 %, a solid deck at 100 %
  float d = smoothstep(1.0 - c - 0.08, 1.0 - c + 0.28, base);
  if (d <= 0.0 || detail < 0.5) return d;
  float det = texture(noise, q / vec3(1300.0, 900.0, 1300.0)).g;
  return clamp(d - det * 0.45 * (1.0 - d * 0.6), 0.0, 1.0);
}
float hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
void main(){
  float depth = texture2D(depthTex, vUv).r;
  vec4 v = invProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0); v /= v.w;
  float sceneDist = depth >= 0.99999 ? 1e9 : length(v.xyz);
  vec4 f = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0); f /= f.w;
  vec3 dir = normalize((invView * vec4(f.xyz, 0.0)).xyz);
  float y0 = hMin * exag, y1 = hMax * exag, t0, t1;
  if (abs(dir.y) < 1e-5) { t0 = 0.0; t1 = (camPos.y > y0 && camPos.y < y1) ? 1e9 : -1.0; }
  else { float ta = (y0 - camPos.y) / dir.y, tb = (y1 - camPos.y) / dir.y; t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb); }
  t1 = min(t1, min(sceneDist, 120000.0)); // far enough for a cloud deck to reach the horizon
  if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // steps: the path split evenly, but never longer than 6 % of the distance (fine near the eye, inside a cloud
  // or fog; coarser far away), at most twice the step budget. Start offset by a smooth per-pixel pattern
  // (interleaved gradient noise), which the final pass blurs away.
  float even = (t1 - t0) / steps, jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float T = 1.0; vec3 S = vec3(0.0); float tSum = 0.0, wSum = 0.0;
  float t = t0, len = min(even, max(30.0, t0 * 0.06)); t += len * jit;
  float mu = dot(dir, sunDir), phase = mix(hg(mu, 0.6), hg(mu, -0.25), 0.35);
  vec3 sun = sunCol * step(-0.05, sunDir.y);
  for (int i = 0; i < 96; i++) {
    if (float(i) >= steps * 2.0 || T < 0.02 || t > t1) break;
    len = min(even, max(30.0, t * 0.06));
    vec3 p = camPos + dir * t;
    t += len;
    float d = density(p, 1.0);
    if (d < 0.003) continue;
    float sigma = d * 0.012; // extinction (1/m): a full deck is opaque within ~300 m
    // light reaching this point from the sun through the cloud above it (a few longer and longer steps)
    float od = 0.0, l = 120.0;
    for (int k = 0; k < 5; k++) { if (float(k) >= lightSteps) break; od += density(p + vec3(sunDir.x, sunDir.y * exag, sunDir.z) * l, 0.0) * 0.012 * l; l *= 2.2; }
    float alt01 = clamp((p.y / exag - hMin) / max(hMax - hMin, 1.0), 0.0, 1.0);
    vec3 direct = sun * (exp(-od) + 0.25 * exp(-od * 0.25)) * phase * 7.0 * (1.0 - exp(-sigma * 600.0)); // + multiple scattering, powder
    vec3 ambient = skyCol * (0.55 + 0.45 * alt01) * 0.9 + pow(horizonCol, vec3(2.2)) * 0.15;
    vec3 Ls = direct + ambient;
    float a = exp(-sigma * len);
    S += T * Ls * (1.0 - a); tSum += t * T * (1.0 - a); wSum += T * (1.0 - a);
    T *= a;
  }
  // aerial perspective on the clouds themselves: far clouds fade into the horizon's colour
  float dAvg = wSum > 0.0 ? tSum / wSum : t0, fog = 1.0 - exp(-dAvg * 0.000022);
  S = mix(S, pow(horizonCol, vec3(2.2)) * (1.0 - T), fog * 0.8);
  gl_FragColor = vec4(S, T);
}`;

export class VolumeClouds {
  constructor(renderer, uniforms) {
    this.renderer = renderer; this.U = uniforms; this.on = false; this.rt = null; this.scale = 0.5;
    // shadows of the clouds on the ground: the shared uniforms clNoise, clOn, clAlt, clCover, clWind (SCENE_GLSL)
    uniforms.clWind.value = new THREE.Vector2(3, 1);
    this.noise = null; this.profileData = new Uint8Array(256 * 4); this.hMin = 0; this.hMax = 0; this.any = false;
    this.profile = new THREE.DataTexture(this.profileData, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.profile.minFilter = this.profile.magFilter = THREE.LinearFilter; this.profile.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        depthTex: { value: null }, profile: { value: this.profile }, noise: { value: null },
        invProj: { value: new THREE.Matrix4() }, invView: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
        sunDir: uniforms.sunDir, sunCol: uniforms.sunCol, skyCol: uniforms.skyCol, horizonCol: uniforms.horizonCol, exag: uniforms.exag, time: uniforms.time,
        steps: { value: 32 }, lightSteps: { value: 4 }, hMin: { value: 0 }, hMax: { value: 0 }, wind: uniforms.clWind
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: FS, depthTest: false, depthWrite: false
    });
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); q.frustumCulled = false; this.scene.add(q);
  }
  get active() { return this.on && this.any; }
  // cloud shadows only where the clouds themselves are drawn
  syncShadows() { this.U.clOn.value = this.active && this.noise ? 1 : 0; }
  setQuality(steps, lightSteps) { this.mat.uniforms.steps.value = steps; this.mat.uniforms.lightSteps.value = lightSteps; }
  setWind(x, z) { this.U.clWind.value.set(x, z); }
  // levels: [{ alt, cover }] low to high (null: no clouds drawn). Cover is linear between levels and fades out
  // 400 m below the lowest level and above the highest one that has cloud.
  setProfile(levels) {
    const d = this.profileData; d.fill(0); this.any = false;
    if (levels?.length) {
      let lo = Infinity, hi = -Infinity, best = 0;
      for (let i = 0; i < 256; i++) {
        const alt = i / 255 * MAX_ALT; let c = 0;
        if (alt <= levels[0].alt) c = levels[0].cover * Math.max(0, 1 - (levels[0].alt - alt) / 400);
        else if (alt >= levels[levels.length - 1].alt) c = levels[levels.length - 1].cover * Math.max(0, 1 - (alt - levels[levels.length - 1].alt) / 400);
        else for (let k = 0; k < levels.length - 1; k++) { const a = levels[k], b = levels[k + 1]; if (alt >= a.alt && alt <= b.alt) { c = a.cover + (b.cover - a.cover) * (alt - a.alt) / (b.alt - a.alt); break; } }
        d[i * 4] = Math.round(Math.min(1, c) * 255); d[i * 4 + 3] = 255;
        if (c > 0.02) { lo = Math.min(lo, alt); hi = Math.max(hi, alt); }
        // the ground is shaded mostly by the densest layer (the lowest one if several are as dense)
        if (c > best + 0.05) { best = c; this.U.clAlt.value = alt; this.U.clCover.value = c; }
      }
      if (hi > lo) { this.any = true; this.hMin = lo - 60; this.hMax = hi + 60; }
    }
    this.profile.needsUpdate = true;
    this.mat.uniforms.hMin.value = this.hMin; this.mat.uniforms.hMax.value = this.hMax; this.syncShadows();
  }
  // into a half-resolution buffer: rgb = light scattered towards the eye (linear), a = transmittance
  render(camera, depthTexture, w, h) {
    if (!this.noise) { this.noise = cloudNoise(); this.mat.uniforms.noise.value = this.noise; this.U.clNoise.value = this.noise; this.syncShadows(); }
    // half resolution, and never more than ~0.45 million pixels (large phone and tablet screens)
    const sc = Math.min(this.scale, Math.sqrt(4.5e5 / (w * h)));
    const W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
    if (!this.rt || this.rt.width !== W || this.rt.height !== H) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace });
    }
    const u = this.mat.uniforms;
    u.depthTex.value = depthTexture; u.invProj.value.copy(camera.projectionMatrixInverse); u.invView.value.copy(camera.matrixWorld); u.camPos.value.copy(camera.position);
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.rt); r.render(this.scene, this.cam); r.setRenderTarget(prev);
    return this.rt.texture;
  }
}
