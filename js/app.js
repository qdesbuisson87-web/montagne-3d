import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { lonLatToWorld, worldToLonLat, lonLatToTile, ORIGIN } from './geo.js';
import { SITE, SITE_LIST } from './sites.js';
import { TerrainEngine, GRID, photoUrl, terrariumUrl, elevRequest, LIDAR_LAYER } from './terrain.js';
import { cachedFetch, TILE_CACHE, resetTileCache } from './net.js';
import { GoogleTiles, googleKey, whyRefused } from './google3d.js';
import { fetchWeather, findSentinel, sunPosition, pointForecast, SPOTS } from './live.js';
THREE.ColorManagement.enabled = false;

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('fr-FR');
const t1 = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toLocaleString('fr-FR');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- renderer / scene ----------
const stage = $('stage');
// MSAA only on low-density screens: at 2× and more the pixels are too small for stair steps to show,
// and multisampling a phone-sized framebuffer costs a large share of the GPU budget
const renderer = new THREE.WebGLRenderer({ antialias: (window.devicePixelRatio || 1) < 2, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1, 250000);
const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, zoomToCursor: true, screenSpacePanning: false, minDistance: 15, maxDistance: 60000, maxPolarAngle: Math.PI * 0.495, rotateSpeed: 0.55, zoomSpeed: 1.2, autoRotateSpeed: 0.3 });
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

// ---------- quality ----------
const touch = matchMedia('(pointer: coarse)').matches;
const beefy = (navigator.deviceMemory || 8) >= 6 && (navigator.hardwareConcurrency || 8) >= 8;
// k: tile split distance (detail), pr: highest pixel ratio, fps: frame rate the automatic adjustment defends,
// fx: share of the snow/rain particles, clouds: layers of the sea of clouds
const QUAL = {
  standard: { k: 1.6, pr: 1.25, tiles: 450, loads: 6, fps: 50, fx: 0.3, clouds: 2, gErr: 24 },
  haute: { k: 2.2, pr: 2, tiles: 800, loads: 8, fps: 55, fx: 0.6, clouds: 3, gErr: 12 },
  extreme: { k: 3.2, pr: 3, tiles: 1300, loads: 12, fps: 30, fx: 1, clouds: 4, gErr: 6 } // gErr: Google 3D screen error (px)
};
// phones start in "Haute" (the promise: 60 i/s on a high-end phone); "Extrême" is a deliberate choice there
let savedQuality = null; try { savedQuality = localStorage.getItem('midi3d-quality'); } catch { }
const state = { quality: QUAL[savedQuality] ? savedQuality : (beefy && !touch ? 'extreme' : 'haute'), exag: 1, render: 'photo', light: 'photo', hourOffset: 0, snowToday: true, clouds: true, precip: 'auto', labels: true, cable: true, slopes: false, weather: null, s2: null };
try { state.slopes = localStorage.getItem('midi3d-slopes') === '1'; } catch { }

// ---------- shared uniforms & terrain shaders ----------
const U = {
  exag: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Vector3(1, 1, 1) }, skyCol: { value: new THREE.Vector3() }, horizonCol: { value: new THREE.Vector3() }, glowCol: { value: new THREE.Vector3() },
  noiseTex: { value: cloudNoiseTexture() }, // tileable fractal noise: cloud shapes and rock grain
  light: { value: 0 }, vivid: { value: 0.2 }, snowToday: { value: 1 }, visToday: { value: 0 }, slopes: { value: state.slopes ? 1 : 0 }, fogDensity: { value: 0.000016 }, haze: { value: 0 }, time: { value: 0 }
};
// slope classes (degrees, lower bound) and their colours; the shader and the on-screen legend both read this
const SLOPE_CLASSES = [[27, '#ffe135'], [30, '#ff9419'], [35, '#e3261f'], [40, '#9a37d0'], [45, '#484a55']];
const glslColor = hex => 'vec3(' + [1, 3, 5].map(i => (Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2)).toFixed(4)).join(', ') + ')';
const terrainVS = `
uniform float exag;
varying vec2 vUv; varying vec3 vN, vW; varying float vAlt;
void main(){
  vec3 p = position; vAlt = p.y; p.y *= exag;
  vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz; vUv = uv;
  vN = normalize(vec3(normal.x * exag, normal.y, normal.z * exag));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const terrainFS = `
uniform sampler2D map, slopeMap, ndsiMap, cloudMap, visMap, noiseTex; uniform vec4 ovRect;
uniform float exag, hasNdsi, hasCloud, hasVis, tileSize, snowToday, visToday, slopes, light, vivid, fogDensity, haze, time;
uniform vec3 sunDir, sunCol, skyCol, horizonCol, glowCol;
varying vec2 vUv; varying vec3 vN, vW; varying float vAlt;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
// cubic B-spline filtering (4 bilinear taps): a 10 m satellite pixel becomes a smooth gradient, never a square
vec4 cubic(sampler2D t, vec2 uv){
  vec2 ts = vec2(256.0), p = uv*ts - 0.5, f = fract(p); p -= f;
  vec2 f2 = f*f, f3 = f2*f;
  vec2 w0 = (-f3 + 3.0*f2 - 3.0*f + 1.0)/6.0, w1 = (3.0*f3 - 6.0*f2 + 4.0)/6.0, w2 = (-3.0*f3 + 3.0*f2 + 3.0*f + 1.0)/6.0, w3 = f3/6.0;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 h0 = (p - 1.0 + w1/s0 + 0.5)/ts, h1 = (p + 1.0 + w3/s1 + 0.5)/ts;
  vec2 g = s1/(s0 + s1);
  return mix(mix(texture2D(t, h0), texture2D(t, vec2(h1.x, h0.y)), g.x), mix(texture2D(t, vec2(h0.x, h1.y)), texture2D(t, h1), g.x), g.y);
}
void main(){
  // on steep faces the vertical photo is stretched by 1/cos(slope): blur it by the same factor, which keeps its
  // colour but removes the vertical streaks; the rock grain below brings the detail back
  float stretch = 1.0 / max(normalize(vN).y, 0.12);
  vec3 photo = pow(texture2D(map, vUv, log2(stretch) * 0.6).rgb, vec3(2.2));
  // the photo blurred to the satellite's 10 m, to compare like with like
  vec3 low = pow(textureLod(map, vUv, max(0.0, log2(2560.0 / tileSize))).rgb, vec3(2.2));
  float plum = dot(photo, LUM), llum = dot(low, LUM);
  vec2 ou = ovRect.xy + vUv*ovRect.zw;
  float cloud = hasCloud > 0.5 ? cubic(cloudMap, ou).r : 0.0;
  vec3 alb = photo;
  // colours of the day: keep every 20 cm detail of the photo, take the large-scale colour from Sentinel-2
  if (visToday > 0.5 && hasVis > 0.5) {
    vec4 v = cubic(visMap, ou);
    vec3 s2 = pow(v.rgb, vec3(2.2));
    vec3 ratio = clamp((s2 + 0.004) / (low + 0.004), 0.25, 4.0);
    alb = mix(photo, photo * ratio, smoothstep(0.6, 0.95, v.a) * (1.0 - cloud));
  }
  vec3 n = normalize(vN); float slope = 1.0 - n.y;
  // steep faces: the vertical photo is stretched there (×2 at 60°, ×4 at 75°), so a fine rock grain is added,
  // projected on the three axes so that it never stretches; it changes the photo's brightness, not its colour.
  // Always computed (no branch) so the texture reads keep valid mipmap derivatives.
  float steep = smoothstep(0.3, 0.7, slope);
  vec3 tw = pow(abs(n), vec3(4.0)); tw /= tw.x + tw.y + tw.z;
  vec3 q = vW / vec3(1.0, exag, 1.0); // metres on the ground, relief not exaggerated
  // the noise is built on a square lattice: sample it through rotations so that no grid lines up with the relief
  const mat2 R1 = mat2(0.83, 0.56, -0.56, 0.83), R2 = mat2(0.48, -0.88, 0.88, 0.48);
  // one texture period holds 16 noise cells: features of ~11 m (g1) and ~2.7 m (g2), each with finer octaves
  float g1 = texture2D(noiseTex, R1*q.zy/176.0).r*tw.x + texture2D(noiseTex, R1*q.xz/176.0).r*tw.y + texture2D(noiseTex, R1*q.xy/176.0).r*tw.z;
  float g2 = texture2D(noiseTex, R2*q.zy/43.0 + 0.37).r*tw.x + texture2D(noiseTex, R2*q.xz/43.0 + 0.37).r*tw.y + texture2D(noiseTex, R2*q.xy/43.0 + 0.37).r*tw.z;
  alb *= 1.0 + ((g1 - 0.49)*1.2 + (g2 - 0.49)*0.5) * 0.45 * steep;
  // the same grain as a small relief (up to ~1.5 m) that the light catches: surface-gradient bump mapping
  // from screen-space derivatives, no extra geometry
  float bump = ((g1 - 0.49)*3.0 + (g2 - 0.49)*0.9) * steep; // metres: large facets, a little finer roughness
  vec3 dpx = dFdx(vW), dpy = dFdy(vW), r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 nb = abs(det)*n - sign(det)*(dFdx(bump)*r1 + dFdy(bump)*r2);
  vec3 nl = dot(nb, nb) > 1e-20 ? normalize(nb) : n; // lit normal
  // today's snow: continuous snow index, refined at metre scale with the LiDAR slope and the photo
  if (snowToday > 0.5 && hasNdsi > 0.5) {
    vec4 nd = cubic(ndsiMap, ou);
    float valid = smoothstep(0.6, 0.95, nd.a) * (1.0 - cloud);
    float fsc = clamp(1.45*(nd.r*2.0 - 1.0) - 0.01, 0.0, 1.0);
    float nz = vnoise(vW.xz/2.3)*0.5 + vnoise(vW.xz/8.0)*0.35 + vnoise(vW.xz/0.7)*0.15;
    float s = fsc + (nz - 0.5)*0.4 - smoothstep(0.42, 0.8, slope)*0.85 + smoothstep(0.3, 0.7, plum)*0.12;
    float cover = smoothstep(0.4, 0.6, s) * valid;
    float detail = clamp(plum / max(llum, 0.02), 0.6, 1.4);
    vec3 snowC = vec3(0.86, 0.9, 0.97) * mix(1.0, detail, 0.35);
    alb = mix(alb, snowC, cover * (1.0 - smoothstep(0.5, 0.8, plum)));
  }
  float lum = dot(alb, LUM);
  alb = max(mix(vec3(lum), alb, 1.0 + vivid), 0.0) * (1.0 + vivid*0.15);
  vec3 col;
  if (light < 0.5) {
    // photo mode: the photo carries its own shading, except on steep faces where it is smeared; there the relief
    // is lit from where the sun stood during the IGN flights (south-south-east, late morning)
    const vec3 PL = vec3(0.196, 0.819, 0.539);
    col = alb * mix(0.88 + 0.14*n.y, 0.45 + 0.75*max(dot(nl, PL), 0.0), steep);
  }
  else {
    float ndl = max(dot(nl, sunDir), 0.0);
    vec3 a = alb / (0.55 + 0.9*lum) * 0.95;
    col = a * (sunCol*ndl + skyCol*0.5*(0.6 + 0.4*n.y));
    vec3 V = normalize(cameraPosition - vW), H = normalize(sunDir + V);
    col += sunCol * pow(max(dot(nl, H), 0.0), 60.0) * smoothstep(0.5, 0.8, lum) * 0.35;
  }
  // slope map: the ground gradient is interpolated per pixel from the tile's grid (true metres, not exaggerated),
  // and each class boundary is blended over about one pixel so it never shows stair steps
  if (slopes > 0.5) {
    vec2 g = texture2D(slopeMap, (vUv*${GRID}.0 + 0.5) / ${GRID + 1}.0).rg;
    float deg = degrees(atan(length(g)));
    float aa = max(fwidth(deg), 0.02) * 0.7;
    vec3 sc = ${glslColor(SLOPE_CLASSES[0][1])};
    ${SLOPE_CLASSES.slice(1).map(([a, c]) => `sc = mix(sc, ${glslColor(c)}, smoothstep(${a}.0 - aa, ${a}.0 + aa, deg));`).join('\n    ')}
    float cover = smoothstep(${SLOPE_CLASSES[0][0]}.0 - aa, ${SLOPE_CLASSES[0][0]}.0 + aa, deg);
    // tinted by the lit ground so the relief stays readable under the colour
    col = mix(col, sc * (0.6 + 0.5*sqrt(dot(col, LUM))), cover * 0.8);
  }
  float d = length(cameraPosition - vW);
  float f = 1.0 - exp(-d * (fogDensity + haze*0.000018));
  vec3 V = normalize(vW - cameraPosition);
  vec3 fogC = mix(horizonCol, glowCol, pow(max(dot(V, sunDir), 0.0), 6.0) * 0.7);
  col = mix(col, pow(fogC, vec3(2.2)), clamp(f, 0.0, 0.93));
  gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0/2.2)), 1.0);
}`;

const BOUNDS = SITE.bounds; // lon/lat of the streamed area
const engine = new TerrainEngine({ renderer, scene, uniforms: U, vertexShader: terrainVS, fragmentShader: terrainFS, bounds: BOUNDS });

// ---------- sky ----------
const sky = new THREE.Mesh(new THREE.SphereGeometry(200000, 48, 24), new THREE.ShaderMaterial({
  uniforms: U, side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 sunDir, sunCol, skyCol, horizonCol, glowCol; varying vec3 vD;
    void main(){ vec3 d = normalize(vD); float h = d.y;
      vec3 c = mix(horizonCol, skyCol, pow(clamp(h, 0.0, 1.0), 0.5));
      c = mix(c, horizonCol*0.55, smoothstep(0.0, -0.2, h));
      float sg = max(dot(d, sunDir), 0.0);
      c += glowCol*pow(sg, 8.0)*0.35 + glowCol*pow(sg, 90.0)*0.5 + vec3(1.0, 0.97, 0.9)*smoothstep(0.99955, 0.9998, sg)*1.5*step(0.0, sunDir.y);
      gl_FragColor = vec4(min(c, 1.0), 1.0); }`
}));
sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);

// ---------- sea of clouds (driven by the forecast) ----------
// The cloud noise is baked once into a tileable texture (same fractal as before, 6 octaves of value noise):
// two texture reads per pixel instead of 48 noise evaluations, which phones could not afford over the whole screen.
function cloudNoiseTexture(S = 512, period = 16) {
  const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const vn = (x, y, p) => { // value noise, lattice wrapped every p cells
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(xi % p, yi % p), b = hash((xi + 1) % p, yi % p), c = hash(xi % p, (yi + 1) % p), d = hash((xi + 1) % p, (yi + 1) % p);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  };
  const data = new Uint8Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    let s = 0, a = 0.5, f = period / S;
    for (let o = 0; o < 6; o++) { s += a * vn(i * f, j * f, period << o); f *= 2; a *= 0.5; }
    data[j * S + i] = Math.round(s * 255);
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}
const cloudU = { ...U, cloudAlt: { value: 2100 }, cover: { value: 0 }, wind: { value: new THREE.Vector2(3, 1) } };
const clouds = new THREE.Group(); scene.add(clouds);
for (let i = 0; i < 4; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000, 1, 1), new THREE.ShaderMaterial({
    uniforms: { ...cloudU, layer: { value: i / 3 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `uniform float cloudAlt, layer, exag; varying vec3 vW;
      void main(){ vec3 p = vec3(position.x, 0.0, -position.y); p.y = (cloudAlt - 160.0 + layer*220.0) * exag; vec4 w = modelMatrix*vec4(p,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform float cover, layer, time; uniform vec2 wind; uniform vec3 sunDir, sunCol, skyCol, horizonCol; uniform sampler2D noiseTex; varying vec3 vW;
      float fbm(vec2 p){ return texture2D(noiseTex, p / 16.0).r; } // one texture period = 16 noise units
      void main(){
        vec2 p = (vW.xz + wind*time) / 2600.0;
        float n = fbm(p + layer*3.1) * 0.75 + fbm(p*3.7 - layer*5.3) * 0.25;
        float th = mix(0.78, 0.28, cover) + (layer - 0.5)*0.12;
        float a = smoothstep(th, th + 0.18, n) * (0.55 - abs(layer - 0.5)*0.4) * cover;
        float dist = length(vW.xz - cameraPosition.xz);
        a *= 1.0 - smoothstep(30000.0, 44000.0, dist);
        float lit = 0.75 + 0.25*layer + 0.2*max(sunDir.y, 0.0);
        vec3 c = mix(skyCol*0.6 + horizonCol*0.4, vec3(1.0), 0.55) * lit + sunCol*0.08;
        gl_FragColor = vec4(min(c, 1.0), a);
      }`
  }));
  m.frustumCulled = false; m.renderOrder = 3; clouds.add(m);
}

// ---------- falling snow ----------
const NP = 70000, snowGeo = new THREE.BufferGeometry();
{ const p = new Float32Array(NP * 3), s = new Float32Array(NP); for (let i = 0; i < NP; i++) { p.set([Math.random(), Math.random(), Math.random()], i * 3); s[i] = Math.random(); }
  snowGeo.setAttribute('position', new THREE.BufferAttribute(p, 3)); snowGeo.setAttribute('aS', new THREE.BufferAttribute(s, 1)); }
const SU = { time: U.time, boxSize: { value: 500 }, proj: { value: 800 }, camPos: { value: new THREE.Vector3() } };
const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({
  uniforms: SU, transparent: true, depthWrite: false,
  vertexShader: `uniform float time, boxSize, proj; uniform vec3 camPos; attribute float aS; varying float vA;
    void main(){
      vec3 drift = vec3(time*0.012 + sin(time*0.9 + aS*40.0)*0.004, -time*(0.035 + 0.03*aS), time*0.006 + cos(time*0.7 + aS*25.0)*0.004);
      vec3 p = fract(position - camPos/boxSize + drift), w = camPos + (p - 0.5)*boxSize;
      vec4 mv = viewMatrix*vec4(w, 1.0); float d = -mv.z;
      vA = smoothstep(0.5, 0.3, length(p - 0.5)) * smoothstep(0.004*boxSize, 0.03*boxSize, d);
      gl_PointSize = clamp(boxSize*0.0032*(0.5 + aS)*proj/max(d, 1e-3), 1.0, 26.0);
      gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `varying float vA; void main(){ float r = length(gl_PointCoord - 0.5); gl_FragColor = vec4(0.96, 0.97, 1.0, smoothstep(0.5, 0.1, r)*vA*0.9); }`
}));
snow.frustumCulled = false; snow.renderOrder = 4; snow.visible = false; scene.add(snow);

// ---------- rain: short streaks falling fast, slanted by the wind ----------
const NR = 40000, rainGeo = new THREE.BufferGeometry();
{ const p = new Float32Array(NR * 6), e = new Float32Array(NR * 2), s = new Float32Array(NR * 2);
  for (let i = 0; i < NR; i++) { const x = Math.random(), y = Math.random(), z = Math.random(), r = Math.random(); p.set([x, y, z, x, y, z], i * 6); e[i * 2 + 1] = 1; s[i * 2] = s[i * 2 + 1] = r; }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(p, 3)); rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(e, 1)); rainGeo.setAttribute('aS', new THREE.BufferAttribute(s, 1)); }
const RU = { time: U.time, boxSize: SU.boxSize, camPos: SU.camPos, wind: { value: new THREE.Vector2(0, 0) } };
const rain = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({
  uniforms: RU, transparent: true, depthWrite: false,
  vertexShader: `uniform float time, boxSize; uniform vec3 camPos; uniform vec2 wind; attribute float aEnd, aS; varying float vA;
    void main(){
      vec3 vel = vec3(wind.x, -1.0, wind.y) * (0.55 + 0.25*aS);          // box heights per second
      vec3 p = fract(position - camPos/boxSize + vel*time*0.9);
      vec3 w = camPos + (p - 0.5)*boxSize - aEnd * normalize(vel) * boxSize * 0.012;
      vec4 mv = viewMatrix*vec4(w, 1.0);
      vA = smoothstep(0.5, 0.32, length(p - 0.5)) * smoothstep(0.004*boxSize, 0.04*boxSize, -mv.z) * (1.0 - aEnd*0.7);
      gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.78, 0.84, 0.9, vA*0.45); }`
}));
rain.frustumCulled = false; rain.renderOrder = 4; rain.visible = false; scene.add(rain);

// ---------- cable car Chamonix -> Plan de l'Aiguille -> Aiguille du Midi ----------
const stations = (SITE.cable || []).map(([la, lo, a]) => { const [x, z] = lonLatToWorld(lo, la); return { x, z, h: a + 12 }; });
const CS = 160, cablePts = [];
for (let s = 0; s < stations.length - 1; s++) { const a = stations[s], b = stations[s + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
  for (let t = 0; t <= CS; t++) { const f = t / CS; cablePts.push([a.x + (b.x - a.x) * f, a.h + (b.h - a.h) * f - 4 * f * (1 - f) * len * 0.045, a.z + (b.z - a.z) * f]); } }
const cableGeo = new THREE.BufferGeometry(); cableGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cablePts.length * 3), 3));
const cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: 0x15181d, transparent: true, opacity: 0.85 }));
const cabinGeo = new THREE.BufferGeometry(); cabinGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const cabins = new THREE.Points(cabinGeo, new THREE.PointsMaterial({ color: 0xe2372c, size: 8, sizeAttenuation: false }));
cable.frustumCulled = cabins.frustumCulled = false; scene.add(cable, cabins);
function placeCable() { const a = cableGeo.attributes.position.array; cablePts.forEach(([x, h, z], i) => a.set([x, h * state.exag, z], i * 3)); cableGeo.attributes.position.needsUpdate = true; }
const cablePoint = (seg, f) => { const i = Math.min(Math.floor(f * CS), CS - 1), t = f * CS - i, a = cablePts[seg * (CS + 1) + i], b = cablePts[seg * (CS + 1) + i + 1]; return [a[0] + (b[0] - a[0]) * t, (a[1] + (b[1] - a[1]) * t - 6) * state.exag, a[2] + (b[2] - a[2]) * t]; };
placeCable();
if (!SITE.cable) { cable.visible = cabins.visible = false; $('c-cable').closest('label').hidden = true; }

// ---------- places ----------
const PLACES = SITE.places.map(p => ({ ...p }));
const labelsEl = $('labels');
PLACES.forEach(p => {
  [p.x, p.z] = lonLatToWorld(p.ll[1], p.ll[0]); p.h = p.alt ?? 2500;
  const el = document.createElement('button'); el.type = 'button';
  el.className = 'label' + (p.star ? ' star' : '') + (p.area ? ' area' : '') + (p.small ? ' small' : '');
  el.innerHTML = `<span class="t"><span class="n">${esc(p.name)}</span>${p.alt ? `<span class="h">${fmt(p.alt)} m</span>` : ''}</span>`;
  el.addEventListener('click', () => flyToPlace(p));
  labelsEl.appendChild(el); p.el = el;
  const li = document.createElement('button'); li.type = 'button'; li.className = 'place';
  li.innerHTML = `<span>${esc(p.name)}</span><span class="pa">${p.alt ? fmt(p.alt) + ' m' : 'glacier'}</span>`;
  li.addEventListener('click', () => { flyToPlace(p); if (touch) closeSheets(); });
  $('placeList').appendChild(li);
});

// ---------- site: header, links, switcher ----------
document.title = `${SITE.name} 3D`;
$('siteRegion').textContent = SITE.region; $('siteName').textContent = SITE.name; $('siteAlt').textContent = `${fmt(SITE.alt)} m`;
$('loaderTitle').textContent = SITE.name; $('home').setAttribute('aria-label', `Revenir à ${SITE.name}`);
$('links').innerHTML = SITE.links.map(([u, t]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join('');
$('sites').innerHTML = SITE_LIST.map(x => `<a class="site${x.id === SITE.id ? ' on' : ''}" href="?site=${x.id}"${x.id === SITE.id ? ' aria-current="page"' : ''}><b>${esc(x.name)}</b><span>${esc(x.region)} · ${fmt(x.alt)} m</span></a>`).join('');

// ---------- camera moves ----------
let fly = null;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function startFly(target, pos, dur = 2200) { fly = { t0: performance.now(), dur, fT: controls.target.clone(), fP: camera.position.clone(), tT: target, tP: pos }; controls.autoRotate = false; }
function flyToPlace(p) {
  const y = (p.area ? (engine.heightAt(p.x, p.z) ?? p.h) : p.h) * state.exag;
  const t = new THREE.Vector3(p.x, y - (p.area ? 0 : 60 * state.exag), p.z);
  const dist = p.dist ?? (p.area ? 3500 : 1800);
  let dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.2 || dir.y > 0.8) { dir.y = 0.4; dir.normalize(); }
  startFly(t, t.clone().addScaledVector(dir, dist));
}
function home() { const t = new THREE.Vector3(0, (SITE.alt - SITE.home.dy) * state.exag, 0), [cx, cy, cz] = SITE.home.cam; startFly(t, new THREE.Vector3(cx, t.y + cy, cz), 3200); }
controls.target.set(0, SITE.alt - SITE.home.dy, 0); camera.position.set(-9000, 9000, -12000);

// ---------- terrain queries ----------
const groundAt = (x, z) => engine.heightAt(x, z);
const google = new GoogleTiles({ scene, camera, renderer, origin: ORIGIN, geoidN: SITE.geoidN ?? 50 });
const rayG = new THREE.Raycaster();
// aerial perspective for the Google tiles (their materials take three.js fog), same horizon colour as the sky
const gFog = new THREE.FogExp2(0xc8d2dc, 2.3e-5);
function pick(ndcX, ndcY) {
  if (google.on) { // Google view: the surface actually on screen (buildings, trees and snow included)
    rayG.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const p = google.raycast(rayG); return p ? { x: p.x, z: p.z, h: p.y, surface: 'google' } : null;
  }
  const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const o = r.ray.origin, d = r.ray.direction; let t = 0;
  for (let i = 0; i < 1500 && t < 80000; i++) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t, g = groundAt(x, z);
    if (g == null) { t += 50; continue; }
    const gap = y - g * state.exag; if (gap < 0.5) return { x, z, h: g };
    t += Math.max(gap * 0.5, 0.5);
  }
  return null;
}
const compass16 = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'][Math.round(d / 22.5) % 16];
// slope under a point, worded as on the map; flat ground has no meaningful orientation
const slopeText = s => !s ? '' : s.deg < 3 ? 'terrain plat' : `pente ${Math.round(s.deg)}° ${compass16(s.aspect)}`;
const SRC = { lidar: 'LiDAR HD IGN', rge: 'RGE ALTI IGN', global: 'modèle mondial ~30 m (hors couverture IGN)' };
function showPoint(hit) {
  if (!hit) return;
  const [lon, lat] = worldToLonLat(hit.x, hit.z), s = engine.slopeAt(hit.x, hit.z);
  $('rAlt').textContent = fmt(hit.h) + ' m' + (s && s.deg >= 3 ? ` · ${Math.round(s.deg)}°` : '');
  $('rLL').textContent = `${lat.toFixed(5)}° N · ${lon.toFixed(5)}° E`;
}
let hoverNDC = null, downAt = null;
renderer.domElement.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { const r = renderer.domElement.getBoundingClientRect(); hoverNDC = [(e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1]; } });
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY, performance.now()]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 8 && performance.now() - downAt[2] < 400) {
    const r = renderer.domElement.getBoundingClientRect(), hit = pick((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    if (!hit) return;
    showPoint(hit);
    if (!pickAt(hit)) pointReport(hit);
  }
});
controls.addEventListener('start', () => { fly = null; controls.autoRotate = false; $('c-spin').checked = false; });

// ---------- sun, sky, weather-driven look ----------
let overcast = 0;
function lightingNow() { return new Date(Date.now() + state.hourOffset * 3600e3); }
function updateSky() {
  const date = lightingNow(), { az, el } = sunPosition(date, ORIGIN.lat, ORIGIN.lon);
  const s = Math.sin(el);
  U.sunDir.value.set(Math.sin(az) * Math.cos(el), s, -Math.cos(az) * Math.cos(el)).normalize();
  const day = sstep(-0.1, 0.3, s), low = 1 - sstep(0.0, 0.3, s), ov = overcast;
  const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  let skyC = mixv([0.02, 0.03, 0.08], [0.24, 0.47, 0.86], day);
  let hor = mixv(mixv([0.1, 0.09, 0.14], [0.98, 0.62, 0.42], sstep(-0.12, 0.0, s)), [0.72, 0.82, 0.94], 1 - low);
  let glow = mixv([1.0, 0.5, 0.2], [1.0, 0.92, 0.8], sstep(0.0, 0.4, s));
  let sun = mixv([1.0, 0.5, 0.25], [1.0, 0.96, 0.9], sstep(0.0, 0.4, s)).map(v => v * 2.4 * sstep(-0.04, 0.08, s));
  if (ov > 0) { const g = 0.35 + 0.45 * day; skyC = mixv(skyC, [g * 0.9, g * 0.93, g], ov); hor = mixv(hor, [g, g, g * 1.02], ov); glow = mixv(glow, [g, g, g], ov); sun = sun.map(v => v * (1 - 0.7 * ov)); }
  U.skyCol.value.set(...skyC); U.horizonCol.value.set(...hor); U.glowCol.value.set(...glow); U.sunCol.value.set(...sun);
  gFog.color.setRGB(...hor); gFog.density = 2.3e-5 * (1 + overcast * 1.1);
  const hh = date.getHours(), mm = date.getMinutes();
  $('timeOut').textContent = (state.hourOffset === 0 ? 'maintenant, ' : '') + `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ---------- live conditions ----------
const WMO = { 0: 'Ciel clair', 1: 'Peu nuageux', 2: 'Partiellement nuageux', 3: 'Couvert', 45: 'Brouillard', 48: 'Brouillard givrant', 51: 'Bruine faible', 53: 'Bruine', 55: 'Bruine forte', 56: 'Bruine verglaçante', 57: 'Bruine verglaçante', 61: 'Pluie faible', 63: 'Pluie', 65: 'Pluie forte', 66: 'Pluie verglaçante', 67: 'Pluie verglaçante', 71: 'Neige faible', 73: 'Neige', 75: 'Neige forte', 77: 'Grains de neige', 80: 'Averses', 81: 'Averses', 82: 'Averses fortes', 85: 'Averses de neige', 86: 'Fortes averses de neige', 95: 'Orage', 96: 'Orage, grêle', 99: 'Orage, grêle' };
const SNOWY = [71, 73, 75, 77, 85, 86];
const compass = d => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((d % 360) + 360) % 360 / 45) % 8];
const ago = d => { const h = (Date.now() - d) / 36e5; return h < 1 ? "à l'instant" : h < 24 ? `il y a ${Math.round(h)} h` : `il y a ${Math.round(h / 24)} j`; };
const dayName = d => d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

function renderWeather() {
  const W = state.weather, el = $('wx');
  if (!W) return;
  const spots = ['top', 'peak2', 'mid', 'valley'].map(k => {
    const c = W[k].current, s = SPOTS[k];
    return `<div class="spot"><div class="sn">${esc(s.name)}<span>${fmt(s.alt)} m</span></div><div class="st">${t1(c.temperature_2m)}°</div>
      <div class="sd">${esc(WMO[c.weather_code] || '—')} · ressenti ${t1(c.apparent_temperature)}°<br>Vent ${compass(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} km/h · rafales ${Math.round(c.wind_gusts_10m)}</div></div>`;
  }).join('');
  let fz = null, sd = null;
  const ex = W.extra?.hourly;
  if (ex) { const now = W.top.current.time.slice(0, 13), k = ex.time.findIndex(t => t.slice(0, 13) === now); if (k >= 0) { fz = ex.freezing_level_height[k]; sd = ex.snow_depth[k]; } }
  const d = W.top.daily;
  const days = d.time.map((t, i) => `<tr><th>${dayName(new Date(t + 'T12:00'))}</th><td>${esc(WMO[d.weather_code[i]] || '—')}</td><td class="n">${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°</td><td class="n">${d.snowfall_sum[i] > 0 ? t1(d.snowfall_sum[i]) + ' cm' : '—'}</td><td class="n">${Math.round(d.wind_gusts_10m_max[i])}</td></tr>`).join('');
  el.innerHTML = `<p class="cmeta">Météo-France (AROME/ARPEGE) · reçu ${W.fetchedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
    <div class="spots">${spots}</div>
    <p class="cline"><b>Isotherme 0 °C</b> ${fz != null ? fmt(fz) + ' m' : '—'}${sd != null ? ` · <b>Neige au sol (modèle, Plan de l’Aiguille)</b> ${Math.round(sd * 100)} cm` : ''}</p>
    <h3>Prévisions — ${esc(SPOTS.top.name)} (${fmt(SPOTS.top.alt)} m)</h3>
    <div class="tw"><table><thead><tr><th></th><th>Ciel</th><th class="n">Min / max</th><th class="n">Neige</th><th class="n">Rafales</th></tr></thead><tbody>${days}</tbody></table></div>`;
  // look of the scene
  const cham = W.valley.current, plan = W.mid.current, midi = W.top.current;
  const lowC = cham.cloud_cover_low ?? cham.cloud_cover, planC = plan.cloud_cover, midiC = midi.cloud_cover;
  // a sea of clouds only makes sense when the tops stay below the summits; above that the massif is simply in the fog
  let alt = 1900, cover = lowC / 100, inside = false;
  if (planC > 70) { alt = 2800; cover = Math.max(cover, planC / 100); }
  if (midiC > 80) inside = true;
  cloudU.cloudAlt.value = alt; cloudU.cover.value = state.clouds ? Math.min(0.95, cover) : 0; showCloudLayers();
  const wdir = midi.wind_direction_10m * Math.PI / 180, wsp = midi.wind_speed_10m / 3.6 * 3;
  cloudU.wind.value.set(-Math.sin(wdir) * wsp, Math.cos(wdir) * wsp);
  overcast = state.clouds ? Math.max(0, Math.min(1, (Math.max(midiC, cham.cloud_cover) - 40) / 60)) * 0.8 : 0;
  U.haze.value = overcast;
  $('cloudNote').textContent = (inside ? `${esc(SPOTS.top.name)} est dans les nuages en ce moment (${Math.round(midiC)} % de couverture) : la vue réelle serait bouchée. ` : '')
    + (cover > 0.15 ? `Mer de nuages estimée vers ${fmt(alt)} m d'après la couverture nuageuse à ${esc(SPOTS.valley.name)} et à ${esc(SPOTS.mid.name)}.` : inside ? '' : 'Peu de nuages annoncés sur le massif en ce moment.');
  updatePrecipForView(); applyPrecip(); updateSky();
}
// What falls where you are looking: current precipitation and temperature from the four stations of the
// Chamonix -> Aiguille du Midi -> Mont Blanc axis, interpolated at the altitude of the ground under the view.
let precipNow = { kind: 'none', mm: 0, t: null, alt: null };
function precipAt(alt) {
  const W = state.weather; if (!W) return null;
  const pts = ['valley', 'mid', 'top', 'peak2'].map(k => ({ a: SPOTS[k].alt, c: W[k].current })).sort((a, b) => a.a - b.a);
  let i = 0; while (i < pts.length - 2 && alt > pts[i + 1].a) i++;
  const A = pts[i], B = pts[i + 1], f = Math.min(1, Math.max(0, (alt - A.a) / (B.a - A.a)));
  const lerp = (x, y) => x + (y - x) * f;
  const t = lerp(A.c.temperature_2m, B.c.temperature_2m), mm = Math.max(lerp(A.c.precipitation, B.c.precipitation), 0);
  const snowy = SNOWY.includes(A.c.weather_code) || SNOWY.includes(B.c.weather_code);
  const kind = mm < 0.05 && !snowy ? 'none' : (t <= 0.5 ? 'snow' : t >= 2.5 ? 'rain' : 'mix');
  return { kind, mm: Math.max(mm, snowy ? 0.4 : 0), t, alt };
}
function applyPrecip() {
  let kind = 'none', mm = 0;
  if (state.precip === 'auto') { if (precipNow.kind !== 'none') { kind = precipNow.kind; mm = precipNow.mm; } }
  else if (state.precip !== 'off') { kind = state.precip; mm = 1.5; }
  const amount = Math.min(1, 0.25 + mm * 0.25);
  const showSnow = kind === 'snow' || kind === 'mix', showRain = kind === 'rain' || kind === 'mix';
  const fx = QUAL[state.quality].fx * (kind === 'mix' ? 0.5 : 1); // fewer, not smaller, particles on lighter settings
  snow.visible = showSnow; snowGeo.setDrawRange(0, showSnow ? Math.floor(NP * amount * fx) : 0);
  rain.visible = showRain; rainGeo.setDrawRange(0, showRain ? Math.floor(NR * amount * fx) * 2 : 0);
  const label = { none: 'Pas de précipitations', snow: 'Il neige', rain: 'Il pleut', mix: 'Pluie et neige mêlées' }[kind];
  $('precipNow').textContent = state.precip !== 'auto' ? `Affichage forcé : ${label.toLowerCase()}`
    : precipNow.alt != null ? `${label} à ${fmt(precipNow.alt)} m en ce moment${precipNow.t != null ? ` (${t1(precipNow.t)} °C` + (precipNow.mm > 0.05 ? `, ${t1(precipNow.mm)} mm/h)` : ')') : ''}` : '';
}
let precipCheck = 0;
function updatePrecipForView() {
  if (!state.weather) return;
  const g = groundAt(controls.target.x, controls.target.z); if (g == null) return;
  const p = precipAt(g); if (!p) return;
  const changed = p.kind !== precipNow.kind || Math.abs(p.mm - precipNow.mm) > 0.2 || Math.abs((p.alt ?? 0) - (precipNow.alt ?? 0)) > 150;
  precipNow = p; if (changed) applyPrecip();
  const wdir = state.weather.top.current.wind_direction_10m * Math.PI / 180, ws = Math.min(0.6, state.weather.top.current.wind_speed_10m / 80);
  RU.wind.value.set(-Math.sin(wdir) * ws, Math.cos(wdir) * ws);
}
function renderSatellite() {
  const S = state.s2, el = $('sat');
  if (!S) return;
  const { latest, clear } = S;
  let html = '';
  if (latest) html += `<p class="cline">Dernier passage : <b>${dayName(latest.date)}</b> (${ago(latest.date)}), ${Math.round(latest.cloud * 100)} % de nuages sur le massif.</p>`;
  if (clear) {
    html += `<p class="cline">Dernière image nette : <b>${dayName(clear.date)}</b> (${ago(clear.date)}). C'est elle qui pose la neige du jour sur le relief, lissée et affinée au mètre avec le LiDAR.</p>`;
    if (clear.bands) {
      const first = (side, th) => clear.bands.find(b => b[side] != null && b[side] >= th)?.alt;
      const nOn = first('north', 0.1), sOn = first('south', 0.1), nMaj = first('north', 0.5), sMaj = first('south', 0.5);
      html += `<p class="cline">Neige présente dès <b>${nOn ? fmt(nOn) + ' m' : '—'}</b> au nord et <b>${sOn ? fmt(sOn) + ' m' : '—'}</b> au sud ; majoritaire au-dessus de <b>${nMaj ? fmt(nMaj) + ' m' : '—'}</b> (nord) et <b>${sMaj ? fmt(sMaj) + ' m' : '—'}</b> (sud).</p>` + chart(clear.bands);
    }
  } else html += '<p class="cline">Aucune image sans nuages ces 40 derniers jours.</p>';
  el.innerHTML = html;
}
function chart(bands) {
  const W = 300, H = 180, L = 44, R = 10, T = 8, B = 26, lo = 1200, hi = 4800;
  const y = a => T + (hi - a) / (hi - lo) * (H - T - B), x = f => L + f * (W - L - R);
  const pts = side => bands.filter(b => b[side] != null && b.alt >= lo).map(b => `${x(b[side]).toFixed(1)},${y(b.alt + 50).toFixed(1)}`).join(' ');
  let g = '';
  for (let a = 1500; a <= 4500; a += 500) g += `<line x1="${L}" x2="${W - R}" y1="${y(a)}" y2="${y(a)}" class="gl"/><text x="${L - 6}" y="${y(a) + 3.5}" text-anchor="end">${fmt(a)}</text>`;
  for (const f of [0, 0.5, 1]) g += `<text x="${x(f)}" y="${H - 8}" text-anchor="middle">${f * 100} %</text>`;
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Part du terrain enneigé par altitude">${g}<line x1="${x(0.5)}" x2="${x(0.5)}" y1="${T}" y2="${H - B}" class="half"/><polyline points="${pts('north')}" class="ln n"/><polyline points="${pts('south')}" class="ln s"/></svg>
    <figcaption><span class="k n"></span>Versant nord <span class="k s"></span>Versant sud · part du terrain enneigé par altitude (m)</figcaption></figure>`;
}
async function refreshLive() {
  $('wx').innerHTML = '<p class="cmeta">Récupération de la météo…</p>';
  try { state.weather = await fetchWeather(); renderWeather(); }
  catch (e) { $('wx').innerHTML = `<p class="cline">Météo indisponible (${esc(e.message)}). Vérifiez la connexion.</p>`; }
  $('sat').innerHTML = '<p class="cmeta">Recherche du dernier passage Sentinel-2…</p>';
  try {
    state.s2 = await findSentinel(d => { $('sat').innerHTML = `<p class="cmeta">Analyse de l'image du ${dayName(new Date(d))}…</p>`; });
    renderSatellite();
    if (state.s2.clear) { engine.setOverlayItem(state.s2.clear); engine.setOverlay('snow', state.snowToday); engine.setOverlay('vis', state.render === 'sat'); }
  } catch (e) { $('sat').innerHTML = `<p class="cline">Satellite indisponible (${esc(e.message)}).</p>`; }
}

// ---------- UI ----------
const sheets = ['places', 'cond', 'layers'];
function openSheet(name) {
  $('sheet-point').hidden = true;
  sheets.forEach(s => { const on = s === name && $('sheet-' + s).hidden; $('sheet-' + s).hidden = !on; $('tab-' + s).setAttribute('aria-pressed', on); });
}
function closeSheets() { sheets.forEach(s => { $('sheet-' + s).hidden = true; $('tab-' + s).setAttribute('aria-pressed', 'false'); }); }
sheets.forEach(s => { $('tab-' + s).addEventListener('click', () => openSheet(s)); $('sheet-' + s).querySelector('.close').addEventListener('click', closeSheets); });
const seg = (group, key, fn) => document.querySelectorAll(`[data-${group}]`).forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll(`[data-${group}]`).forEach(x => x.setAttribute('aria-pressed', x === b)); state[key] = b.dataset[group]; fn?.(b.dataset[group]);
}));
const markSeg = (group, val) => document.querySelectorAll(`[data-${group}]`).forEach(x => x.setAttribute('aria-pressed', x.dataset[group] === val));
seg('render', 'render', v => { U.visToday.value = v === 'sat' ? 1 : 0; engine.setOverlay('vis', v === 'sat'); });
seg('light', 'light', v => { U.light.value = v === 'sun' ? 1 : 0; $('f-time').classList.toggle('dim', v !== 'sun'); });
seg('quality', 'quality', applyQuality);
seg('precip', 'precip', applyPrecip);
$('time').addEventListener('input', e => { state.hourOffset = +e.target.value; updateSky(); });
$('now').addEventListener('click', () => { $('time').value = 0; state.hourOffset = 0; updateSky(); });
$('exag').addEventListener('input', e => {
  const v = +e.target.value, r = v / state.exag; state.exag = v; U.exag.value = v; engine.setExaggeration(v);
  controls.target.y *= r; camera.position.y *= r; placeCable(); $('exagOut').textContent = '×' + v.toFixed(2).replace(/0$/, '');
});
$('vivid').addEventListener('input', e => { U.vivid.value = +e.target.value; $('vividOut').textContent = +e.target.value < 0.02 ? 'naturelles' : '+' + Math.round(+e.target.value * 100) + ' %'; });
$('c-snowtoday').addEventListener('change', e => { state.snowToday = e.target.checked; U.snowToday.value = e.target.checked ? 1 : 0; engine.setOverlay('snow', e.target.checked); });
$('c-clouds').addEventListener('change', e => { state.clouds = e.target.checked; renderWeather(); if (!state.weather) cloudU.cover.value = 0; showCloudLayers(); });
// cloud layers cover the whole screen: none drawn in clear weather, fewer on lighter settings
function showCloudLayers() { const n = QUAL[state.quality].clouds; clouds.children.forEach((m, i) => { m.visible = cloudU.cover.value > 0.01 && i < n; }); }
$('c-labels').addEventListener('change', e => { state.labels = e.target.checked; labelsEl.hidden = !e.target.checked; });
$('c-cable').addEventListener('change', e => { cable.visible = cabins.visible = e.target.checked; });
// slope map: toggle, legend built from the same classes as the shader, choice remembered on the device
$('slopeRows').innerHTML = SLOPE_CLASSES.map(([a, c], i) => {
  const next = SLOPE_CLASSES[i + 1]?.[0];
  return `<li><i style="background:${c}"></i>${next ? `${a}–${next}°` : `plus de ${a}°`}</li>`;
}).join('');
function applySlopes(on) {
  state.slopes = on; U.slopes.value = on ? 1 : 0; $('c-slopes').checked = on; $('slopeLegend').hidden = !on;
  try { localStorage.setItem('midi3d-slopes', on ? '1' : '0'); } catch { }
}
$('c-slopes').addEventListener('change', e => applySlopes(e.target.checked));
applySlopes(state.slopes);

// ---------- view: IGN terrain or Google Photorealistic 3D Tiles, never both at once (see google3d.js) ----------
state.view = 'ign';
const GERR = {
  key: "Google refuse la clé. Vérifie qu'elle est copiée en entier, que la Map Tiles API est activée, que la facturation est configurée et que la clé autorise le site qdesbuisson87-web.github.io.",
  network: 'Google 3D ne répond pas (connexion ou quota du jour atteint). Retour à la vue IGN.'
};
function setView(v) {
  if (v === 'google' && !googleKey.get()) { $('gKeyBlock').hidden = false; $('gKey').focus(); $('gNote').textContent = ''; return; }
  if (v === 'google' && !navigator.onLine) { $('gNote').textContent = "La vue Google 3D demande une connexion : Google interdit de la garder hors ligne. La vue IGN marche hors ligne."; return; }
  const g = v === 'google';
  state.view = v; markSeg('view', v);
  document.body.classList.toggle('google', g);
  engine.group.visible = !g; $('gAttrib').hidden = !g; $('gKeyBlock').hidden = !g;
  if (g) {
    // Google's surface cannot be exaggerated: back to true relief
    if (state.exag !== 1) { $('exag').value = 1; $('exag').dispatchEvent(new Event('input')); }
    applyScale();
    google.start(googleKey.get(), async err => {
      setView('ign'); $('gNote').textContent = GERR[err];
      if (err !== 'key') return;
      $('gKeyBlock').hidden = false;
      const why = await whyRefused(googleKey.get()); // Google's own reason, when it gives one
      if (why) $('gNote').textContent = 'Google refuse : ' + why;
    });
    scene.fog = gFog;
  } else { google.stop(); scene.fog = null; }
  // layers computed on the IGN terrain are not drawn over Google's tiles
  for (const id of ['c-slopes', 'c-snowtoday', 'exag']) $(id).disabled = g;
  $('slopeLegend').hidden = g || !state.slopes;
  $('gNote').textContent = g ? 'Vue Google 3D (photos et relief Google, en ligne seulement). La carte des pentes, la neige du jour et le relief exagéré restent dans la vue IGN.' : '';
  try { localStorage.setItem('midi3d-view', v); } catch { }
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
// without the logo file, at least name Google (the official logo lives in icons/google-maps-logo.png)
const noLogo = () => $('gLogo')?.replaceWith(Object.assign(document.createElement('b'), { textContent: 'Google', className: 'glogo' }));
if ($('gLogo').complete && !$('gLogo').naturalWidth) noLogo(); else $('gLogo').addEventListener('error', noLogo);
$('gKeySave').addEventListener('click', () => {
  const k = $('gKey').value.trim();
  // Google API keys: 39 characters starting with "AIza"
  if (!/^AIza[\w-]{30,40}$/.test(k)) { $('gNote').textContent = 'Ça ne ressemble pas à une clé API Google (39 caractères, commence par « AIza »).'; return; }
  googleKey.set(k); $('gKey').value = ''; setView('google');
});
$('gKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('gKeySave').click(); });
$('gKeyClear').addEventListener('click', () => { googleKey.set(''); setView('ign'); $('gNote').textContent = 'Clé effacée de cet appareil.'; });
let savedView = 'ign'; try { savedView = localStorage.getItem('midi3d-view') || 'ign'; } catch { }
$('c-spin').addEventListener('change', e => { controls.autoRotate = e.target.checked; });
$('home').addEventListener('click', home);
$('refresh').addEventListener('click', refreshLive);
// Automatic adjustment: the chosen quality sets the ceiling; when the measured frame rate stays under the
// quality's target, the resolution goes down first (down to half), then the terrain detail (down to 60 %).
// Both come back, detail first, after several seconds of comfortable frame rate.
const adapt = { res: 1, detail: 1, good: 0, since: 0 };
function applyScale() {
  const Q = QUAL[state.quality]; engine.splitK = Q.k * adapt.detail; google.setErrorTarget(Q.gErr / adapt.detail);
  const pr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, Q.pr) * adapt.res);
  if (Math.abs(pr - renderer.getPixelRatio()) > 0.01) { renderer.setPixelRatio(pr); resize(); }
}
function adaptTo(fps) {
  const Q = QUAL[state.quality], now = performance.now();
  if (!started || document.hidden || now - adapt.since < 3000) return; // let a change settle before judging it
  if (fps < Q.fps * 0.9) {
    adapt.good = 0;
    if (adapt.res > 0.55) adapt.res = Math.max(0.5, adapt.res * 0.85);
    else if (adapt.detail > 0.65) adapt.detail = Math.max(0.6, adapt.detail - 0.1);
    else return;
  } else if (fps >= Math.min(Q.fps + 12, 57) && (adapt.res < 1 || adapt.detail < 1)) {
    if (++adapt.good < 4) return;
    adapt.good = 0;
    if (adapt.detail < 1) adapt.detail = Math.min(1, adapt.detail + 0.1); else adapt.res = Math.min(1, adapt.res / 0.85);
  } else { adapt.good = 0; return; }
  adapt.since = now; applyScale();
}
function applyQuality(q) {
  const Q = QUAL[q]; engine.maxTiles = Q.tiles; engine.maxLoads = Q.loads;
  Object.assign(adapt, { res: 1, detail: 1, good: 0, since: performance.now() });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pr)); resize(); applyScale();
  showCloudLayers(); applyPrecip();
  try { localStorage.setItem('midi3d-quality', q); } catch { }
}
markSeg('quality', state.quality);


// ---------- "à ton altitude": fresh snow / rain forecast at a chosen height or point ----------
let pickArmed = false, altPoint = null;
async function altitudeReport(lat, lon, alt, where) {
  const out = $('altOut');
  out.innerHTML = `<p class="cmeta">Prévision pour ${fmt(alt)} m…</p>`;
  try {
    const f = await pointForecast(lat, lon, alt);
    const c = f.current, cm = v => v >= 0.5 ? t1(v) + ' cm' : v > 0 ? 'traces' : '0 cm', mmv = v => v >= 0.2 ? t1(v) + ' mm' : '0 mm';
    let sat = '';
    const S = state.s2?.clear;
    if (S?.bands) {
      const b = S.bands.find(x => alt >= x.alt && alt < x.alt + 100);
      if (b) { const pct = v => v == null ? '—' : Math.round(v * 100) + ' %'; sat = `<p class="cline">Au sol, vu par satellite le ${dayName(S.date)} : neige sur <b>${pct(b.north)}</b> des pentes nord et <b>${pct(b.south)}</b> des pentes sud entre ${fmt(b.alt)} et ${fmt(b.alt + 100)} m.</p>`; }
    }
    out.innerHTML = `<p class="cmeta">${esc(where)} · ${fmt(alt)} m · Météo-France</p>
      <div class="kpis">
        <div><span>Neige fraîche 24 h</span><b>${cm(f.snow24)}</b></div>
        <div><span>Neige fraîche 72 h</span><b>${cm(f.snow72)}</b></div>
        <div><span>Pluie 24 h</span><b>${mmv(f.rain24)}</b></div>
        <div><span>Température</span><b>${t1(c.temperature_2m)}°</b></div>
      </div>
      <p class="cline">Maintenant : ${esc(WMO[c.weather_code] || '—')}${c.snowfall > 0 ? `, ${t1(c.snowfall)} cm/h de neige` : c.rain > 0 ? `, ${t1(c.rain)} mm/h de pluie` : ''} · min/max 24 h ${Math.round(f.tmin)}° / ${Math.round(f.tmax)}°${f.firstSnow ? ` · prochaine neige : ${new Date(f.firstSnow).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      ${sat}
      <p class="cnote">La hauteur totale de neige au sol n'est pas mesurée ici : les modèles sont trop peu fiables en haute montagne. Les cm affichés sont la neige fraîche prévue.</p>`;
  } catch (e) { out.innerHTML = `<p class="cline">Prévision indisponible (${esc(e.message)}).</p>`; }
}
$('altGo').addEventListener('click', () => {
  const a = Math.round(+$('altIn').value);
  if (!(a >= 500 && a <= 4810)) { $('altOut').innerHTML = '<p class="cline">Indique une altitude entre 500 et 4 810 m.</p>'; return; }
  // typed altitude: forecast on the Chamonix -> Aiguille du Midi axis, unless a point was picked on the map
  const lat = altPoint?.lat ?? SPOTS.top.lat, lon = altPoint?.lon ?? SPOTS.top.lon;
  altitudeReport(lat, lon, a, altPoint ? `Point choisi (${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E)` : `Secteur ${SPOTS.top.name}`);
});
$('altIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('altGo').click(); });
$('altPick').addEventListener('click', () => { pickArmed = true; $('altPick').textContent = 'Touche le relief…'; if (touch) closeSheets(); });
function pickAt(hit) {
  if (!pickArmed || !hit) return false;
  pickArmed = false; $('altPick').textContent = 'Choisir sur le relief';
  const [lon, lat] = worldToLonLat(hit.x, hit.z); altPoint = { lat, lon };
  $('altIn').value = Math.round(hit.h); openSheet('cond');
  altitudeReport(lat, lon, hit.h, `Point choisi (${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E)`);
  $('sheet-cond').querySelector('#altBlock')?.scrollIntoView({ block: 'start' });
  return true;
}

// ---------- point conditions: tap anywhere on the relief ----------
let pin = null, pinSeq = 0;
// Sentinel-2 at the exact point (10 m pixel): snow index and scene class of the last clear pass
async function satSnowAt(lat, lon) {
  const S = state.s2?.clear; if (!S || !engine.overlay.item) return null;
  const [fx, fy] = lonLatToTile(lon, lat, 14), x = Math.floor(fx), y = Math.floor(fy);
  const px = Math.min(255, Math.floor((fx - x) * 256)), py = Math.min(255, Math.floor((fy - y) * 256));
  const read = async kind => {
    const r = await fetch(engine.overlayUrl(kind, 14, x, y)); if (!r.ok) return null;
    const bm = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const cv = document.createElement('canvas'); cv.width = cv.height = 3; const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(bm, Math.max(0, px - 1), Math.max(0, py - 1), 3, 3, 0, 0, 3, 3); const d = c.getImageData(0, 0, 3, 3).data;
    return { v: d[16], a: d[19] }; // centre pixel of the 3x3 read
  };
  const [nd, cl] = await Promise.all([read('ndsi'), read('cloud')]);
  if (!nd || !nd.a) return { date: S.date, nodata: true };
  const ndsi = nd.v / 255 * 2 - 1, cls = cl?.a ? cl.v : 0;
  return { date: S.date, ndsi, fsc: Math.max(0, Math.min(1, 1.45 * ndsi - 0.01)), cloud: cls === 3 || (cls >= 8 && cls <= 10) };
}
async function pointReport(hit) {
  const seq = ++pinSeq; pin = hit;
  sheets.forEach(s => { $('sheet-' + s).hidden = true; $('tab-' + s).setAttribute('aria-pressed', 'false'); });
  $('sheet-point').hidden = false;
  const [lon, lat] = worldToLonLat(hit.x, hit.z), s = engine.slopeAt(hit.x, hit.z);
  const where = hit.surface === 'google' ? 'altitude de la surface Google 3D (arbres, bâtiments et neige compris, ±quelques m)' : `relief ${SRC[s?.src] ?? 'IGN'}`;
  const meta = `<p class="cmeta">${lat.toFixed(5)}° N · ${lon.toFixed(5)}° E · ${where}</p>`
    + (s ? `<p class="cline"><b>${s.deg < 3 ? 'Terrain plat' : `Pente ${Math.round(s.deg)}°`}</b>${s.deg >= 3 ? ` orientée ${compass16(s.aspect)}` : ''} <span class="small">· mesurée sur ${s.step < 10 ? t1(s.step) : fmt(s.step)} m, terrain nu</span></p>` : '');
  $('ptTitle').textContent = `${fmt(hit.h)} m`;
  $('ptOut').innerHTML = meta + '<p class="cmeta">Récupération des conditions…</p>';
  const [f, sat] = await Promise.all([pointForecast(lat, lon, hit.h).catch(e => ({ error: e.message })), satSnowAt(lat, lon).catch(() => null)]);
  if (seq !== pinSeq) return;
  const cm = v => v >= 0.5 ? t1(v) + ' cm' : v > 0 ? 'traces' : '0 cm', mmv = v => v >= 0.2 ? t1(v) + ' mm' : '0 mm';
  let html = meta;
  if (f.error) html += `<p class="cline">Météo indisponible (${esc(f.error)}).</p>`;
  else {
    const c = f.current;
    const now = c.snowfall > 0 ? `Il neige : ${t1(c.snowfall)} cm/h` : c.rain > 0 ? `Il pleut : ${t1(c.rain)} mm/h` : esc(WMO[c.weather_code] || '—');
    html += `<p class="cline"><b>${t1(c.temperature_2m)} °C</b> · ${now} · vent ${Math.round(c.wind_speed_10m)} km/h, rafales ${Math.round(c.wind_gusts_10m)}</p>
      <div class="kpis">
        <div><span>Neige fraîche 24 h</span><b>${cm(f.snow24)}</b></div>
        <div><span>Neige fraîche 72 h</span><b>${cm(f.snow72)}</b></div>
        <div><span>Pluie 24 h</span><b>${mmv(f.rain24)}</b></div>
        <div><span>Min / max 24 h</span><b>${Math.round(f.tmin)}° / ${Math.round(f.tmax)}°</b></div>
      </div>${f.firstSnow ? `<p class="cline small">Prochaine chute de neige prévue : ${new Date(f.firstSnow).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}</p>` : ''}`;
  }
  html += '<h3>Neige au sol à cet endroit</h3>';
  if (!sat) html += '<p class="cline">Pas d\'image satellite exploitable pour ce point.</p>';
  else if (sat.nodata) html += `<p class="cline">Ce point est hors de l'image satellite du ${dayName(sat.date)}.</p>`;
  else if (sat.cloud) html += `<p class="cline">Nuage sur ce point le ${dayName(sat.date)} : le satellite n'a pas pu voir le sol.</p>`;
  else {
    const yes = sat.fsc >= 0.5, some = sat.fsc >= 0.15;
    html += `<p class="cline"><b>${yes ? 'Enneigé' : some ? 'Neige partielle' : 'Pas de neige'}</b> le ${dayName(sat.date)} (${ago(sat.date)}) · couverture estimée ${Math.round(sat.fsc * 100)} % du pixel de 10 m.</p>`;
    if (!f.error && f.snow72 >= 0.5) html += `<p class="cline small">Depuis cette image, de la neige a pu tomber : ${cm(f.snow72)} prévus sur les 72 prochaines heures.</p>`;
  }
  html += `<p class="cnote">Hauteur totale de neige au sol : aucune mesure gratuite et fiable n'existe point par point. Les modèles météo se contredisent en haute montagne ; seules les stations nivologiques Météo-France la mesurent vraiment.</p>`;
  $('ptOut').innerHTML = html;
}
$('sheet-point').querySelector('.close').addEventListener('click', () => { $('sheet-point').hidden = true; pin = null; $('pin').hidden = true; });

// ---------- offline: download the massif onto the device ----------
const CORE_LL = SITE.core, MIDI_LL = SITE.detail; // whole massif / summit area at 20 cm
const PACKS = { essentiel: { maxz: 16 }, detaille: { maxz: 17 }, maximum: { maxz: 18, z19: true } };
const KB_PER_TILE = 48;
let packChoice = 'detaille', packRun = null;
function tilesIn(ll, z) {
  const [x0, y0] = lonLatToTile(ll[0], ll[3], z), [x1, y1] = lonLatToTile(ll[2], ll[1], z), out = [];
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let x = Math.floor(x0); x <= Math.floor(x1); x++) out.push([z, x, y]);
  return out;
}
function packTiles(name) {
  const P = PACKS[name], list = [];
  for (let z = 11; z <= P.maxz; z++) list.push(...tilesIn(CORE_LL, z));
  if (P.z19) list.push(...tilesIn(MIDI_LL, 19));
  return list;
}
const mo = kb => kb > 1e6 ? (kb / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Go' : Math.round(kb / 1e3).toLocaleString('fr-FR') + ' Mo';
function showPack() {
  const n = packTiles(packChoice).length;
  $('packInfo').textContent = `${n.toLocaleString('fr-FR')} tuiles (photo + relief), environ ${mo(n * KB_PER_TILE)}.`;
}
async function showStorage() {
  if (!navigator.storage?.estimate) { $('storageInfo').textContent = ''; return; }
  const e = await navigator.storage.estimate();
  $('storageInfo').textContent = `Stocké sur l'appareil : ${mo((e.usage || 0) / 1000)}${e.quota ? ` sur ${mo(e.quota / 1000)} disponibles` : ''}.`;
}
async function runPack() {
  if (!self.isSecureContext || !self.caches) { $('packInfo').textContent = "Le hors ligne demande une adresse https (ou l'ordinateur lui-même, via lancer.bat)."; return; }
  if (packRun) return;
  navigator.storage?.persist?.();
  const list = packTiles(packChoice), run = packRun = { stop: false, done: 0, fail: 0 };
  $('packGo').disabled = true; $('packStop').hidden = false;
  let next = 0;
  const worker = async () => {
    while (!run.stop && next < list.length) {
      const [z, x, y] = list[next++];
      const urls = [photoUrl(z, x, y), z <= 13 ? terrariumUrl(z, x, y) : elevRequest(z, x, y).url(LIDAR_LAYER)];
      try { for (const u of urls) { const r = await cachedFetch(u); if (!r.ok && r.status !== 404) throw 0; await r.arrayBuffer(); } } catch { run.fail++; }
      run.done++;
      if (run.done % 10 === 0 || run.done === list.length) {
        $('packBar').style.width = (run.done / list.length * 100) + '%';
        $('packInfo').textContent = `${run.done.toLocaleString('fr-FR')} / ${list.length.toLocaleString('fr-FR')} tuiles${run.fail ? ` · ${run.fail} échecs (relancer pour les reprendre)` : ''}`;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  $('packInfo').textContent = run.stop ? `Arrêté à ${run.done.toLocaleString('fr-FR')} tuiles. Relancer reprend là où ça s'est arrêté.` : `Terminé : ${list.length.toLocaleString('fr-FR')} tuiles disponibles hors ligne${run.fail ? ` (${run.fail} échecs, relancer pour les reprendre)` : ''}.`;
  packRun = null; $('packGo').disabled = false; $('packStop').hidden = true; showStorage();
}
document.querySelectorAll('[data-pack]').forEach(b => b.addEventListener('click', () => { packChoice = b.dataset.pack; markSeg('pack', packChoice); showPack(); }));
markSeg('pack', packChoice); showPack(); showStorage();
$('packGo').addEventListener('click', runPack);
$('packStop').addEventListener('click', () => { if (packRun) packRun.stop = true; });
$('cacheClear').addEventListener('click', async () => {
  if ($('cacheClear').dataset.armed !== '1') { $('cacheClear').dataset.armed = '1'; $('cacheClear').textContent = 'Confirmer : tout effacer'; setTimeout(() => { $('cacheClear').dataset.armed = ''; $('cacheClear').textContent = 'Vider le stockage'; }, 4000); return; }
  await caches.delete(TILE_CACHE).catch(() => { }); resetTileCache();
  $('cacheClear').dataset.armed = ''; $('cacheClear').textContent = 'Vider le stockage'; showStorage();
});

// labels
const proj = new THREE.Vector3();
let frameN = 0;
function updateLabels() {
  if (pin) {
    proj.set(pin.x, pin.h * state.exag, pin.z).project(camera);
    const on = proj.z < 1 && Math.abs(proj.x) < 1.2 && Math.abs(proj.y) < 1.2;
    $('pin').hidden = !on;
    if (on) $('pin').style.transform = `translate(${(proj.x * 0.5 + 0.5) * stage.clientWidth}px, ${(-proj.y * 0.5 + 0.5) * stage.clientHeight}px)`;
  }
  if (!state.labels) return;
  const w = stage.clientWidth, h = stage.clientHeight, cam = camera.position;
  PLACES.forEach((p, i) => {
    if ((frameN + i) % 20 === 0 && p.area) { const g = groundAt(p.x, p.z); if (g != null) p.h = g + 80; }
    const y = p.h * state.exag;
    proj.set(p.x, y, p.z).project(camera);
    const on = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
    if (on && (frameN + i) % 10 === 0) {
      const dx = p.x - cam.x, dy = y - cam.y, dz = p.z - cam.z, L = Math.hypot(dx, dy, dz);
      let hid = L > (p.small ? 9000 : p.area ? 14000 : 40000) || L < 60;
      for (let s = 1; s < 48 && !hid; s++) { const f = s / 48 * 0.94, g = groundAt(cam.x + dx * f, cam.z + dz * f); if (g != null && g * state.exag > cam.y + dy * f + 12) hid = true; }
      p.hidden = hid;
    }
    p.el.classList.toggle('hidden', !on || !!p.hidden);
    if (on) p.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px, ${(-proj.y * 0.5 + 0.5) * h}px)`;
  });
}

// ---------- loop ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  SU.proj.value = h * renderer.getPixelRatio() / (2 * Math.tan(camera.fov * Math.PI / 360));
}
addEventListener('resize', resize);
applyQuality(state.quality);
const clock = new THREE.Clock(); let fpsAcc = 0, fpsN = 0, adAcc = 0, adN = 0, started = false, gGround = null;
// ?debugloop keeps rendering in a hidden tab (for automated checks); normal use follows the display refresh
const nextFrame = location.search.includes("debugloop") ? cb => setTimeout(cb, 16) : cb => requestAnimationFrame(cb);
function frame() {
  const dt = clock.getDelta(), t = clock.elapsedTime;
  U.time.value = t;
  if (fly) {
    const f = Math.min(1, (performance.now() - fly.t0) / fly.dur), e = ease(f);
    controls.target.lerpVectors(fly.fT, fly.tT, e); camera.position.lerpVectors(fly.fP, fly.tP, e);
    camera.position.y += Math.sin(f * Math.PI) * fly.fP.distanceTo(fly.tP) * 0.1;
    if (f >= 1) fly = null;
  }
  controls.update();
  const c = camera.position;
  // ground under the camera (keeps it above the surface, sets the near plane): Google's own surface in that view,
  // probed a few times per second since a ray through the tiles costs more than a grid lookup
  if (google.on && frameN % 6 === 0) {
    rayG.set(new THREE.Vector3(c.x, 9000, c.z), new THREE.Vector3(0, -1, 0)); rayG.far = 20000;
    gGround = google.raycast(rayG)?.y ?? null; rayG.far = Infinity;
  }
  const g = google.on ? (gGround ?? groundAt(c.x, c.z)) : groundAt(c.x, c.z);
  if (g != null && c.y < g * state.exag + 4) c.y = g * state.exag + 4;
  const above = g != null ? c.y - g * state.exag : 1000, td = c.distanceTo(controls.target);
  camera.near = Math.min(Math.max(Math.min(above, td) * 0.15, 0.3), 200); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  sky.position.copy(c); clouds.position.set(c.x, 0, c.z); SU.camPos.value.copy(c);
  SU.boxSize.value = Math.min(Math.max(td * 0.9, 40), 9000);
  if (cabins.visible) { const a = cabinGeo.attributes.position.array, ph = (t * 0.02) % 2, f = ph < 1 ? ph : 2 - ph; a.set(cablePoint(0, f), 0); a.set(cablePoint(1, 1 - f), 3); cabinGeo.attributes.position.needsUpdate = true; }
  if (google.on) google.update(); else engine.update(camera);
  if (hoverNDC && frameN % (google.on ? 10 : 3) === 0) showPoint(pick(...hoverNDC));
  updateLabels(); frameN++;
  if (frameN % 600 === 0 && state.hourOffset === 0) updateSky();
  if (frameN % 45 === 0) updatePrecipForView();
  renderer.render(scene, camera);
  if (!started && engine.roots.filter(r => r.state === 'ready').length >= engine.roots.length * 0.6) {
    started = true; $('loader').classList.add('done'); home();
    if (savedView === 'google' && googleKey.get()) setView('google'); // each opening of the Google view = one Google session
  }
  if (google.on && frameN % 30 === 0) { const a = google.attributions(); $('gAttribTxt').textContent = a.length ? a.join(' ; ') : 'Google'; }
  fpsAcc += dt; fpsN++; adAcc += dt; adN++;
  if (adAcc > 1.5) { adaptTo(adN / adAcc); adAcc = 0; adN = 0; }
  if (fpsAcc > 0.5) {
    const auto = adapt.res < 1 || adapt.detail < 1 ? ` · auto ${Math.round(adapt.res * adapt.detail * 100)} %` : '';
    $('rFps').textContent = `${Math.round(fpsN / fpsAcc)} i/s · ${google.on ? 'Google 3D' : `${engine.tileCount ?? 0} tuiles`}${auto}`;
    const busy = google.on ? google.loading : engine.busy;
    $('status').hidden = busy === 0; $('statusN').textContent = busy;
    fpsAcc = 0; fpsN = 0;
  }
  nextFrame(frame);
}
window.midi3d = { engine, google, camera, controls, adapt, applyScale }; // handy for debugging from the console
updateSky(); frame(); refreshLive();
setInterval(() => { if (document.visibilityState === 'visible') refreshLive(); }, 15 * 60e3);
setTimeout(() => $('loader').classList.add('done'), 15000);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
