// Sky and aerial perspective from single scattering in the atmosphere (Rayleigh for the blue of the air,
// Mie for the haze and the glow around the sun; Nishita's model). The same maths runs in the sky shader
// (every pixel of the sky) and on the CPU (a few directions) to give the terrain shader its horizon, zenith,
// glow and sunlight colours, so the ground and the sky always agree. Seen from altitude the sky is darker
// and bluer, the low sun turns orange, and the colours come out in display (sRGB) values like the rest of the scene.
// BM: aerosol (haze) scattering at sea level; 21e-6 is the textbook value for a hazy lowland day and gave a
// yellow band on the horizon, clear Alpine air is closer to a third of it
const RE = 6360e3, RA = 6420e3, HR = 8000, HM = 1200, BR = [5.8e-6, 13.5e-6, 33.1e-6], BM = 7e-6, G = 0.76, SUN_E = 20, EXPOSURE = 1.6;

export const ATMOSPHERE_GLSL = `
const float PI_A = 3.14159265;
const float RE = ${RE.toFixed(1)}, RA = ${RA.toFixed(1)}, HR = ${HR.toFixed(1)}, HM = ${HM.toFixed(1)};
const vec3 BR = vec3(${BR.map(v => v.toExponential(3)).join(', ')}); const float BM = ${BM.toExponential(3)};
vec2 raySphere(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r*r, d = b*b - c; if (d < 0.0) return vec2(1e9, -1e9); d = sqrt(d); return vec2(-b - d, -b + d); }
// radiance reaching a viewer at altitude alt (m) looking along rd, sun in direction sun (y up)
vec3 atmosphere(vec3 rd, vec3 sun, float alt){
  vec3 ro = vec3(0.0, RE + max(alt, 1.0), 0.0);
  float tmax = raySphere(ro, rd, RA).y; vec2 gr = raySphere(ro, rd, RE); if (gr.x > 0.0) tmax = min(tmax, gr.x);
  float seg = tmax / 12.0, odR = 0.0, odM = 0.0; vec3 sR = vec3(0.0), sM = vec3(0.0);
  float mu = dot(rd, sun), g = ${G}, g2 = g*g;
  float phR = 3.0 / (16.0*PI_A) * (1.0 + mu*mu);
  float phM = 3.0 / (8.0*PI_A) * ((1.0 - g2) * (1.0 + mu*mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0*g*mu, 1.5));
  for (int i = 0; i < 12; i++) {
    vec3 p = ro + rd * (seg * (float(i) + 0.5)); float h = length(p) - RE;
    float hr = exp(-h / HR) * seg, hm = exp(-h / HM) * seg; odR += hr; odM += hm;
    float sl = raySphere(p, sun, RA).y / 4.0, lR = 0.0, lM = 0.0; bool lit = true;
    for (int j = 0; j < 4; j++) { float hq = length(p + sun * (sl * (float(j) + 0.5))) - RE; if (hq < 0.0) { lit = false; break; } lR += exp(-hq / HR) * sl; lM += exp(-hq / HM) * sl; }
    if (lit) { vec3 att = exp(-(BR * (odR + lR) + BM * 1.1 * (odM + lM))); sR += att * hr; sM += att * hm; }
  }
  return ${SUN_E.toFixed(1)} * (sR * BR * phR + sM * BM * phM);
}
vec3 toDisplay(vec3 L){ return pow(1.0 - exp(-${EXPOSURE.toFixed(2)} * L), vec3(1.0/2.2)); }`;

// The sky only depends on the sun and the viewer's altitude: it is baked into a small panorama (more rows near
// the horizon, where the colours change fastest) whenever those change, and the sky dome just reads it.
// Mapping of a direction d to the panorama: u = azimuth, v = 0.5 ± sqrt(|elevation| / 90°) / 2.
export const SKY_LOOKUP_GLSL = `
vec2 skyUv(vec3 d){ float el = asin(clamp(d.y, -1.0, 1.0)) / 1.5707963;
  return vec2(atan(d.x, -d.z) / 6.2831853 + 0.5, 0.5 + sign(el) * sqrt(abs(el)) * 0.5); }`;
export class SkyBaker {
  constructor(THREE, renderer, w = 256, h = 128) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, wrapS: THREE.RepeatWrapping, colorSpace: THREE.NoColorSpace });
    this.mat = new THREE.ShaderMaterial({
      uniforms: { sun: { value: new THREE.Vector3(0, 1, 0) }, alt: { value: 1000 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `uniform vec3 sun; uniform float alt; varying vec2 vUv; ${ATMOSPHERE_GLSL}
        void main(){
          float s = (vUv.y - 0.5) * 2.0, el = sign(s) * s * s * 1.5707963, az = (vUv.x - 0.5) * 6.2831853;
          vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
          gl_FragColor = vec4(toDisplay(atmosphere(d, sun, alt)), 1.0);
        }`,
      depthTest: false, depthWrite: false
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(quad); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  bake(sunDir, alt) {
    this.mat.uniforms.sun.value.copy(sunDir); this.mat.uniforms.alt.value = alt;
    const rt = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target); this.renderer.render(this.scene, this.cam); this.renderer.setRenderTarget(rt);
  }
  get texture() { return this.target.texture; }
}

// ---- the same model on the CPU ----
function raySphere(ro, rd, r) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2], c = ro[0] ** 2 + ro[1] ** 2 + ro[2] ** 2 - r * r, d = b * b - c;
  if (d < 0) return [1e9, -1e9]; const s = Math.sqrt(d); return [-b - s, -b + s];
}
function atmosphere(rd, sun, alt) {
  const ro = [0, RE + Math.max(alt, 1), 0];
  let tmax = raySphere(ro, rd, RA)[1]; const gr = raySphere(ro, rd, RE); if (gr[0] > 0) tmax = Math.min(tmax, gr[0]);
  const seg = tmax / 12, mu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2], g2 = G * G;
  const phR = 3 / (16 * Math.PI) * (1 + mu * mu), phM = 3 / (8 * Math.PI) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * G * mu, 1.5));
  let odR = 0, odM = 0; const sR = [0, 0, 0], sM = [0, 0, 0];
  for (let i = 0; i < 12; i++) {
    const t = seg * (i + 0.5), p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t], h = Math.hypot(...p) - RE;
    const hr = Math.exp(-h / HR) * seg, hm = Math.exp(-h / HM) * seg; odR += hr; odM += hm;
    const sl = raySphere(p, sun, RA)[1] / 4; let lR = 0, lM = 0, lit = true;
    for (let j = 0; j < 4; j++) { const u = sl * (j + 0.5), hq = Math.hypot(p[0] + sun[0] * u, p[1] + sun[1] * u, p[2] + sun[2] * u) - RE; if (hq < 0) { lit = false; break; } lR += Math.exp(-hq / HR) * sl; lM += Math.exp(-hq / HM) * sl; }
    if (!lit) continue;
    for (let k = 0; k < 3; k++) { const att = Math.exp(-(BR[k] * (odR + lR) + BM * 1.1 * (odM + lM))); sR[k] += att * hr; sM[k] += att * hm; }
  }
  return [0, 1, 2].map(k => SUN_E * (sR[k] * BR[k] * phR + sM[k] * BM * phM));
}
const display = L => L.map(v => Math.pow(1 - Math.exp(-EXPOSURE * v), 1 / 2.2));
// light of the sun itself after crossing the air (turns orange and weak near the horizon)
function transmittance(sun, alt) {
  const ro = [0, RE + Math.max(alt, 1), 0];
  if (raySphere(ro, sun, RE)[0] > 0) return [0, 0, 0];
  const len = raySphere(ro, sun, RA)[1], n = 16, sl = len / n; let oR = 0, oM = 0;
  for (let i = 0; i < n; i++) { const u = sl * (i + 0.5), h = Math.hypot(ro[0] + sun[0] * u, ro[1] + sun[1] * u, ro[2] + sun[2] * u) - RE; oR += Math.exp(-h / HR) * sl; oM += Math.exp(-h / HM) * sl; }
  return BR.map(b => Math.exp(-(b * oR + BM * 1.1 * oM)));
}

// Colours for the terrain and cloud shaders, in display values: zenith, horizon (average around the viewer,
// looking slightly down as mountains are seen), glow towards the sun, and sunlight.
export function skyColors(sunDir, alt) {
  const sun = [sunDir.x, sunDir.y, sunDir.z], el = 0.03;
  const zenith = display(atmosphere([0, 1, 0], sun, alt));
  const around = [0, 1, 2, 3, 4, 5].map(i => { const a = i / 6 * Math.PI * 2; return display(atmosphere([Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)], sun, alt)); });
  const horizon = [0, 1, 2].map(k => around.reduce((s, c) => s + c[k], 0) / around.length);
  const hs = Math.hypot(sun[0], sun[2]) || 1, toward = [sun[0] / hs * Math.cos(el), Math.sin(el), sun[2] / hs * Math.cos(el)];
  const glow = display(atmosphere(toward, sun, alt));
  const T = transmittance(sun, alt);
  return { zenith, horizon, glow, sun: T.map(v => v * 2.6) };
}
