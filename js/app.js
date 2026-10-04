import * as THREE from 'three';
import { EarthControls } from './controls.js?v=202610042116';
import { lonLatToWorld, worldToLonLat, lonLatToTile, ORIGIN } from './geo.js?v=202610042116';
import { SITE, SITE_LIST } from './sites.js?v=202610042116';
import { TerrainEngine, EPOCHS, GRID, photoUrl, terrariumUrl, elevRequest, LIDAR_LAYER } from './terrain.js?v=202610042116';
import { cachedFetch, TILE_CACHE, resetTileCache } from './net.js?v=202610042116';
import { GoogleMap3D, googleKey, keyChanged } from './google3d.js?v=202610042116';
import { searchPlaces } from './search.js?v=202610042116';
import { TerrainShadows } from './shadows.js?v=202610042116';
import { PostFX } from './post.js?v=202610042116';
import { SkyBaker, SKY_LOOKUP_GLSL, skyColors } from './atmosphere.js?v=202610042116';
import { Forest } from './forest.js?v=202610042116';
import { Lakes } from './water.js?v=202610042116';
import { Glaciers } from './glaciers.js?v=202610042116';
import { makeSite, removeSite } from './custom.js?v=202610042116';
import { Pistes, PISTE_LEGEND } from './pistes.js?v=202610042116';
import { Streams } from './streams.js?v=202610042116';
import { Refuges } from './refuges.js?v=202610042116';
import { NightLights } from './lights.js?v=202610042116';
import { Buildings } from './buildings.js?v=202610042116';
import { fetchBera, beraKey, RISK } from './bera.js?v=202610042116';
import { loadPlanned, savePlanned, scheduleReminders, cancelReminders, reminderTopic, leaveAt } from './planned.js?v=202610042116';
import { junctions, say } from './guide.js?v=202610042116';
import { TrackRecorder, progressOn } from './track.js?v=202610042116';
import { GpsTracker } from './gps.js?v=202610042116';
import { RouteLayer, resamplePath, pathStats, netString } from './route.js?v=202610042116';
import { liftPlans, altitudes } from './liftplan.js?v=202610042116';
import { walkingRoute } from './planner.js?v=202610042116';
import { buildHikes, loadHikes, hikePath, classify, CLASS_NAMES } from './hikes.js?v=202610042116';
import { loadC2C, prepare as prepareC2C, FILTERS as C2C_FILTERS, CONDITIONS as C2C_COND, ratingText, activityText, matches as c2cMatches, lineOf as c2cLine, snowText } from './c2c.js?v=202610042116';
import { TrailsLayer } from './trails.js?v=202610042116';
import { Weather3D } from './weather3d.js?v=202610042116';
import { Sight } from './sight.js?v=202610042116';
import { Photos360 } from './photos360.js?v=202610042116';
import { PointCloud, POINT_CLASSES, LIMITS } from './lidar.js?v=202610042116';
import { radarFrames, fetchWeather, findSentinel, sentinelYear, sunPosition, sunTimes, moonPosition, pointForecast, routeForecast, cloudProfile, SPOTS } from './live.js?v=202610042116';
import { VolumeClouds } from './clouds.js?v=202610042116';
import { LiveShare, LiveFollow } from './share.js?v=202610042116';
import { NightSky } from './sky.js?v=202610042116';
import { loadBook, saveBook, routeFacts, nightSpots, stages, whenToLeave, sunrise, walkability, exposure, skiStats, SKI_BINS } from './routebook.js?v=202610042116';
THREE.ColorManagement.enabled = false;

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('fr-FR');
const t1 = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toLocaleString('fr-FR');
// an error said on screen: the browsers' network errors are technical English ("Failed to fetch", "Load failed")
const why = e => { const m = String(e?.message ?? e ?? ''); return e?.name === 'AbortError' || /aborted/i.test(m) ? 'le réseau ne répond pas' : /fetch|network|load failed/i.test(m) ? 'pas de réseau' : m; };
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
const post = new PostFX(renderer); // final image: highlights, glow, contrast (post.js)
const camera = new THREE.PerspectiveCamera(50, 1, 1, 250000);
// Google-Earth-like gestures (controls.js): the ground under the finger is grabbed; the point under a screen
// position comes from pick() (the IGN relief or the Google surface), defined further down
const controls = new EarthControls(camera, renderer.domElement,
  (nx, ny, cam) => { const h = pick(nx, ny, cam); return h ? new THREE.Vector3(h.x, h.h * state.exag, h.z) : null; },
  (x, z) => { const g = groundAt(x, z); return g == null ? null : g * state.exag; });

// ---------- quality ----------
const touch = matchMedia('(pointer: coarse)').matches;
const beefy = (navigator.deviceMemory || 8) >= 6 && (navigator.hardwareConcurrency || 8) >= 8;
// k: tile split distance (detail), pr: highest pixel ratio, fps: frame rate the automatic adjustment defends,
// fx: share of the snow/rain particles, clouds: layers of the sea of clouds
const QUAL = {
  standard: { k: 1.6, pr: 1.25, tiles: 450, loads: 6, fps: 50, fx: 0.3, clouds: 2, gErr: 24, shRes: 512, shSteps: 80, ao: 8, trees: 12000, vSteps: 0, aoRes: 256, px: 1.2e6, pts: 6e5, ptPx: 2.2 },
  haute: { k: 2.2, pr: 2, tiles: 800, loads: 8, fps: 55, fx: 0.6, clouds: 3, gErr: 12, shRes: 1024, shSteps: 112, ao: 8, trees: 40000, vSteps: 20, aoRes: 512, px: 2.4e6, pts: 1.5e6, ptPx: 1.7 },
  extreme: { k: 3.2, pr: 3, tiles: 1300, loads: 12, fps: 30, fx: 1, clouds: 4, gErr: 6, shRes: 2048, shSteps: 160, ao: 16, trees: 120000, vSteps: 40, aoRes: 1024, px: 4.5e6, pts: 4e6, ptPx: 1.3 } // gErr: Google 3D screen error (px); sh*: shadow maps; ao: directions searched for the sky visibility; vSteps: steps through the clouds in volume (0 = flat layers); aoRes: sky-visibility map; px: most pixels drawn (large screens); pts: LiDAR point budget, ptPx: their spacing on screen (CSS px)
};
// phones start in "Haute" (the promise: 60 i/s on a high-end phone); "Extrême" is a deliberate choice there
let savedQuality = null; try { savedQuality = localStorage.getItem('midi3d-quality'); } catch { }
const state = { quality: QUAL[savedQuality] ? savedQuality : (beefy && !touch ? 'extreme' : 'haute'), exag: 1, render: 'photo', light: 'photo', hourOffset: 0, snowToday: true, clouds: true, precip: 'auto', labels: true, cable: true, slopes: false, weather: null, s2: null };
try { state.slopes = localStorage.getItem('midi3d-slopes') === '1'; } catch { }

// ---------- shared uniforms & terrain shaders ----------
const U = {
  exag: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Vector3(1, 1, 1) }, skyCol: { value: new THREE.Vector3() }, horizonCol: { value: new THREE.Vector3() }, glowCol: { value: new THREE.Vector3() },
  noiseTex: { value: cloudNoiseTexture() }, // tileable fractal noise: cloud shapes and rock grain
  // cast shadows (shadows.js): fine and coarse shadow maps and their squares on the ground
  shF: { value: null }, shC: { value: null }, srF: { value: new THREE.Vector4() }, srC: { value: new THREE.Vector4() }, shOn: { value: 0 },
  aoF: { value: null }, aoC: { value: null }, aoOn: { value: 0 }, // sky visibility (ambient occlusion), same squares
  // shadows of the clouds in volume (clouds.js): their noise, the densest layer's altitude and cover, the wind
  glF: { value: null }, glC: { value: null }, // glacier outlines painted from above (glaciers.js), same squares
  clNoise: { value: null }, clOn: { value: 0 }, clAlt: { value: 2500 }, clCover: { value: 0 }, clWind: { value: null },
  historic: { value: 0 }, // 1 with an old aerial photo: today's snow, ice and season colours are not drawn on it
  doy: { value: 180 }, // day of the year shown (1–366): colours of the season (forests)
  night: { value: 0 }, // 0 by day, 1 at night under the real-sun light: lit windows, village lights
  light: { value: 0 }, vivid: { value: 0.2 }, snowToday: { value: 1 }, visToday: { value: 0 }, slopes: { value: state.slopes ? 1 : 0 },
  // the avalanche bulletin on the relief: on/off, altitude limit, risk colours below / above it, orientations (bits N…NW)
  beraOn: { value: 0 }, beraAlt: { value: 0 }, beraMask: { value: 255 }, beraColLo: { value: new THREE.Vector3() }, beraColHi: { value: new THREE.Vector3() },
  fogDensity: { value: 0.000016 }, haze: { value: 0 }, time: { value: 0 }
};
U.clTime = U.time; // the clouds' clock under its own name (several shaders already declare "time")
// slope classes (degrees, lower bound) and their colours; the shader and the on-screen legend both read this
const SLOPE_CLASSES = [[27, '#ffe135'], [30, '#ff9419'], [35, '#e3261f'], [40, '#9a37d0'], [45, '#484a55']];
const glslColor = hex => 'vec3(' + [1, 3, 5].map(i => (Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2)).toFixed(4)).join(', ') + ')';
const terrainVS = `
uniform float exag, morph; attribute float fromY; // a tile coming in slides from the relief drawn before (terrain.js)
varying vec2 vUv; varying vec3 vN, vW; varying float vAlt;
void main(){
  vec3 p = position; p.y = mix(fromY, p.y, morph); vAlt = p.y; p.y *= exag;
  vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz; vUv = uv;
  vN = normalize(vec3(normal.x * exag, normal.y, normal.z * exag));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
// Light and air shared by everything standing on the ground (terrain, trees, buildings…), so they all get the
// same cast shadows and the same aerial perspective. Colours in U are display values; lighting is linear.
const SCENE_GLSL = `
uniform float exag, light, fogDensity, haze, shOn;
uniform vec3 sunDir, sunCol, skyCol, horizonCol, glowCol;
uniform sampler2D shF, shC, aoF, aoC, glF, glC; uniform vec4 srF, srC; uniform float aoOn;
// a light map of the relief at a point: fine map near the view centre, fading into the coarse one at its edges;
// beyond both, the value given for "outside"
float reliefMap(sampler2D f, sampler2D c, vec3 w, float outside){
  vec2 uf = vec2((w.x - srF.x) / srF.z, (srF.y - w.z) / srF.z), uc = vec2((w.x - srC.x) / srC.z, (srC.y - w.z) / srC.z);
  float vc = (uc.x > 0.0 && uc.y > 0.0 && uc.x < 1.0 && uc.y < 1.0) ? texture2D(c, uc).r : outside;
  float edge = min(min(uf.x, uf.y), min(1.0 - uf.x, 1.0 - uf.y));
  return mix(vc, texture2D(f, clamp(uf, 0.0, 1.0)).r, smoothstep(0.0, 0.06, edge));
}
precision highp sampler3D;
uniform sampler3D clNoise; uniform float clOn, clAlt, clCover, clTime; uniform vec2 clWind;
// share of the sun reaching a point: cast shadows of the relief, and of the clouds (where the sun's ray crosses
// the densest cloud layer, the same noise as the clouds drawn, moving with them)
float sunShadow(vec3 w){
  float s = reliefMap(shF, shC, w, 1.0);
  if (clOn > 0.5 && sunDir.y > 0.03 && w.y < clAlt * exag) {
    vec3 p = w + sunDir * ((clAlt * exag - w.y) / sunDir.y);
    float n = texture(clNoise, vec3(p.x + clWind.x * clTime, clAlt, p.z + clWind.y * clTime) / vec3(7000.0, 2600.0, 7000.0)).r;
    s *= 1.0 - 0.8 * smoothstep(1.0 - clCover - 0.08, 1.0 - clCover + 0.28, n);
  }
  return s;
}
// share of the sky seen from a point (1 on open ground, less in gullies, at the foot of cliffs, in deep valleys)
float skyVis(vec3 w){ return aoOn > 0.5 ? reliefMap(aoF, aoC, w, 1.0) : 1.0; }
// inside a glacier outline (0–1, soft at the edges)
float glacierAt(vec3 w){ return aoOn > 0.5 ? reliefMap(glF, glC, w, 0.0) : 0.0; }
// Leaves through the year at an altitude, for larch (larch = 1) or broadleaf trees (larch = 0): x = autumn colour
// (0–1), y = bare (0–1). Autumn comes earlier higher up (~2.5 days per 100 m), spring later (~3 days per 100 m);
// dates as usually seen in the northern Alps (larch gold in mid-October around 1 800 m).
uniform float doy;
vec2 leafState(float alt, float larch){
  float onset = larch > 0.5 ? 286.0 - (alt - 1300.0) * 0.025 : 290.0 - (alt - 900.0) * 0.03;
  float t = doy - onset;
  float fall = smoothstep(larch > 0.5 ? 20.0 : 15.0, larch > 0.5 ? 36.0 : 28.0, t);
  float spring = (larch > 0.5 ? 135.0 : 118.0) + (alt - 1000.0) * 0.03;
  if (doy > 200.0) return vec2(smoothstep(-8.0, 6.0, t) * (1.0 - fall), fall);
  return vec2(0.0, 1.0 - smoothstep(spring - 6.0, spring + 12.0, doy));
}
// colour of the leaves at a place: autumn yellows, oranges and reds for broadleaf trees (varied per place), gold
// for larch, bare grey-brown twigs in winter; scaled to the brightness the photo shows there, which keeps its detail
vec3 seasonColour(vec3 green, float lum, float broad, float larch, vec3 w){
  float alt = w.y / exag;
  vec2 L = leafState(alt, 1.0), B = leafState(alt, 0.0);
  // smooth variation from stand to stand (blocks of a hashed grid looked like camouflage)
  float n = 0.5 + 0.25 * sin(w.x / 41.0 + 1.7 * sin(w.z / 29.0)) + 0.25 * sin(w.z / 37.0 + 1.3 * sin(w.x / 23.0));
  // muted, as seen through the air: ochre, rust and a few reds, never the saturated colours of a close leaf
  vec3 au = mix(mix(vec3(0.2, 0.15, 0.045), vec3(0.2, 0.1, 0.035), smoothstep(0.35, 0.75, n)), vec3(0.15, 0.055, 0.03), smoothstep(0.82, 0.97, n));
  float k = clamp(lum / 0.06, 0.6, 1.5);              // a dark green photo pixel gives a darker autumn colour
  vec3 bare = vec3(0.07, 0.06, 0.05) * k;
  vec3 c = green;
  // a stand never turns all at once: part of the crowns keeps some green
  float part = 0.6 + 0.4 * (0.5 + 0.5 * sin(w.x / 17.0 + w.z / 13.0 + 6.0 * n));
  vec3 larchC = mix(mix(green, vec3(0.21, 0.15, 0.04) * k, L.x * part), bare, L.y);
  vec3 broadC = mix(mix(green, au * k, B.x * part), bare, B.y);
  c = mix(c, larchC, larch);
  c = mix(c, broadC, broad);
  return c;
}
// aerial perspective: the air thins with altitude (haze scale height 2.5 km), so valleys are hazier than
// summits; blue light is scattered more, so distant relief turns blue-grey (horizon and glow colours come
// from the same scattering model as the sky). col is linear; returns linear.
vec3 aerial(vec3 col, vec3 w){
  float d = length(cameraPosition - w);
  float hc = cameraPosition.y / exag, hf = w.y / exag, dh = (hf - hc) / 2500.0;
  float dens = abs(dh) > 1e-3 ? (exp(-hc / 2500.0) - exp(-hf / 2500.0)) / dh : exp(-hc / 2500.0);
  vec3 T = exp(-d * dens * (fogDensity * 2.7 + haze * 0.00005) * vec3(0.62, 0.8, 1.0));
  vec3 fogC = mix(horizonCol, glowCol, pow(max(dot(normalize(w - cameraPosition), sunDir), 0.0), 6.0) * 0.7);
  return mix(pow(fogC, vec3(2.2)), col, max(T, vec3(0.07)));
}`;
const terrainFS = `
uniform sampler2D map, slopeMap, ndsiMap, cloudMap, visMap, forestMap, clpaMap, radarMap, noiseTex; uniform vec4 ovRect, clpaRect, radarRect;
uniform float historic, hasNdsi, hasCloud, hasVis, hasForest, hasClpa, hasRadar, tileSize, snowToday, visToday, slopes, vivid, time;
uniform float beraOn, beraAlt, beraMask; uniform vec3 beraColLo, beraColHi;
${SCENE_GLSL}
varying vec2 vUv; varying vec3 vN, vW; varying float vAlt;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
// integer hash for whole-number cells (the one above repeats in rows on integers)
float hashCell(vec2 p){ uvec2 q = uvec2(ivec2(p) + 1048576); uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u); h = (h ^ (h >> 16)) * 2246822519u; h ^= h >> 13; return float(h) * (1.0 / 4294967295.0); }
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
// Broken rock, for steep faces: Worley cells on a plane, each one a flat facet with its own tilt and shade, and
// a thin dark crack along cell borders. Returns (tilt x, tilt y, shade −1…1, crack 0…1). Integer hash: no rows.
vec4 facet(vec2 p){
  vec2 i = floor(p), f = fract(p), id = i; float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y), c = i + g, r = g + vec2(hashCell(c), hashCell(c + 7919.0)) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = c; } else if (d < d2) d2 = d;
  }
  float edge = sqrt(d2) - sqrt(d1);
  return vec4(hashCell(id + 104729.0) - 0.5, hashCell(id + 130363.0) - 0.5, hashCell(id + 92821.0)*2.0 - 1.0, 1.0 - smoothstep(0.0, 0.035, edge));
}
void main(){
  // On steep faces the vertical photo is stretched by 1/cos(slope) along the fall line; anisotropic filtering kept
  // it sharp across the slope, which drew vertical streaks. There the footprint is made round at its long axis:
  // the colour stays, the streaks go; the broken rock below brings the detail back.
  float stretch = 1.0 / max(normalize(vN).y, 0.12), rnd = smoothstep(1.4, 2.6, stretch);
  vec2 tdx = dFdx(vUv), tdy = dFdy(vUv); float tL = max(length(tdx), length(tdy));
  vec2 rdx = mix(tdx, tdx / max(length(tdx), 1e-9) * tL, rnd), rdy = mix(tdy, tdy / max(length(tdy), 1e-9) * tL, rnd);
  vec3 photo = pow(textureGrad(map, vUv, rdx, rdy).rgb, vec3(2.2));
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
  // the season in the forests (IGN BD Forêt): where the photo shows trees (green), broadleaf and larch take the
  // colours of the date shown (the photos were flown in summer)
  if (hasForest > 0.5 && historic < 0.5) {
    vec4 fm = cubic(forestMap, ou);
    float green = smoothstep(0.0, 0.025, photo.g - max(photo.r, photo.b)) * smoothstep(0.004, 0.02, plum) * (1.0 - smoothstep(0.25, 0.4, plum));
    if (fm.a > 0.05 && green > 0.0) alb = mix(alb, seasonColour(alb, plum, fm.r, fm.g, vW), green * fm.a);
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
  // the grain stands in for detail the photo lacks at a distance; within ~100 m the 20 cm photo and 0.4 m relief
  // are there, and the grain would only look like melted plastic (seen in the viewfinder, at eye height)
  float dEyeR = length(cameraPosition - vW), grainK = steep * smoothstep(25.0, 140.0, dEyeR);
  alb *= 1.0 + ((g1 - 0.49)*1.2 + (g2 - 0.49)*0.5) * 0.45 * grainK;
  // the same grain as a small relief (up to ~1.5 m) that the light catches: surface-gradient bump mapping
  // from screen-space derivatives, no extra geometry
  float bump = ((g1 - 0.49)*3.0 + (g2 - 0.49)*0.9) * grainK; // metres: large facets, a little finer roughness
  vec3 dpx = dFdx(vW), dpy = dFdy(vW), r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 nb = abs(det)*n - sign(det)*(dFdx(bump)*r1 + dFdy(bump)*r2);
  vec3 nl = dot(nb, nb) > 1e-20 ? normalize(nb) : n; // lit normal
  // close up, broken rock instead of the smooth grain (which looked like melted plastic there): facets of ~6 m and
  // ~1.6 m on the three axes, each fading out before its cells get smaller than a few pixels (no shimmer)
  float foot = length(fwidth(q)); // metres per pixel
  // rock only: snow and ice on a steep face (bright, colourless on the photo) stay smooth
  float rockOnly = 1.0 - smoothstep(0.3, 0.55, dot(low, LUM));
  float kBig = steep * rockOnly * (1.0 - smoothstep(0.8, 2.0, foot)), kSmall = steep * rockOnly * (1.0 - smoothstep(0.2, 0.5, foot));
  if (kBig > 0.01) {
    vec4 bx = facet(q.zy / 6.0), by = facet(q.xz / 6.0), bz = facet(q.xy / 6.0);
    vec4 sx = facet(q.zy / 1.6 + 31.7), sy = facet(q.xz / 1.6 + 31.7), sz = facet(q.xy / 1.6 + 31.7);
    // tilts in each plane, back to 3D (plane zy: z and y; xz: x and z; xy: x and y)
    vec3 tilt = (vec3(0.0, bx.y, bx.x)*tw.x + vec3(by.x, 0.0, by.y)*tw.y + vec3(bz.x, bz.y, 0.0)*tw.z) * 0.9 * kBig
              + (vec3(0.0, sx.y, sx.x)*tw.x + vec3(sy.x, 0.0, sy.y)*tw.y + vec3(sz.x, sz.y, 0.0)*tw.z) * 0.45 * kSmall;
    nl = normalize(nl + tilt - n * dot(tilt, n));
    float shade = (bx.z*tw.x + by.z*tw.y + bz.z*tw.z) * 0.10 * kBig + (sx.z*tw.x + sy.z*tw.y + sz.z*tw.z) * 0.06 * kSmall;
    float crack = (bx.w*tw.x + by.w*tw.y + bz.w*tw.z) * kBig * 0.22 + (sx.w*tw.x + sy.w*tw.y + sz.w*tw.z) * kSmall * 0.12;
    alb *= (1.0 + shade) * (1.0 - crack);
  }
  // today's snow: continuous snow index, refined at metre scale with the LiDAR slope and the photo
  float todaySnow = 0.0;
  if (snowToday > 0.5 && hasNdsi > 0.5 && historic < 0.5) {
    vec4 nd = cubic(ndsiMap, ou);
    float valid = smoothstep(0.6, 0.95, nd.g) * (1.0 - cloud); // (R: snow index, G: data there)
    float fsc = clamp(1.45*(nd.r*2.0 - 1.0) - 0.01, 0.0, 1.0);
    float nz = vnoise(vW.xz/2.3)*0.5 + vnoise(vW.xz/8.0)*0.35 + vnoise(vW.xz/0.7)*0.15;
    float s = fsc + (nz - 0.5)*0.4 - smoothstep(0.42, 0.8, slope)*0.85 + smoothstep(0.3, 0.7, plum)*0.12;
    float cover = smoothstep(0.4, 0.6, s) * valid; todaySnow = cover;
    // the aerial photo may be years old and show snow that is not there today: where the clear satellite pass
    // sees no snow, the photo's white (bright and colourless) becomes the ground as that pass sees it
    // decided on the photo blurred to the satellite's 10 m (decided pixel by pixel it followed the sheen of the
    // snow and gave a marbled, liquid look); snow on the photo is near white (linear luminance ≈ 0.8), the pale
    // limestone of the Buet (≈ 0.45) is not
    float chroma = max(max(low.r, low.g), low.b) - min(min(low.r, low.g), low.b);
    float photoSnow = smoothstep(0.5, 0.72, llum) * (1.0 - smoothstep(0.05, 0.14, chroma));
    float gone = valid * (1.0 - smoothstep(0.08, 0.3, fsc)) * (1.0 - cover);
    vec4 vis = hasVis > 0.5 ? cubic(visMap, ou) : vec4(0.0);
    // the satellite's true colours are warmer than the aerial photo's: keep their brightness, little of their hue
    vec3 s2 = pow(vis.rgb, vec3(2.2)); s2 = mix(vec3(dot(s2, LUM)), s2, 0.3) * 1.2;
    vec3 bare = mix(vec3(0.19, 0.18, 0.16), s2, smoothstep(0.6, 0.95, vis.a));
    bare *= 0.9 + 0.2 * vnoise(vW.xz / 13.0); // gentle variation only: finer noise looked liquid up close
    alb = mix(alb, bare, photoSnow * gone);
    float detail = clamp(plum / max(llum, 0.02), 0.6, 1.4);
    vec3 snowC = vec3(0.86, 0.9, 0.97) * mix(1.0, detail, 0.35);
    alb = mix(alb, snowC, cover * (1.0 - smoothstep(0.5, 0.8, plum)));
  }
  // glaciers (BD TOPO outlines), where neither the photo nor today's satellite shows snow: the grey of the photo
  // becomes ice, blue-grey, and what is darker than its surroundings (crevasses, séracs) a deep blue. Rubble on
  // the ice (brownish: red above blue) is left as it is.
  float iceK = 0.0;
  float gl = historic > 0.5 ? 0.0 : glacierAt(vW); // today's outlines: not on an old photo
  if (gl > 0.01) {
    float iceLike = smoothstep(0.08, 0.22, plum) * (1.0 - smoothstep(0.55, 0.8, plum)) * (1.0 - smoothstep(0.01, 0.06, photo.r - photo.b));
    iceK = gl * iceLike * (1.0 - todaySnow);
    float crevasse = (1.0 - smoothstep(0.45, 0.8, plum / max(llum, 0.03))) * smoothstep(0.2, 0.4, llum);
    vec3 ice = alb * vec3(0.8, 0.96, 1.14);
    alb = mix(alb, mix(ice, vec3(0.025, 0.11, 0.19), crevasse * 0.75), iceK);
  }
  float lum = dot(alb, LUM);
  alb = max(mix(vec3(lum), alb, 1.0 + vivid), 0.0) * (1.0 + vivid*0.15);
  // avalanches of the past (CLPA): the map's own colours laid on the ground, lit with it
  if (hasClpa > 0.5) { vec4 cp = texture2D(clpaMap, clpaRect.xy + vUv * clpaRect.zw); alb = mix(alb, pow(cp.rgb, vec3(2.2)) * 0.8, cp.a * 0.7); }
  vec3 col;
  if (light < 0.5) {
    // photo mode: the photo carries its own shading, except on steep faces where it is smeared; there the relief
    // is lit from where the sun stood during the IGN flights (south-south-east, late morning)
    const vec3 PL = vec3(0.196, 0.819, 0.539);
    col = alb * mix(0.88 + 0.14*n.y, 0.45 + 0.75*max(dot(nl, PL), 0.0), steep);
    // the photo already holds its own shading: the hollows are only deepened a little
    col *= mix(1.0, skyVis(vW), 0.45);
  }
  else {
    float sh = shOn > 0.5 ? sunShadow(vW) : 1.0; // cast by the surrounding relief
    float ndl = max(dot(nl, sunDir), 0.0) * sh, sv = skyVis(vW);
    vec3 a = alb / (0.55 + 0.9*lum) * 0.95;
    // sky light only from the part of the sky the place sees; the sun a little dimmer in deep hollows too
    // (light bounced off the walls there is not modelled, and a full sun made gullies look flat)
    col = a * (sunCol*ndl*mix(1.0, sv, 0.25) + skyCol*0.5*(0.6 + 0.4*n.y)*sv);
    vec3 V = normalize(cameraPosition - vW), H = normalize(sunDir + V);
    col += sunCol * pow(max(dot(nl, H), 0.0), 60.0) * smoothstep(0.5, 0.8, lum) * 0.35 * sh;
    col += sunCol * pow(max(dot(nl, H), 0.0), 30.0) * 0.25 * iceK * sh; // wet sheen of bare ice
    // snow in the sun glitters: a few 40 cm cells catch the sun at this angle (they change as the eye moves),
    // only near the eye, where they are at least a pixel; the final pass gives them a small glow
    float dEye = length(cameraPosition - vW);
    if (dEye < 400.0 && lum > 0.55) {
      float h = hashCell(floor(vW.xz * 2.5) + floor(V.xz * 6.0) * 7919.0);
      col += sunCol * step(0.996, h) * pow(max(dot(nl, H), 0.0), 6.0) * (1.0 - smoothstep(120.0, 400.0, dEye)) * sh * 2.5;
    }
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
  // rain and snow seen by the radars, over the lit ground (readable as a map, not shaded); B-spline filtered: a
  // 1.2 km radar pixel becomes a smooth patch
  if (hasRadar > 0.5) {
    vec4 rd = cubic(radarMap, radarRect.xy + vUv * radarRect.zw);
    if (rd.a > 0.01) col = mix(col, pow(rd.rgb / rd.a, vec3(2.2)), smoothstep(0.0, 0.6, rd.a) * 0.7);
  }
  // the avalanche bulletin laid on the relief: slopes of 30° and more that face the directions it names as the
  // most exposed, in the colour of its risk at their altitude (its limit blended over 50 m). Ground slope, never
  // the exaggerated one; aspect = the direction the slope faces, sectors of 45° centred on N, NE…
  if (beraOn > 0.5) {
    vec2 g = texture2D(slopeMap, (vUv*${GRID}.0 + 0.5) / ${GRID + 1}.0).rg;
    float deg = degrees(atan(length(g))), aa = max(fwidth(deg), 0.02) * 0.7;
    float asp = mod(degrees(atan(-g.x, g.y)) + 360.0, 360.0);
    int sector = int(floor(mod(asp + 22.5, 360.0) / 45.0)) % 8;
    float facing = float((int(beraMask + 0.5) >> sector) & 1);
    float k = smoothstep(30.0 - aa, 30.0 + aa, deg) * facing;
    vec3 rc = mix(beraColLo, beraColHi, smoothstep(beraAlt - 25.0, beraAlt + 25.0, vAlt));
    col = mix(col, rc * (0.6 + 0.5*sqrt(dot(col, LUM))), k * 0.75);
  }
  col = aerial(col, vW);
  gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0/2.2)), 1.0);
}`;

const BOUNDS = SITE.bounds; // lon/lat of the streamed area
const engine = new TerrainEngine({ renderer, scene, uniforms: U, vertexShader: terrainVS, fragmentShader: terrainFS, bounds: BOUNDS });
const glaciers = new Glaciers();
const shadows = new TerrainShadows(renderer, engine, U, { glaciers });
const forest = new Forest({ scene, engine, uniforms: U, sceneGLSL: SCENE_GLSL });

// ---------- sky: physical scattering baked into a panorama (atmosphere.js), grey veil when overcast ----------
const skyBaker = new SkyBaker(THREE, renderer);
const skyU = { sunDir: U.sunDir, sunCol: U.sunCol, time: U.time, stars: { value: 0 }, skyTex: { value: skyBaker.texture }, overcast: { value: 0 }, ovGrey: { value: new THREE.Vector3(0.6, 0.6, 0.62) } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(200000, 48, 24), new THREE.ShaderMaterial({
  uniforms: skyU, side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 sunDir, sunCol, ovGrey; uniform float overcast; uniform sampler2D skyTex; varying vec3 vD;
    ${SKY_LOOKUP_GLSL}
    void main(){ vec3 d = normalize(vD);
      vec3 c = texture2D(skyTex, skyUv(d)).rgb;
      c = max(c, vec3(0.010, 0.014, 0.032));                                  // night: a deep blue, never pure black
      // (the stars are the real ones, drawn over this sky: sky.js)
      float sg = dot(d, sunDir);                                              // the sun's disk, 0.53° across, tinted by the air
      // the sun's disk is written brighter than white: the final pass makes it glow (clipped to white without it)
      vec3 disk = min(sunCol, vec3(1.0)) * 3.0 * smoothstep(0.99994, 0.99998, sg) * step(-0.01, sunDir.y) * (1.0 - overcast);
      c = mix(c, ovGrey * (0.85 + 0.15 * clamp(d.y * 3.0, 0.0, 1.0)), overcast);
      gl_FragColor = vec4(min(c, 1.0) + disk, 1.0); }`
}));
sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);
// the real stars, Milky Way, planets, and the course of the Sun and Moon (sky.js)
const nightSky = new NightSky({ scene, labels: $('labels') });
const lakes = new Lakes({ scene, engine, uniforms: U, sceneGLSL: SCENE_GLSL, skyGLSL: SKY_LOOKUP_GLSL, skyTex: skyBaker.texture });
const buildings = new Buildings({ scene, uniforms: U, sceneGLSL: SCENE_GLSL });
const lidar = new PointCloud({ scene, uniforms: U, sceneGLSL: SCENE_GLSL, renderer });
const weather3d = new Weather3D({ scene, uniforms: U });
const photos = new Photos360({ scene, groundAt: (x, z) => engine.heightAt(x, z) });
// a Panoramax photo: preview in the point sheet, with its author, date and licence (required by CC BY-SA)
function showPhoto(p) {
  showPointSheet(); pin = { x: p.x, z: p.z, h: p.h ?? 0 };
  $('ptTitle').textContent = p.pano ? 'Photo 360°' : 'Photo';
  const lic = /by-sa/i.test(p.license) ? 'CC BY-SA 4.0' : /by/i.test(p.license) ? 'CC BY' : p.license || 'licence non indiquée';
  $('ptOut').innerHTML = `${p.sd || p.thumb ? `<img class="photo" src="${esc(p.sd || p.thumb)}" alt="Photo prise ici${p.date ? ' le ' + dayName(p.date) : ''}" loading="lazy">` : ''}
    <p class="cmeta">${p.date ? p.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'date inconnue'} · © ${esc(p.author || 'contributeur Panoramax')} · ${esc(lic)}</p>
    <p class="cline"><a href="https://api.panoramax.xyz/#focus=pic&pic=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${p.pano ? 'Voir la photo à 360° et se promener' : 'Voir la photo'} sur Panoramax</a></p>`;
}
const trails = new TrailsLayer({ scene, groundAt: (x, z) => engine.heightAt(x, z), onHuts: huts => addHuts(huts) });
// torrents (flowing) and named waterfalls (labels), IGN BD TOPO
const fallIds = new Set();
const streams = new Streams({ scene, groundAt: (x, z) => engine.heightAt(x, z), onFalls: falls => {
  for (const f of falls) {
    if (fallIds.has(f.id)) continue; fallIds.add(f.id);
    const [x, z] = lonLatToWorld(f.lon, f.lat), g = engine.heightAt(x, z);
    const p = { name: f.name, x, z, h: g ?? 1500, small: true, hut: true, fall: true };
    const el = document.createElement('button'); el.type = 'button'; el.className = 'label small hut water hidden';
    el.innerHTML = `<span class="t"><span class="n">≋ ${esc(f.name)}</span></span>`;
    el.addEventListener('click', () => openPlace(p));
    labelsEl.appendChild(el); p.el = el; PLACES.push(p);
  }
} });
// ski pistes (OpenStreetMap, daily copy): off by default, a winter layer
const pistes = new Pistes({ scene, groundAt: (x, z) => engine.heightAt(x, z) });
pistes.load(SITE).then(d => {
  $('pisteInfo').textContent = d ? `${fmt(d.pistes.length)} tracés · copie OpenStreetMap du ${new Date(d.fetched + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}. ` + PISTE_LEGEND.map(([, n]) => n).join(' · ') : "Pas encore de copie des pistes pour ce massif (les serveurs OpenStreetMap n'ont pas répondu).";
});
const nightLights = new NightLights({ scene, groundAt: (x, z) => engine.heightAt(x, z), renderer });
const hutSpots = []; // every hut seen, for the night lights

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
// clouds in volume from "Haute" up (they need the final image pass); the flat layers below remain for "Standard"
const vclouds = new VolumeClouds(renderer, U); post.clouds = vclouds;
// the model's cloud profile for the hour shown (the time slider shows the forecast clouds of that hour)
function updateCloudProfile() {
  const W = state.weather, d = lightingNow(), p2 = n => String(n).padStart(2, '0');
  const hour = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}`;
  const prof = state.clouds && !state.far && W ? cloudProfile(W.extra, hour) : null;
  vclouds.setProfile(prof);
  showCloudLayers();
  // say where the clouds drawn come from (the model's layers for the hour shown)
  if (state.cloudNote != null) {
    const layers = vclouds.active && prof ? prof.filter(l => l.cover >= 0.2).map(l => `${fmt(l.alt)} m : ${Math.round(l.cover * 100)} %`) : [];
    $('cloudNote').textContent = (vclouds.active ? state.cloudInside : state.cloudNote) + (vclouds.active ? (layers.length ? `Nuages en 3D placés selon le modèle à ${String(d.getHours()).padStart(2, '0')} h (${layers.join(' · ')}).` : 'Le modèle ne prévoit pas de couche nuageuse notable à cette heure.') : '');
  }
}
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
  el.addEventListener('click', () => openPlace(p));
  labelsEl.appendChild(el); p.el = el;
  const li = document.createElement('button'); li.type = 'button'; li.className = 'place';
  li.innerHTML = `<span>${esc(p.name)}</span><span class="pa">${p.alt ? fmt(p.alt) + ' m' : 'glacier'}</span>`;
  li.addEventListener('click', () => { flyToPlace(p); closeIfCovering(); });
  $('placeList').appendChild(li);
});
// mountain huts from IGN BD TOPO (trails.js): small labels, unless the site already names that hut
const hutIds = new Set();
function addHuts(huts) {
  for (const hut of huts) {
    if (hutIds.has(hut.id)) continue; hutIds.add(hut.id);
    const [x, z] = lonLatToWorld(hut.lon, hut.lat);
    hutSpots.push({ x, z }); nightLights.setHuts(hutSpots);
    if (PLACES.some(p => Math.hypot(p.x - x, p.z - z) < 200)) continue;
    const p = { name: hut.name, alt: hut.alt, x, z, h: hut.alt ?? 2000, small: true, hut: true, url: hut.url };
    const el = document.createElement('button'); el.type = 'button'; el.className = 'label small hut hidden';
    el.innerHTML = `<span class="t"><span class="n">⌂ ${esc(hut.name)}</span>${hut.alt ? `<span class="h">${fmt(hut.alt)} m</span>` : ''}</span>`;
    el.addEventListener('click', () => openPlace(p));
    labelsEl.appendChild(el); p.el = el; PLACES.push(p);
  }
}
// a label touched: fly there, and show what refuges.info knows about it; while drawing an itinerary or
// choosing a point, the place named is the point chosen
function openPlace(p) {
  const at = () => ({ x: p.x, z: p.z, h: groundAt(p.x, p.z) ?? p.h, name: p.name });
  if (draw.on) { drawStep(p.x, p.z); return; }
  if (pickMode) { picked(at()); return; }
  if (p.cam) { window.open(p.cam, '_blank', 'noopener'); return; } // a webcam: its own page
  if (p.nivo) { openSheet('cond', true); $('nivo').scrollIntoView({ block: 'start' }); return; } // a snow station: the measures
  flyToPlace(p); if (p.rinfo) showRefuge(p.rinfo);
}
// refuges.info: their sheet joins the label of the same hut (within 200 m), or gets its own label; water points
// and tricky passages get small labels of their own
const refuges = new Refuges(pts => {
  for (const r of pts) {
    const near = PLACES.find(p => (p.hut || p.small) && Math.hypot(p.x - r.x, p.z - r.z) < 200);
    if (near && (r.kind === 'refuge' || r.kind === 'gîte' || r.kind === 'cabane')) { near.rinfo = r; if (!near.alt && r.alt) { near.alt = r.alt; near.h = r.alt; } continue; }
    const p = { name: r.name, alt: r.alt, x: r.x, z: r.z, h: r.alt ?? 2000, small: true, hut: true, rinfo: r };
    const el = document.createElement('button'); el.type = 'button'; el.className = `label small hut ${r.kind === 'eau' ? 'water' : r.kind === 'passage' ? 'warn' : ''} hidden`;
    const mark = r.kind === 'eau' ? '◆ Eau ·' : r.kind === 'passage' ? '⚠' : '⌂';
    el.innerHTML = `<span class="t"><span class="n">${mark} ${esc(r.name)}</span>${r.alt ? `<span class="h">${fmt(r.alt)} m</span>` : ''}</span>`;
    el.addEventListener('click', () => openPlace(p));
    labelsEl.appendChild(el); p.el = el; PLACES.push(p);
  }
});
// links in hikers' text: phone numbers to call, e-mail addresses, web sites (escaped first)
const linkify = s => esc(s).replace(/\n/g, '<br>')
  .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
  .replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, '<a href="mailto:$1">$1</a>')
  .replace(/(\+?\d[\d .]{8,}\d)/g, m => `<a href="tel:${m.replace(/[ .]/g, '')}">${m}</a>`);
function showRefuge(r) {
  showPointSheet(); pin = { x: r.x, z: r.z, h: r.alt ?? groundAt(r.x, r.z) ?? 0 };
  $('ptTitle').textContent = r.name;
  const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
  $('ptOut').innerHTML = `<p class="cmeta">${esc(r.type)}${r.alt ? ` · ${fmt(r.alt)} m` : ''}${r.places ? ` · ${r.places} places` : ''}${r.updated ? ` · fiche mise à jour le ${new Date(r.updated).toLocaleDateString('fr-FR')}` : ''}</p>
    ${r.comp.length ? `<p class="cline">${r.comp.map(esc).join(' · ')}</p>` : ''}
    ${r.access ? `<h3>Accès</h3><p class="cline">${linkify(cut(r.access, 600))}</p>` : ''}
    ${r.owner ? `<h3>${esc(r.ownerLabel || 'Contact')}</h3><p class="cline">${linkify(cut(r.owner, 500))}</p>` : ''}
    ${r.remark ? `<h3>Remarques</h3><p class="cline">${linkify(cut(r.remark, 900))}</p>` : ''}
    <p class="cline small"><a href="${esc(r.link)}" target="_blank" rel="noopener">Fiche complète et commentaires sur refuges.info</a></p>
    <p class="cnote">© contributeurs de refuges.info, licence CC BY-SA 2.0. Informations données par des randonneurs : gardiennage, places et état changent ; appelle le refuge avant de compter dessus.</p>`;
}

// ---------- site: header, links, switcher ----------
document.title = `${SITE.name} 3D`;
$('siteRegion').textContent = SITE.region; $('siteName').textContent = SITE.name; $('siteAlt').textContent = `${fmt(SITE.alt)} m`;
$('loaderTitle').textContent = SITE.name; $('home').setAttribute('aria-label', `Revenir à ${SITE.name}`);
$('links').innerHTML = SITE.links.map(([u, t]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join('');
$('sites').innerHTML = SITE_LIST.map(x => `<a class="site${x.id === SITE.id ? ' on' : ''}" href="?site=${x.id}"${x.id === SITE.id ? ' aria-current="page"' : ''}><b>${esc(x.name)}</b><span>${esc(x.region)} · ${fmt(x.alt)} m</span></a>${x.custom && x.id !== SITE.id ? `<button type="button" class="mini rmsite" data-rm="${x.id}">Retirer ${esc(x.name)}</button>` : ''}`).join('');
$('sites').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (!b) return; removeSite(b.dataset.rm); b.previousElementSibling?.remove(); b.remove(); });
// a massif made around the point looked at (custom.js): named after the last place searched there, or the nearest summit
let lastSearch = null;
$('makeSite').addEventListener('click', async () => {
  const T = controls.target, [lon, lat] = worldToLonLat(T.x, T.z);
  const name = lastSearch && Math.hypot((lastSearch.lon - lon) * Math.cos(lat * Math.PI / 180), lastSearch.lat - lat) < 0.02 ? lastSearch.name : null;
  $('makeSite').disabled = true;
  try {
    const s = await makeSite(lon, lat, name, beraKey.get(), t => { $('makeNote').textContent = t; });
    $('makeNote').textContent = `Massif « ${s.name} » prêt (${fmt(s.alt)} m, météo à ${fmt(s.spots.valley.alt)} / ${fmt(s.spots.mid.alt)} / ${fmt(s.alt)} / ${fmt(s.spots.peak2.alt)} m${s.bra ? `, bulletin d'avalanche n° ${s.bra}` : ', pas de bulletin trouvé (clé Météo-France absente ou hors massif)'}). Ouverture…`;
    setTimeout(() => { location.href = `?site=${s.id}`; }, 1200);
  } catch (e) { $('makeNote').textContent = `Impossible de faire un massif ici : ${e.message}.`; }
  $('makeSite').disabled = false;
});

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

// ---------- place search: fly anywhere, a pin marks the place ----------
function flyToLonLat(lon, lat) {
  const [x, z] = lonLatToWorld(lon, lat);
  engine.ensureRoots(x, z, 45000); // start loading the ground there right away
  const h = groundAt(x, z) ?? controls.target.y / state.exag, t = new THREE.Vector3(x, h * state.exag, z);
  let dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.25 || dir.y > 0.8) { dir.y = 0.45; dir.normalize(); }
  startFly(t, t.clone().addScaledVector(dir, 3000), 2600);
  pin = { x, z, h, search: true };
}
$('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim(); if (q.length < 2) return;
  $('q').blur(); $('results').innerHTML = ''; $('searchNote').textContent = 'Recherche…';
  try {
    const [lon, lat] = worldToLonLat(controls.target.x, controls.target.z);
    const list = await searchPlaces(q, { lat, lon });
    $('searchNote').textContent = list.length ? 'Sources : IGN Géoplateforme, © contributeurs OpenStreetMap (Nominatim).' : `Aucun lieu trouvé pour « ${q} ».`;
    list.forEach(p => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'place';
      const dist = p.km < 10 ? `${t1(p.km)} km` : `${fmt(p.km)} km`;
      b.innerHTML = `<span>${esc(p.name)}</span><span class="pa">${esc(p.detail || p.src)} · à ${dist}</span>`;
      b.addEventListener('click', () => { lastSearch = p; flyToLonLat(p.lon, p.lat); closeIfCovering(); });
      $('results').appendChild(b);
    });
  } catch (err) { $('searchNote').textContent = `Recherche impossible : ${why(err)}.`; }
});

// ---------- terrain queries ----------
const groundAt = (x, z) => engine.heightAt(x, z);
const google = new GoogleMap3D($('gmap'));
// cam: the camera to cast from (the controls measure gestures in the view they are heading to)
function pick(ndcX, ndcY, cam = camera) {
  const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
  const o = r.ray.origin, d = r.ray.direction, gapAt = t => { const g = groundAt(o.x + d.x * t, o.z + d.z * t); return g == null ? null : o.y + d.y * t - g * state.exag; };
  let t = 0, prev = 0;
  for (let i = 0; i < 1500 && t < 80000; i++) {
    const gap = gapAt(t);
    if (gap == null) { prev = t; t += 50; continue; }
    if (gap < 0.5) {
      // the step may have gone through a steep face: narrow down to where the ray actually meets the relief,
      // otherwise the point found lies tens of pixels away from the finger
      let a = prev, b = t;
      for (let k = 0; k < 24 && b - a > 0.05; k++) { const m = (a + b) / 2, gm = gapAt(m); if (gm != null && gm < 0.5) b = m; else a = m; }
      const x = o.x + d.x * b, z = o.z + d.z * b; return { x, z, h: groundAt(x, z) };
    }
    prev = t; t += Math.max(gap * 0.5, 0.5);
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
// a tap is one finger put down and lifted in place: a second finger (pinch, two-finger tap to zoom out) makes the
// whole gesture a map gesture, never a point chosen
const fingers = new Set();
renderer.domElement.addEventListener('pointerdown', e => { fingers.add(e.pointerId); downAt = fingers.size === 1 ? [e.clientX, e.clientY, performance.now(), e.pointerId] : null; });
// fingers lifted anywhere (even off the map) are forgotten, so that a later tap is seen as one
addEventListener('pointerup', e => fingers.delete(e.pointerId), true);
addEventListener('pointercancel', e => { fingers.delete(e.pointerId); downAt = null; }, true);
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || downAt[3] !== e.pointerId) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 8 && performance.now() - downAt[2] < 400) {
    const r = renderer.domElement.getBoundingClientRect();
    const photo = !draw.on && !pickMode && photos.pick(e.clientX - r.left, e.clientY - r.top, camera, r.width, r.height);
    if (photo) { showPhoto(photo); return; }
    const hit = pick((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    if (!hit) { if (draw.on || pickMode) toast('Touche le relief (pas le ciel).', true); return; }
    showPoint(hit);
    if (draw.on) { drawStep(hit.x, hit.z); return; } // drawing an itinerary: each touch is a step
    if (pickMode) { picked(hit); return; } // choosing a start, a destination, a point of view…
    pointReport(hit);
  }
});
// a gesture interrupts flights and the automatic turn (the controls put the look-at point on the ground themselves)
controls.addEventListener('start', () => { fly = null; flyRoute = null; controls.autoRotate = false; $('c-spin').checked = false; });

// ---------- sun, sky, weather-driven look ----------
let overcast = 0, skyAlt = 0;
// lighting time = now, moved by the hour slider and by the chosen day (whole days, so the hour stays the same)
state.dayOffset = 0;
function lightingNow() { return new Date(Date.now() + state.hourOffset * 3600e3 + state.dayOffset * 864e5); }
function updateSky() {
  const date = lightingNow(), { az, el } = sunPosition(date, ORIGIN.lat, ORIGIN.lon);
  const s = Math.sin(el);
  U.sunDir.value.set(Math.sin(az) * Math.cos(el), s, -Math.cos(az) * Math.cos(el)).normalize();
  const day = sstep(-0.1, 0.3, s), ov = overcast;
  const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  // physical sky seen from the camera's altitude (atmosphere.js); the panorama and these colours agree
  const alt = Math.max(camera.position.y / state.exag, 200); skyAlt = alt;
  skyBaker.bake(U.sunDir.value, alt);
  const A = skyColors(U.sunDir.value, alt), night = [0.02, 0.028, 0.06];
  let skyC = A.zenith.map((v, i) => Math.max(v, night[i])), hor = A.horizon.map((v, i) => Math.max(v, night[i] * 1.4)), glow = A.glow, sun = A.sun;
  // overcast: a grey veil whose brightness follows the daylight
  skyU.stars.value = 1 - sstep(-0.2, -0.06, s); // from nautical twilight on
  const g = 0.35 + 0.45 * day; skyU.overcast.value = ov; skyU.ovGrey.value.set(g * 0.97, g * 0.98, g);
  if (ov > 0) { skyC = mixv(skyC, [g * 0.9, g * 0.93, g], ov); hor = mixv(hor, [g, g, g * 1.02], ov); glow = mixv(glow, [g, g, g], ov); sun = sun.map(v => v * (1 - 0.7 * ov)); }
  U.skyCol.value.set(...skyC); U.horizonCol.value.set(...hor); U.glowCol.value.set(...glow); U.sunCol.value.set(...sun);
  // night: once the sun is well down, the Moon (real position and phase for the date shown) becomes the light:
  // it lights the relief, casts its shadows, lights the clouds, and its disk is drawn where the sun's would be
  const nightK = 1 - sstep(-0.12, -0.03, s); state.night = nightK;
  U.doy.value = (date - new Date(date.getFullYear(), 0, 0)) / 864e5; // the colours of the season follow the date shown
  U.night.value = state.light === 'sun' ? nightK : 0;
  const moon = moonPosition(date, ORIGIN.lat, ORIGIN.lon), mUp = sstep(-0.02, 0.06, Math.sin(moon.el));
  state.moon = moon;
  if (nightK > 0.5 && mUp > 0) {
    U.sunDir.value.set(Math.sin(moon.az) * Math.cos(moon.el), Math.sin(moon.el), -Math.cos(moon.az) * Math.cos(moon.el)).normalize();
    const k = (0.2 + 0.8 * moon.illum) * mUp * (nightK - 0.5) * 2 * (1 - 0.8 * ov);
    U.sunCol.value.set(0.17 * k, 0.21 * k, 0.34 * k);
    // moonlight brightens the night sky a little (bluish)
    U.skyCol.value.set(skyC[0] + 0.02 * k, skyC[1] + 0.03 * k, skyC[2] + 0.06 * k);
  }
  const hh = date.getHours(), mm = date.getMinutes();
  const live = state.hourOffset === 0 && state.dayOffset === 0;
  if (state.weather) updateCloudProfile();
  $('timeOut').textContent = (live ? 'maintenant, ' : state.dayOffset ? date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ', ' : '') + `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
$('sunDate').value = isoDay(new Date());
$('sunDate').addEventListener('change', e => {
  const [y, m, d] = e.target.value.split('-').map(Number); if (!y) return;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  state.dayOffset = Math.round((new Date(y, m - 1, d, 12) - today) / 864e5); updateSky();
});

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
  let fz = null, wa = null;
  const ex = W.extra?.hourly;
  if (ex) { // (model snow depth is not requested: unreliable in high mountains; the avalanche bulletin gives the real one)
    const now = W.top.current.time.slice(0, 13), k = ex.time.findIndex(t => t.slice(0, 13) === now);
    if (k >= 0) {
      fz = ex.freezing_level_height[k];
      if (ex.wind_speed_700hPa?.[k] != null) wa = { speed: ex.wind_speed_700hPa[k], dir: ex.wind_direction_700hPa[k], alt: ex.geopotential_height_700hPa?.[k] ?? 3000 };
    }
  }
  weather3d.setData({ freeze: fz, windSpeed: wa?.speed ?? null, windDir: wa?.dir, windAlt: wa?.alt });
  // the clouds drift with the wind aloft (m/s; the noise moves against its offset, hence the signs)
  if (wa) { const d = wa.dir * Math.PI / 180, v = wa.speed / 3.6; vclouds.setWind(Math.sin(d) * v, -Math.cos(d) * v); }
  const d = W.top.daily;
  const days = d.time.map((t, i) => `<tr><th>${dayName(new Date(t + 'T12:00'))}</th><td>${esc(WMO[d.weather_code[i]] || '—')}</td><td class="n">${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°</td><td class="n">${d.snowfall_sum[i] > 0 ? t1(d.snowfall_sum[i]) + ' cm' : '—'}</td><td class="n">${Math.round(d.wind_gusts_10m_max[i])}</td></tr>`).join('');
  const got = W.fetchedAt, today = got.toDateString() === new Date().toDateString();
  const gotText = `${today ? '' : dayName(got) + ' '}${got.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  el.innerHTML = `<p class="cmeta">Météo-France (AROME/ARPEGE) · reçu ${gotText}</p>
    ${W.stale ? `<p class="cline stale">Pas de mise à jour possible (${navigator.onLine ? esc(W.stale) : 'hors ligne'}) : voici la météo reçue ${today ? 'à' : 'le'} ${gotText}, conditions « maintenant » de ce moment-là (${ago(got)}).</p>` : ''}
    <div class="spots">${spots}</div>
    <p class="cline"><b>Isotherme 0 °C</b> ${fz != null ? fmt(fz) + ' m' : '—'}${wa ? ` · <b>Vent vers ${fmt(wa.alt)} m</b> ${Math.round(wa.speed)} km/h de ${compass(wa.dir)}` : ''}</p>
    <p class="cline small">Affichables en 3D : Affichage → « Isotherme 0 °C » et « Vent en altitude » (prévision de l'heure, autour du massif).</p>
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
  // (with the clouds in volume, the estimated sea of clouds is replaced by the model's layers: updateCloudProfile)
  state.cloudInside = inside ? `${SPOTS.top.name} est dans les nuages en ce moment (${Math.round(midiC)} % de couverture) : la vue réelle serait bouchée. ` : '';
  state.cloudNote = state.cloudInside
    + (cover > 0.15 ? `Mer de nuages estimée vers ${fmt(alt)} m d'après la couverture nuageuse à ${esc(SPOTS.valley.name)} et à ${esc(SPOTS.mid.name)}.` : inside ? '' : 'Peu de nuages annoncés sur le massif en ce moment.');
  $('cloudNote').textContent = state.cloudNote;
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
  if (state.far) { // outside the massif the stations say nothing reliable: show nothing rather than guess
    if (precipNow.kind !== 'none' || precipNow.alt != null) { precipNow = { kind: 'none', mm: 0, t: null, alt: null }; applyPrecip(); }
    $('precipNow').textContent = state.precip === 'auto' ? 'Hors du massif : pas de météo en direct ici (les stations mesurées sont celles du massif).' : $('precipNow').textContent;
    return;
  }
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
  if (S.stale) html += `<p class="cline stale">Pas de recherche possible (${navigator.onLine ? esc(S.stale) : 'hors ligne'}) : images trouvées lors de la dernière connexion.</p>`;
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
// ---------- avalanche bulletin (bera.js): shown as published, with its date, never interpreted ----------
const dayTime = d => d.toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const riskBox = r => r ? `<span class="badge r${r}" style="background:${RISK[r].color}">${r}</span>` : '<span class="badge" style="background:#666">?</span>';
function aspectRose(aspects, color) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], fr = { W: 'O', SW: 'SO', NW: 'NO' };
  let g = '';
  names.forEach((k, i) => {
    const a0 = (i * 45 - 22.5 - 90) * Math.PI / 180, a1 = (i * 45 + 22.5 - 90) * Math.PI / 180, R = 34, c = 43;
    const p = `M${c},${c} L${(c + R * Math.cos(a0)).toFixed(1)},${(c + R * Math.sin(a0)).toFixed(1)} A${R},${R} 0 0 1 ${(c + R * Math.cos(a1)).toFixed(1)},${(c + R * Math.sin(a1)).toFixed(1)} Z`;
    g += `<path d="${p}" fill="${aspects.includes(k) ? color : 'rgba(255,255,255,.06)'}"/>`;
    const am = (i * 45 - 90) * Math.PI / 180; g += `<text x="${(c + 40 * Math.cos(am)).toFixed(1)}" y="${(c + 40 * Math.sin(am) + 3).toFixed(1)}" text-anchor="middle">${fr[k] ?? k}</text>`;
  });
  return `<svg class="rose" viewBox="0 0 86 86" role="img" aria-label="Orientations les plus exposées : ${aspects.map(a => ({ W: 'O', SW: 'SO', NW: 'NO' }[a] ?? a)).join(', ') || 'aucune signalée'}">${g}</svg>`;
}
// The bulletin on the map (Affichage → « Bulletin d'avalanche sur la carte »): its own figures placed on the relief,
// nothing added. Off season (no bulletin for more than 3 days) nothing is drawn and the legend says why.
const RISK_ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], FR_ASPECT = { W: 'O', SW: 'SO', NW: 'NO' };
const linColor = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b].map(v => Math.pow(v, 2.2)); };
function applyBeraMap() {
  const b = state.bera, want = $('c-bera').checked && !google.on, leg = $('beraLegend');
  const offSeason = b && Date.now() - b.validUntil > 3 * 864e5, top = b?.riskMax ?? b?.risk1;
  const on = want && !!b && !offSeason && top != null;
  U.beraOn.value = on ? 1 : 0; leg.hidden = !want;
  if (!want) return;
  if (!b) { leg.innerHTML = `<div class="lt">Bulletin d'avalanche</div><p>${SITE.bra ? 'Bulletin pas encore reçu (ou indisponible : voir Conditions).' : 'Pas de bulletin Météo-France pour ce massif.'}</p>`; return; }
  if (offSeason || top == null) { leg.innerHTML = `<div class="lt">Bulletin d'avalanche</div><p>Pas de bulletin en cours (le dernier date du ${b.issued.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}) : rien n'est dessiné.</p>`; return; }
  const lo = b.risk1 ?? top, hi = b.altitude != null ? (b.risk2 ?? lo) : lo;
  U.beraAlt.value = b.altitude ?? -1e5; U.beraColLo.value.set(...linColor(RISK[lo].color)); U.beraColHi.value.set(...linColor(RISK[hi].color));
  U.beraMask.value = b.aspects.length ? b.aspects.reduce((m, a) => m | 1 << RISK_ORDER.indexOf(a), 0) : 255;
  const row = (r, txt) => `<li><i style="background:${RISK[r].color}"></i>${r} ${RISK[r].name.toLowerCase()}${txt}</li>`;
  leg.innerHTML = `<div class="lt">Bulletin d'avalanche</div><ul>${b.altitude != null && hi !== lo ? row(hi, ` > ${fmt(b.altitude)} m`) + row(lo, ` < ${fmt(b.altitude)} m`) : row(lo, '')}</ul>
    <p>Pentes de 30° et plus ${b.aspects.length ? `orientées ${b.aspects.map(a => FR_ASPECT[a] ?? a).join(', ')} (les plus exposées selon le bulletin)` : "(le bulletin ne signale pas d'orientation particulière)"}. Bulletin du ${b.issued.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}${b.validUntil < Date.now() ? ', échu' : ''}. Ne remplace ni le bulletin complet ni l'observation sur place.</p>`;
}
$('c-bera').addEventListener('change', applyBeraMap);
// legends fold on phones (CSS): a touch on one opens or closes its explanations (not its own buttons)
document.querySelectorAll('.legend').forEach(l => l.addEventListener('click', e => { if (!e.target.closest('button')) l.classList.toggle('open'); }));
$('c-sunpath').addEventListener('change', e => { nightSky.showPaths = e.target.checked; });
// ---------- weather radar on the relief (RainViewer): the latest frame, or the last 2 hours played in a loop ----------
const radar = { frames: [], i: -1, play: null, at: 0 };
const radarShow = i => {
  const f = radar.frames[i]; if (!f) return; radar.i = i; engine.setRadar(f.path);
  const late = (Date.now() - f.time) / 60e3;
  $('radarTime').innerHTML = `Image de <b>${hhmm(f.time)}</b>${radar.play ? ` (${i + 1}/${radar.frames.length})` : late > 30 ? ` <span class="stale">(il y a ${Math.round(late)} min : pas d'image plus récente)</span>` : ''}`;
};
async function radarLoad() {
  try { radar.frames = await radarFrames(); radar.at = Date.now(); }
  catch (e) { $('radarTime').textContent = `Radar indisponible (${why(e)}).`; return; }
  if (!radar.frames.length) { $('radarTime').textContent = 'Pas d’image radar disponible.'; return; }
  if (!radar.play) radarShow(radar.frames.length - 1);
}
function radarStop() { clearInterval(radar.play); radar.play = null; $('radarPlay').textContent = 'Animer les 2 dernières heures'; }
$('c-radar').addEventListener('change', e => {
  $('radarLegend').hidden = !e.target.checked;
  if (e.target.checked) radarLoad(); else { radarStop(); engine.setRadar(null); }
});
$('radarPlay').addEventListener('click', () => {
  if (radar.play) { radarStop(); radarShow(radar.frames.length - 1); return; }
  if (!radar.frames.length) return;
  $('radarPlay').textContent = 'Revenir à la dernière image';
  let k = 0; radar.play = setInterval(() => { radarShow(k); k = (k + 1) % radar.frames.length; }, 1500); // time for the frame's tiles to arrive
});
setInterval(() => { if ($('c-radar').checked && document.visibilityState === 'visible') radarLoad(); }, 10 * 60e3);
// what the bulletin says for one point: the risk at its altitude, and whether its slope faces a direction it names
function beraAtText(alt, s) {
  const b = state.bera; if (!b || Date.now() - b.validUntil > 3 * 864e5) return '';
  const top = b.riskMax ?? b.risk1; if (top == null) return '';
  const r = b.altitude != null ? (alt >= b.altitude ? b.risk2 ?? top : b.risk1 ?? top) : (b.risk1 ?? top);
  const dir = s && s.deg >= 3 ? RISK_ORDER[Math.round(s.aspect / 45) % 8] : null, exposed = dir && b.aspects.includes(dir);
  return `<p class="cline"><span class="cnd" style="--c:${RISK[r].color}">${r} ${RISK[r].name.toLowerCase()}</span> bulletin d'avalanche à ${fmt(alt)} m${dir ? ` · pente orientée ${FR_ASPECT[dir] ?? dir}${exposed ? ', parmi les plus exposées selon le bulletin' : ''}` : ''} <span class="small">· bulletin du ${b.issued.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}${b.validUntil < Date.now() ? ', échu' : ''}</span></p>`;
}
// the key is optional (the public file needs none): offered quietly
const keyButton = () => `<button type="button" class="mini wide" data-bera-key>${beraKey.get() ? 'Changer la clé Météo-France' : 'Utiliser ma clé Météo-France (facultatif)'}</button>`;
async function loadBera() {
  const el = $('bera');
  if (!SITE.bra) { el.innerHTML = '<p class="cline small">Pas de bulletin Météo-France pour ce massif.</p>'; return; }
  el.innerHTML = '<p class="cmeta">Récupération du bulletin…</p>';
  try { state.bera = await fetchBera(SITE.bra); renderBera(state.bera); }
  catch (e) {
    state.bera = null;
    const msg = { key: "Météo-France refuse la clé : vérifie que c'est bien une « API Key » (pas un jeton OAuth, qui expire en 1 h), copiée en entier, et que l'API « DonneesPubliquesBRA » est souscrite.", none: `Météo-France n'a pas de bulletin pour ce massif en ce moment (ils paraissent de novembre à mai)${beraKey.get() ? ' : la clé fonctionne' : ''}.`, network: 'Bulletin indisponible : pas de connexion et aucun bulletin gardé sur cet appareil.' }[e.kind] ?? 'Bulletin indisponible.';
    el.innerHTML = `<p class="cline">${msg}</p><p class="cline small">Réponse de Météo-France : ${esc(e.message)}</p>${keyButton()}`;
    if (e.kind === 'key') $('beraKeyBlock').hidden = false;
  }
}
function renderBera(b) {
  $('beraKeyBlock').hidden = true;
  const now = Date.now(), expired = b.validUntil < now, offSeason = now - b.validUntil > 3 * 864e5;
  let h = `<div class="bera"><p class="cmeta">Massif ${esc(b.massif)} · publié le ${dayTime(b.issued)}${b.amended ? ' · bulletin modifié' : ''}${b.offline ? ' · copie gardée hors ligne' : ''}${b.source === 'public' ? ' · lu sur meteofrance.com' : ''}</p>`;
  if (offSeason) h += `<p class="cline stale"><b>Pas de bulletin en cours.</b> Le dernier date du ${b.issued.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} ; les bulletins paraissent chaque jour de novembre à mai. Ce qui suit est ce dernier bulletin, pour mémoire.</p>`;
  else if (expired) h += `<p class="cline stale">Ce bulletin était valable jusqu'au ${dayTime(b.validUntil)} : le suivant n'est pas encore disponible.</p>`;
  else h += `<p class="cline small">Valable jusqu'au ${dayTime(b.validUntil)}.</p>`;
  const top = b.riskMax ?? b.risk1;
  h += `<div class="riskline">${riskBox(top)}<div class="rl"><b>Risque ${top ? RISK[top].name.toLowerCase() : 'non indiqué'}${top ? ` (${top}/5)` : ''}</b><span>${esc(b.comment || '')}</span></div>${b.aspects.length ? aspectRose(b.aspects, RISK[top]?.color ?? '#ccc') : ''}</div>`;
  if (b.risk2 != null && b.altitude != null) {
    const band = (r, e, label) => `<div class="band"><i style="background:${RISK[r]?.color ?? '#666'}"></i>${label} : <b>${r} — ${RISK[r]?.name ?? '?'}</b>${e ? `, évoluant vers ${e}` : ''}</div>`;
    h += band(b.risk2, b.evol2, `Au-dessus de ${fmt(b.altitude)} m`) + band(b.risk1, b.evol1, `En dessous de ${fmt(b.altitude)} m`);
  } else if (b.evol1) h += `<p class="cline small">Évolution dans la journée vers ${b.evol1} — ${RISK[b.evol1]?.name ?? ''}.</p>`;
  if (b.aspects.length) h += `<p class="cline small">Pentes les plus exposées (en couleur sur la rose)${b.aspectNote ? ` : ${esc(b.aspectNote)}` : ''}.</p>`;
  if (b.riskJ2) h += `<p class="cline small">Demain : risque ${b.riskJ2} — ${RISK[b.riskJ2]?.name ?? ''}${b.j2 ? `. ${esc(b.j2)}` : ''}</p>`;
  if (b.summary) h += `<p class="cline txt">${esc(b.summary)}</p>`;
  if (b.stability) h += `<details><summary>Stabilité du manteau neigeux${b.stabilityTitle ? ` — ${esc(b.stabilityTitle.slice(0, 80))}` : ''}</summary><p class="txt">${esc(b.stability)}</p></details>`;
  if (b.quality) h += `<details><summary>Qualité de la neige</summary><p class="txt">${esc(b.quality)}</p></details>`;
  if (b.snow?.levels.length) {
    const cm = v => v == null ? '—' : `${v} cm`;
    h += `<h3>Hauteur de neige (bulletin du ${b.snow.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })})</h3>
      <p class="cline small">Limite de l'enneigement : ${b.snow.lineN != null ? fmt(b.snow.lineN) + ' m' : '—'} au nord, ${b.snow.lineS != null ? fmt(b.snow.lineS) + ' m' : '—'} au sud.</p>
      <div class="tw"><table><thead><tr><th>Altitude</th><th class="n">Nord</th><th class="n">Sud</th></tr></thead><tbody>${b.snow.levels.map(l => `<tr><th>${fmt(l.alt)} m</th><td class="n">${cm(l.n)}</td><td class="n">${cm(l.s)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (b.fresh?.days.length) {
    h += `<h3>Neige fraîche sur 24 h${b.fresh.alt ? ` (à ${fmt(b.fresh.alt)} m)` : ''}</h3><div class="tw"><table><tbody>${b.fresh.days.map(d => `<tr><th>${dayName(d.date)}</th><td class="n">${d.min == null ? '—' : d.min === d.max ? `${d.min} cm` : `${d.min} à ${d.max} cm`}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const link = SITE.links.find(([u]) => /meteo-montagne/.test(u))?.[0];
  h += `<p class="cnote">Bulletin d'estimation du risque d'avalanche de Météo-France, reproduit tel quel. Il ne remplace ni la lecture du bulletin complet${link ? ` (<a href="${link}" target="_blank" rel="noopener">voir sur Météo-France</a>)` : ''}, ni l'observation sur le terrain.</p>${keyButton()}</div>`;
  $('bera').innerHTML = h;
  applyBeraMap();
}
$('mfKeySave').addEventListener('click', () => {
  const k = $('mfKey').value.trim();
  if (k.length < 20) { $('bera').innerHTML = '<p class="cline">Ça ne ressemble pas à une clé Météo-France (copie-la en entier depuis « Mes API » sur le portail).</p>'; return; }
  beraKey.set(k); $('mfKey').value = ''; loadBera();
});
$('mfKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('mfKeySave').click(); });
$('bera').addEventListener('click', e => { if (e.target.closest('[data-bera-key]')) { $('beraKeyBlock').hidden = false; $('mfKey').focus(); } });

// ---------- snow film: today's-snow layer switched from one clear pass of the year to the next ----------
let film = null;
function showFilmFrame(i) {
  const e = film.list[i]; film.i = i; film.away = true; $('filmRange').value = i;
  $('filmDate').textContent = e.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  $('filmNote').textContent = `Passage du ${dayName(e.date)} · ${Math.round(e.cloudTile)} % de nuages sur la zone couverte par l'image (les nuages restants sont masqués). Les images arrivent en quelques secondes.`;
  if (!state.snowToday) { $('c-snowtoday').checked = true; $('c-snowtoday').dispatchEvent(new Event('change')); }
  engine.setOverlayItem(e);
}
$('filmLoad').addEventListener('click', async () => {
  $('filmLoad').disabled = true; $('filmLoad').textContent = 'Recherche des images…';
  try {
    const list = await sentinelYear();
    if (!list.length) { $('filmLoad').textContent = 'Aucune image peu nuageuse cette année'; return; }
    film = { list, i: list.length - 1, timer: null };
    $('filmRange').max = list.length - 1; $('film').hidden = false; $('filmLoad').hidden = true;
    showFilmFrame(list.length - 1);
  } catch (err) { $('filmLoad').disabled = false; $('filmLoad').textContent = `Échec (${why(err)}) — réessayer`; }
});
$('filmRange').addEventListener('input', e => showFilmFrame(+e.target.value));
$('filmPlay').addEventListener('click', () => {
  if (film.timer) { clearInterval(film.timer); film.timer = null; $('filmPlay').textContent = 'Lecture'; return; }
  $('filmPlay').textContent = 'Pause';
  film.timer = setInterval(() => showFilmFrame((film.i + 1) % film.list.length), 5000); // time for the satellite tiles to arrive
});
$('filmBack').addEventListener('click', () => {
  if (film?.timer) { clearInterval(film.timer); film.timer = null; $('filmPlay').textContent = 'Lecture'; }
  if (film) film.away = false;
  if (state.s2?.clear) engine.setOverlayItem(state.s2.clear);
  $('filmNote').textContent = state.s2?.clear ? `Retour à la dernière image nette (${dayName(state.s2.clear.date)}).` : '';
});

// The last weather and satellite answers are kept on the device: without network (in the mountains), the app
// shows them with their date rather than nothing; a failed update keeps what is on screen, marked as old.
const keepKey = k => `midi3d-${k}-${SITE.id}`;
const keepSave = (k, v) => { try { localStorage.setItem(keepKey(k), JSON.stringify(v)); } catch { } };
const keepLoad = k => { try { return JSON.parse(localStorage.getItem(keepKey(k)) || 'null'); } catch { return null; } };
const reviveS2 = e => e && { ...e, date: new Date(e.date) };
let s2At = 0, liveRun = null;
// one update at a time (the timer, the app coming back and the button may ask together)
function refreshLive() { return liveRun ??= refreshLiveNow().finally(() => { liveRun = null; }); }
async function refreshLiveNow() {
  loadBera();
  if (!state.weather) $('wx').innerHTML = '<p class="cmeta">Récupération de la météo…</p>';
  try { state.weather = await fetchWeather(); keepSave('weather', state.weather); renderWeather(); }
  catch (e) {
    const kept = state.weather ?? (w => w && { ...w, fetchedAt: new Date(w.fetchedAt) })(keepLoad('weather'));
    if (kept) { state.weather = { ...kept, stale: why(e) }; renderWeather(); }
    else $('wx').innerHTML = `<p class="cline">Météo indisponible (${esc(why(e))}) et aucune météo gardée sur cet appareil. Vérifie la connexion.</p>`;
  }
  // a satellite passes every 2 to 5 days: looked for at opening, then every 3 hours
  if (state.s2 && !state.s2.stale && Date.now() - s2At < 3 * 3600e3) return;
  if (!state.s2) $('sat').innerHTML = '<p class="cmeta">Recherche du dernier passage Sentinel-2…</p>';
  try {
    state.s2 = await findSentinel(d => { if (!state.s2) $('sat').innerHTML = `<p class="cmeta">Analyse de l'image du ${dayName(new Date(d))}…</p>`; });
    s2At = Date.now(); keepSave('s2', state.s2);
  } catch (e) {
    const kept = state.s2 ?? (s => s && { latest: reviveS2(s.latest), clear: reviveS2(s.clear) })(keepLoad('s2'));
    if (!kept) { $('sat').innerHTML = `<p class="cline">Satellite indisponible (${esc(why(e))}) et aucune image gardée sur cet appareil.</p>`; return; }
    state.s2 = { ...kept, stale: why(e) };
  }
  renderSatellite();
  const c = state.s2.clear;
  // the snow film shows a date of its own: left alone (the button "Revenir à la dernière image nette" comes back)
  if (c && !film?.away) { engine.overlay.keepId = c.id; engine.setOverlayItem(c); engine.setOverlay('snow', state.snowToday); engine.setOverlay('vis', state.render === 'sat'); }
}

// ---------- UI ----------
const sheets = ['places', 'cond', 'route', 'layers'];
// the map buttons and the altitude make way for an open panel (on phones it covers them)
function syncSheetOpen() { document.body.classList.toggle('sheet-open', [...sheets, 'point'].some(s => !$('sheet-' + s).hidden)); }
// toggle: touching the open menu again closes it
function openSheet(name, keep = false) {
  $('sheet-point').hidden = true;
  sheets.forEach(s => { const on = s === name && (keep || $('sheet-' + s).hidden); $('sheet-' + s).hidden = !on; $('tab-' + s).setAttribute('aria-pressed', on); });
  syncSheetOpen();
}
function closeSheets() { sheets.forEach(s => { $('sheet-' + s).hidden = true; $('tab-' + s).setAttribute('aria-pressed', 'false'); }); syncSheetOpen(); }
// the panel about one point (relief, photo, refuge) in place of the menus
function showPointSheet() { sheets.forEach(s => { $('sheet-' + s).hidden = true; $('tab-' + s).setAttribute('aria-pressed', 'false'); }); $('sheet-point').hidden = false; syncSheetOpen(); }
sheets.forEach(s => { $('tab-' + s).addEventListener('click', () => openSheet(s)); $('sheet-' + s).querySelector('.close').addEventListener('click', closeSheets); });
// large screens show the panel beside the map; elsewhere it covers most of it and is closed after a choice
const sidePanel = () => matchMedia('(min-width: 700px) and (min-height: 521px)').matches;
const closeIfCovering = () => { if (!sidePanel()) closeSheets(); };
// phones: a panel pulled down by its title bar closes
document.querySelectorAll('.sheet .sh').forEach(sh => {
  const sheet = sh.parentElement; let drag = null;
  sh.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || sheet.getBoundingClientRect().width < innerWidth * 0.7) return; // side panels stay put
    drag = { y: e.clientY, t: performance.now(), id: e.pointerId, dy: 0 }; sh.setPointerCapture(e.pointerId); sheet.classList.add('dragging');
  });
  sh.addEventListener('pointermove', e => { if (!drag || e.pointerId !== drag.id) return; drag.dy = Math.max(0, e.clientY - drag.y); sheet.style.transform = `translateY(${drag.dy}px)`; });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const fast = drag.dy / Math.max(1, performance.now() - drag.t) > 0.6, shut = drag.dy > 90 || (fast && drag.dy > 30);
    drag = null; sheet.classList.remove('dragging'); sheet.classList.add('settle'); sheet.style.transform = '';
    setTimeout(() => sheet.classList.remove('settle'), 220);
    if (shut) { if (sheet.id === 'sheet-point') sheet.querySelector('.close').click(); else closeSheets(); }
  };
  sh.addEventListener('pointerup', end); sh.addEventListener('pointercancel', end);
});
// short messages saying what just happened (a point added, a layer hidden, a route computed…)
let toastTimer = null;
function toast(msg, warn = false, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', warn); t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; // replay the entrance
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
// iOS Safari zooms the whole page on a pinch over the panels (it ignores user-scalable=no): the map has its own zoom
document.addEventListener('gesturestart', e => e.preventDefault());

// ---------- choosing one point on the map (start, destination, line of sight, altitude) ----------
// A banner says what to touch; the next touch on the relief (or on a name) is the answer; "Annuler" gives up.
let pickMode = null;
function startPick(msg, onPick) {
  if (draw.on) stopDraw(false);
  pickMode = { onPick }; $('pickMsg').textContent = msg; $('pickBar').hidden = false; document.body.classList.add('picking');
  closeSheets(); $('sheet-point').hidden = true; syncSheetOpen(); measureBars();
}
function endPick() { pickMode = null; $('pickBar').hidden = true; document.body.classList.remove('picking'); }
function picked(hit) { const m = pickMode; endPick(); dropPin(hit); buzz(15); m.onPick(hit); }
$('pickCancel').addEventListener('click', endPick);
// Escape (computers): gives up the point being chosen, then the drawing (same confirmation), then closes the panel
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.target.closest?.('input, select, textarea')) return;
  if (pickMode) endPick();
  else if (draw.on) $('drawQuit').click();
  else if (!$('sheet-point').hidden) $('sheet-point').querySelector('.close').click();
  else closeSheets();
});
// a point touched that the panel now covers (phones): the view slides so that it shows above the panel,
// halfway between the top of the screen and the panel (same distance, same angle)
function keepInSight(p) {
  if (sidePanel() || google.on) return;
  const top = $('sheet-point').getBoundingClientRect().top, H = stage.clientHeight, P = new THREE.Vector3(p.x, p.h * state.exag, p.z);
  const q = P.clone().project(camera), y = (-q.y * 0.5 + 0.5) * H;
  if (y < top - 50) return;
  const ndcY = 1 - top / H, fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), depth = P.clone().sub(camera.position).dot(fwd);
  fly = null; controls.goal.t.copy(P).addScaledVector(up, -ndcY * depth * Math.tan(camera.fov * Math.PI / 360));
}
// the red pin falls where a point was chosen
function dropPin(hit) { pin = { x: hit.x, z: hit.z, h: hit.h ?? groundAt(hit.x, hit.z) ?? 0 }; const el = $('pin'); el.classList.remove('drop'); void el.offsetWidth; el.classList.add('drop'); }

// ---------- "Sortie": my position, an itinerary (GPX or drawn), its profile and numbers, a flight along it ----------
const gps = new GpsTracker({ scene, onChange: renderGps });
const route = new RouteLayer({ scene, groundAt });
const track = new TrackRecorder({ scene, groundAt });
let gpsCentered = false, flyRoute = null;
const ago2 = d => { const s = Math.max(0, (Date.now() - d) / 1000); return s < 60 ? `il y a ${Math.round(s)} s` : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.floor(s / 3600)} h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')}`; };
function centerOnGps() {
  const p = gps.pos; if (!p) return;
  const g = groundAt(p.x, p.z) ?? p.gpsAlt ?? controls.target.y, t = new THREE.Vector3(p.x, g * state.exag, p.z);
  let dir = camera.position.clone().sub(controls.target).normalize(); if (dir.y < 0.3) { dir.y = 0.5; dir.normalize(); }
  engine.ensureRoots(p.x, p.z, 45000); startFly(t, t.clone().addScaledVector(dir, 1200), 1800);
}
function renderGps() {
  const on = gps.on; $('gpsFab').setAttribute('aria-pressed', on); $('gpsGo').textContent = on ? 'Arrêter la localisation' : 'Me localiser';
  const p = gps.pos;
  if (gps.error) $('gpsInfo').textContent = gps.error;
  else if (on && !p) $('gpsInfo').textContent = 'Recherche de la position…';
  else if (on && p) {
    const g = groundAt(p.x, p.z);
    $('gpsInfo').textContent = `Position à ±${fmt(p.acc)} m (${ago2(p.time)})${g != null ? ` · altitude du relief ${fmt(g)} m` : ''}${p.gpsAlt != null ? ` (GPS : ${fmt(p.gpsAlt)} m)` : ''}.`;
    if (!gpsCentered) { gpsCentered = true; centerOnGps(); }
  } else $('gpsInfo').textContent = 'Ta position GPS en direct sur la carte (il faut autoriser la localisation).';
  if (gps.error && (draw.wantGps || plan.waitGps)) { draw.wantGps = plan.waitGps = false; toast(gps.error, true, 5000); }
  if (p && draw.wantGps && draw.on) { draw.wantGps = false; drawStep(p.x, p.z); }
  renderPlan();
  if (p && plan.waitGps) { plan.waitGps = false; planMaybe(); }
  tripFix();
}

// ---------- following an outing: recording, what remains, alerts ----------
const trip = { off: 0, offAlert: false, sunAlert: false, sun: null, sunDay: '', stormAt: 0, storm: null, stormSaid: null };
// During an outing (recording, or position shared): every 30 minutes the Météo-France forecast at the walker's
// place and altitude is read for the next 3 hours; a thunderstorm in it (codes 95, 96, 99) is said, with its hour,
// the phone buzzes once for each new storm. A forecast, not a detection: the radar shows what falls now.
async function stormCheck(p) {
  trip.stormAt = Date.now();
  try {
    const f = await pointForecast(p.lat, p.lon, p.ground ?? p.gpsAlt ?? 1500), h = f.hourly;
    let at = null; for (let k = f.k0; k < Math.min(h.time.length, f.k0 + 4); k++) if ([95, 96, 99].includes(h.weather_code[k])) { at = new Date(h.time[k]); break; }
    trip.storm = at;
    if (at && trip.stormSaid !== +at) { trip.stormSaid = +at; buzz([400, 150, 400]); toast(`Orage prévu ici vers ${hhmm(at)} (Météo-France) : redescends des crêtes et des sommets.`, true, 8000); }
  } catch { trip.stormAt = Date.now() - 25 * 60e3; } // no network: asked again in 5 minutes
  renderTrip();
}
const hhmm = d => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const buzz = p => { try { navigator.vibrate?.(p); } catch { } };
function tripFix() {
  const p = gps.pos; if (!p) { renderTrip(); return; }
  track.addFix(p); liveShare.fix(p);
  const prog = route.samples.length > 1 ? progressOn(route.samples, p.x, p.z) : null;
  // off the itinerary: farther than 60 m beyond the GPS uncertainty on three fixes in a row
  if (prog && prog.off > 60 + p.acc) { if (++trip.off >= 3 && !trip.offAlert) { trip.offAlert = true; buzz([200, 100, 200]); } }
  else { trip.off = 0; trip.offAlert = false; }
  trip.prog = prog; trip.next = guideFix(prog);
  // the day's sunset where one stands (computed once a day)
  const day = new Date().toDateString(); if (trip.sunDay !== day) { trip.sun = sunTimes(new Date(), p.lat, p.lon); trip.sunDay = day; }
  if ((track.recording || liveShare.on) && Date.now() - trip.stormAt > 30 * 60e3) stormCheck(p);
  renderTrip();
}
function renderTrip() {
  const lines = [], st = track.stats(), prog = trip.prog, p = gps.pos;
  if (trip.storm && (track.recording || liveShare.on)) lines.push(`<span class="bad">Orage prévu ici vers ${hhmm(trip.storm)}</span> (prévision Météo-France à ta position)`);
  if (liveShare.on) lines.push(`<span class="rec">●</span> Position partagée${liveShare.state.last ? ` · envoyée ${ago2(liveShare.state.last.t)}` : ''}`);
  if (track.recording && st) lines.push(`<span class="rec">● Enregistrement</span> · ${t1(st.dist / 1000)} km · +${fmt(st.up)} m · ${hm(st.hours)}${st.speed != null ? ` · ${t1(st.speed)} km/h` : ''}`);
  if (prog && gps.on) {
    // own pace: the time taken so far against the standard time of the part walked (once it means something)
    let pace = 1;
    if (track.recording && st && prog.doneHours > 0.25 && st.hours > 0.25) pace = Math.min(2.5, Math.max(0.5, st.hours / prog.doneHours));
    const hoursLeft = prog.hours * pace, eta = new Date(Date.now() + hoursLeft * 3600e3);
    lines.push(prog.left < 30 ? "Arrivé au bout de l'itinéraire." : `Reste ${t1(prog.left / 1000)} km · +${fmt(prog.up)} m · −${fmt(prog.down)} m · ${hm(hoursLeft)}${pace !== 1 ? ' à ton rythme' : ''} → arrivée vers ${hhmm(eta)}`);
    if (trip.offAlert) lines.push(`<span class="bad">Tu t'écartes de l'itinéraire : à ${fmt(prog.off)} m de la ligne.</span>`);
    else if (trip.next && trip.next.left < 400) lines.push(`Croisement dans ${fmt(Math.max(0, trip.next.left))} m : ${esc(trip.next.j.text)}${trip.next.j.toward ? `, direction ${esc(trip.next.j.toward)}` : ''}`);
    const ss = trip.sun?.sunset;
    if (ss && eta > ss - 15 * 60e3 && prog.left >= 30) {
      if (!trip.sunAlert) { trip.sunAlert = true; buzz([300]); }
      lines.push(`<span class="warn">Arrivée prévue ${eta > ss ? 'après' : 'juste avant'} le coucher du soleil (${hhmm(ss)}${trip.sun.dusk ? `, nuit noire vers ${hhmm(trip.sun.dusk)}` : ''}) : lampe frontale, ou faire demi-tour.</span>`);
    }
  }
  if (p && gps.on && trip.sun?.sunset && !lines.some(l => l.includes('coucher'))) {
    const left = (trip.sun.sunset - Date.now()) / 3600e3;
    if (left > 0 && left < 4) lines.push(`Coucher du soleil ${hhmm(trip.sun.sunset)} (dans ${hm(left)})`);
  }
  $('tripCard').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  $('tripCard').hidden = !lines.length;
  $('trkGo').classList.toggle('rec', track.recording);
  $('trkGoT').textContent = track.recording ? "Arrêter l'enregistrement" : track.pts.length ? "Reprendre l'enregistrement" : 'Enregistrer ma sortie';
  $('trkGoS').textContent = track.recording && st ? `En cours : ${t1(st.dist / 1000)} km · +${fmt(st.up)} m · ${hm(st.hours)}` : 'Ma trace GPS, distance, dénivelé';
  $('trkInfo').textContent = track.recording ? "L'écran reste allumé pendant l'enregistrement : verrouillé, le téléphone met l'appli en pause et la trace s'interrompt."
    : st ? `Trace gardée : ${t1(st.dist / 1000)} km, +${fmt(st.up)} m, ${fmt(st.count)} points (export et effacement dans « Ma position et ma trace »).` : '';
}
$('trkGo').addEventListener('click', () => {
  if (track.recording) { track.stop(); toast('Enregistrement arrêté : ta trace est gardée.'); }
  else { track.start(); if (!gps.on) { gpsCentered = false; gps.start(); } toast("Enregistrement démarré : garde l'écran allumé."); }
  renderTrip();
});
$('trkGpx').addEventListener('click', () => {
  if (track.pts.length < 2) { $('trkInfo').textContent = "Pas encore de trace à exporter."; return; }
  const a = document.createElement('a'), d = new Date(track.started ?? Date.now());
  a.href = URL.createObjectURL(new Blob([track.toGPX(`Sortie du ${d.toLocaleDateString('fr-FR')}`)], { type: 'application/gpx+xml' }));
  a.download = `sortie-${d.toISOString().slice(0, 10)}.gpx`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('trkClear').addEventListener('click', () => {
  if ($('trkClear').dataset.armed !== '1') { $('trkClear').dataset.armed = '1'; $('trkClear').textContent = 'Confirmer : effacer'; setTimeout(() => { $('trkClear').dataset.armed = ''; $('trkClear').textContent = 'Effacer ma trace'; }, 4000); return; }
  track.clear(); $('trkClear').dataset.armed = ''; $('trkClear').textContent = 'Effacer ma trace'; renderTrip();
});
// a recording left running when the app was closed carries on
if (track.recording) setTimeout(() => { track.start(); gps.start(); }) ; // after the whole module has run
setInterval(renderTrip, 30e3);
$('gpsGo').addEventListener('click', () => { if (gps.on) gps.stop(); else { gpsCentered = false; gps.start(); } });
$('gpsFab').addEventListener('click', () => { if (!gps.on) { gpsCentered = false; gps.start(); } else centerOnGps(); });
const hm = h => { const m = Math.round(h * 60 / 5) * 5; return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const km = d => (d / 1000).toLocaleString('fr-FR', { maximumFractionDigits: d < 10000 ? 2 : 1 });
// the itinerary laid on the relief again, and its card in "Rando"
function renderRoute() { route.drape(state.exag); renderRouteCard(); }
let routeSig = '', routeKey = '';
// on foot or on skis (ski touring): the numbers, the verdict and the colours on the map follow (kept on the device)
const activity = { v: (() => { try { return localStorage.getItem('midi3d-activity') || 'foot'; } catch { return 'foot'; } })() };
const SKI_COLOURS = ['#ff9419', '#e3261f', '#9a37d0', '#b8bcc8'];
function skiKpis(k) {
  return `<div class="kpis">
      <div><span>Montée à skis</span><b>${hm(k.upHours)}</b></div>
      <div><span>Descente</span><b>${hm(k.downHours)}</b></div>
      <div><span>Dénivelé +</span><b>${fmt(k.up)} m</b></div>
      <div><span>Dénivelé −</span><b>${fmt(k.down)} m</b></div>
      <div><span>Distance</span><b>${km(k.dist)} km</b></div>
      <div><span>Total</span><b>${hm(k.hours)}</b></div>
    </div>
    <p class="cline small">Pentes à la descente : ${k.bins.some(v => v > 5) ? SKI_BINS.map((b, i) => k.bins[i] > 5 ? `<span class="wk" style="background:${SKI_COLOURS[i]};color:${i === 1 || i === 2 ? '#fff' : '#111'}">${b}°${i < 3 ? `–${SKI_BINS[i + 1]}°` : ' et plus'}</span> ${fmt(k.bins[i])} m` : '').filter(Boolean).join(' · ') : 'rien à 30° ou plus.'}</p>`;
}
function renderRouteCard() {
  const st = route.stats(), has = route.pts.length >= 2 && !route.drawing;
  route.ski = activity.v === 'ski' && route.samples.length > 1 ? skiStats(route.samples, (x, z) => engine.slopeAt(x, z)) : null;
  routeSig = st ? `${Math.round(st.dist)}|${Math.round(st.up)}|${st.complete}` : '';
  $('routeCard').hidden = !has;
  if (draw.on) renderDraw();
  // another itinerary: its "when to leave" is asked again when opened, its days laid out again
  const key = `${route.name}|${route.pts.length}|${route.pts[0]?.join()}`;
  if (key !== routeKey) { routeKey = key; guide.key = null; guide.said.clear(); $('d-when').open = false; $('d-rwx').open = false; rwx.key = null; $('rwxOut').innerHTML = ''; $('whenOut').innerHTML = ''; delete $('whenOut').dataset.key; walkSig = ''; route.hazards = []; route.expo = null; scheduleWalk(true); }
  else if (route.pts.length >= 2) scheduleWalk(false);
  if (has) renderDays();
  if (!has) { $('routeOut').innerHTML = ''; return; }
  const name = `<p class="rname">${esc(route.name || 'Mon itinéraire')}</p>`;
  if (!st) { $('routeOut').innerHTML = `${name}<p class="cline small">Relief en cours de chargement sous le tracé…</p>`; return; }
  const mode = `<div class="seg2" role="group" aria-label="Activité"><button type="button" class="mini${activity.v === 'foot' ? ' on' : ''}" data-act="foot">À pied</button><button type="button" class="mini${activity.v === 'ski' ? ' on' : ''}" data-act="ski">Ski de rando</button></div>`;
  if (route.ski) {
    $('routeOut').innerHTML = `${name}${mode}${skiKpis(route.ski)}${route.profileSVG()}
    <p class="cnote">Montée : 4 kilomètres-effort par heure (1 km à plat ou 100 m de montée), la règle du Club alpin suisse ; descente : 1 000 m de dénivelé par heure, une estimation courante qui varie beaucoup avec la neige et le niveau. Sans pauses${st.ride ? ', remontée à part' : ''}. Pentes du relief LiDAR IGN sous le tracé, aux couleurs de la carte des pentes.</p>`;
    showHazards(); return;
  }
  $('routeOut').innerHTML = `${name}${mode}
    <div class="kpis">
      <div><span>Distance</span><b>${km(st.dist)} km</b></div>
      <div><span>Temps de marche</span><b>${hm(st.hours)}</b></div>
      <div><span>Dénivelé +</span><b>${fmt(st.up)} m</b></div>
      <div><span>Dénivelé −</span><b>${fmt(st.down)} m</b></div>
      <div><span>Point haut / bas</span><b>${fmt(st.max)} / ${fmt(st.min)} m</b></div>
      <div><span>Raideur max du tracé</span><b>${Math.round(st.steepDeg)}°</b></div>
      ${st.ride ? `<div><span>En remontée</span><b>${km(st.ride)} km · +${fmt(st.rideUp)} m</b></div>` : ''}
    </div>
    ${route.profileSVG()}
    <p class="cnote">Altitudes du relief LiDAR IGN sous le tracé${st.complete ? '' : ' (partiel : une partie du relief n\'est pas encore chargée)'}. Temps selon la norme DIN 33466 (randonneur moyen, sans pauses) ; pente maxi mesurée sur 30 m.${st.ride ? ' Distance, dénivelé et temps : à pied seulement, la remontée (pointillés blancs) est à part.' : ''}</p>`;
}
// a new itinerary is there: on phones the panel closes so the line is seen on the map, with its numbers in a
// message; the card at the top of "Rando" holds the details
function routeReady(what) {
  renderRoute(); frameRoute();
  const st = route.stats();
  if (sidePanel()) { openSheet('route', true); $('sheet-route').scrollTop = 0; $('routeCard').classList.remove('flash'); void $('routeCard').offsetWidth; $('routeCard').classList.add('flash'); }
  else closeSheets();
  toast(`${what}${st ? ` : ${km(st.dist)} km · +${fmt(st.up)} m · ${hm(st.hours)}` : ''}. Détails dans « Rando ».`, false, 4500);
}
$('routeOut').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.dataset.act === activity.v) return;
  activity.v = b.dataset.act; try { localStorage.setItem('midi3d-activity', activity.v); } catch { }
  walkSig = ''; renderRouteCard(); showHazards(); renderWalk();
  toast(activity.v === 'ski' ? 'Ski de rando : temps de montée et de descente, pentes de la descente en couleur.' : 'À pied : temps de marche et sentiers.');
});
$('routeClear').addEventListener('click', () => {
  const b = $('routeClear');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Confirmer'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Effacer'; }, 4000); return; }
  b.dataset.armed = ''; b.textContent = 'Effacer'; route.clear(); renderRoute(); toast('Itinéraire effacé.');
});
$('gpxIn').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
  try { route.importGPX(await f.text(), f.name); routeReady(`« ${route.name} » ouvert`); }
  catch (err) { toast(`Ce fichier ne s'ouvre pas : ${err.message}.`, true, 5000); }
});

// ---------- drawing an itinerary on the map, step by step ----------
// Each touch on the relief (or on a name) is a step. "Suivre les sentiers": the stretch to the new step is asked
// of the IGN route service, so the line follows the paths; a touch beside a path lands on it, a touch far from any
// path (a summit, a glacier) is joined by a straight line, said in a message. Without paths (offline, nothing
// found), a straight line, said too. Touches are handled one after the other.
const draw = { on: false, gen: 0, q: Promise.resolve(), busy: 0, pending: [], snap: true, wantGps: false, note: '', quitArmed: 0 };
try { draw.snap = localStorage.getItem('midi3d-snap') !== '0'; } catch { }
$('drawSnap').checked = draw.snap;
$('drawSnap').addEventListener('change', e => {
  draw.snap = e.target.checked; try { localStorage.setItem('midi3d-snap', draw.snap ? '1' : '0'); } catch { }
  toast(draw.snap ? 'Le tracé suit les sentiers IGN.' : 'Lignes droites entre les points touchés (hors sentier, ou pour mesurer).');
});
function startDraw(fresh) {
  if (pickMode) endPick();
  flyRoute = null; route.beginDraw(fresh);
  Object.assign(draw, { on: true, gen: draw.gen + 1, busy: 0, pending: [], note: '', wantGps: false, quitArmed: 0, offer: null });
  document.body.classList.add('drawing'); $('drawTop').hidden = $('drawBar').hidden = false;
  closeSheets(); $('sheet-point').hidden = true; pin = null; $('pin').hidden = true; syncSheetOpen();
  $('drawTitle').textContent = fresh ? 'Tracer une rando' : 'Modifier le tracé';
  renderRoute();
}
function stopDraw(keep) {
  if (!draw.on) return;
  draw.on = false; draw.wantGps = false; draw.pending = [];
  document.body.classList.remove('drawing'); $('drawTop').hidden = $('drawBar').hidden = true;
  if (keep && route.pts.length >= 2) {
    if (!route.name) route.name = `Tracé du ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
    route.endDraw(); routeReady('Tracé gardé');
  } else { route.cancelDraw(); renderRoute(); }
}
function renderDraw() {
  const n = route.ends.length, st = n >= 2 ? route.stats() : null, busy = draw.busy > 0;
  const msg = $('drawMsg');
  msg.classList.toggle('busy', busy && draw.snap);
  msg.textContent = busy && draw.snap ? 'Recherche du chemin par les sentiers…'
    : n === 0 ? (draw.wantGps ? 'Recherche de ta position GPS…' : "Touche la carte à l'endroit du départ (ou le nom d'un lieu).")
    : n === 1 ? 'Départ posé. Touche la prochaine étape.'
    : 'Touche l\'étape suivante, ou « Terminer ».';
  const wk = route.walk && n >= 2 ? walkText(route.walk)[0] : '';
  $('drawStats').innerHTML = st ? `<span>${km(st.dist)} km</span><span>+${fmt(st.up)} m</span><span>−${fmt(st.down)} m</span><span>${hm(st.hours)}</span>${wk ? `<span class="verdict">${wk}</span>` : ''}${draw.note ? `<span class="warn">${esc(draw.note)}</span>` : ''}`
    : n === 1 && !busy ? '<span>1 point</span>' : '';
  $('drawUndo').disabled = n <= route.keep && !busy;
  $('drawDone').disabled = n < 2 || busy;
  $('drawMe').hidden = n > 0 || busy;
  $('drawOff').hidden = !draw.offer || busy;
  measureBars();
}
// metres covered by one CSS pixel at a point of the relief (to judge a touch "beside" a path)
function metresPerPixel(x, z) {
  const d = camera.position.distanceTo(proj.set(x, (groundAt(x, z) ?? 0) * state.exag, z));
  return 2 * d * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, stage.clientHeight);
}
const pathLength = pts => pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);
// the stretch from a to b along the IGN paths (see above); tol: how far from a path a touch still lands on it
async function pathStretch(a, b, tol, firstLeg) {
  const ll = p => { const [lon, lat] = worldToLonLat(p[0], p[1]); return { lon, lat }; }, straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
  try {
    const r = await walkingRoute(ll(a), ll(b));
    const via = r.pts.slice(); let start = null, end = via[via.length - 1], note = '';
    // the start touched beside a path is put on it; otherwise a straight line joins it to the path
    const net = via.map(() => true); // what the route service gives is on the IGN network of paths and roads
    if (r.offStart > 1) { if (firstLeg && r.offStart <= tol) start = via[0]; else { via.unshift(a); net.unshift(false); } }
    // the paths stop short of the point touched: the line stops with them (a straight line beyond went up faces and
    // glaciers no one walks); said, with the lift that serves the place when there is one
    if (r.offEnd > tol) {
      draw.offer = b; // the point touched, offered as a straight line off the paths (button "Prolonger hors sentier")
      const lift = trails.lifts().map(l => ({ l, d: Math.min(Math.hypot(l.a[0] - b[0], l.a[1] - b[1]), Math.hypot(l.b[0] - b[0], l.b[1] - b[1])) })).sort((p, q) => p.d - q.d)[0];
      note = `Pas de sentier jusqu'au point touché : le chemin s'arrête ${fmt(r.offEnd)} m avant (au-delà : glacier, rocher ou pente raide, terrain d'alpinisme). Le tracé s'arrête au bout du chemin.`
        + (lift && lift.d < 600 ? ` Ce point est desservi par une remontée (${lift.l.name ?? 'téléphérique'}).` : '');
    }
    const len = pathLength(via);
    if (len > 3 * straight && len - straight > 1500) note = `Par les sentiers, ce passage fait ${km(len)} km (${km(straight)} km à vol d'oiseau). Annule le point et pose une étape avant, ou décoche « Suivre les sentiers ».`;
    return { via, net, start, end, note };
  } catch (e) {
    const why = !navigator.onLine ? 'Hors ligne : ligne droite (les sentiers demandent du réseau).'
      : /aucun chemin/.test(e.message) ? 'Pas de chemin IGN entre ces deux points : ligne droite.' : `Itinéraire IGN indisponible (${e.message}) : ligne droite.`;
    return { via: [a, b], start: null, end: b, note: why };
  }
}
function drawStep(x, z) {
  const mpp = metresPerPixel(x, z), tol = Math.min(300, Math.max(25, 28 * mpp)), mark = { x, z }, gen = draw.gen;
  // a touch on (almost) the same spot as the last step is not a new step: a double tap (which zooms in), or a
  // finger that hesitated
  const prev = draw.pending[draw.pending.length - 1] ?? (route.last && { x: route.last[0], z: route.last[1] });
  if (prev && Math.hypot(prev.x - x, prev.z - z) < 12 * mpp) return;
  const live = () => draw.on && draw.gen === gen; // the same drawing still going on
  draw.busy++; draw.pending.push(mark); draw.offer = null; buzz(12); renderDraw();
  draw.q = draw.q.then(async () => {
    if (!live()) return;
    if (!route.pts.length || !draw.snap) { route.addStep(x, z); draw.note = ''; return; }
    const s = await pathStretch(route.last, [x, z], tol, route.ends.length === 1);
    if (!live()) return; // abandoned meanwhile
    if (s.start) route.moveStart(s.start[0], s.start[1]);
    route.addStep(s.end[0], s.end[1], s.via, s.net);
    draw.note = s.note; if (s.note) toast(s.note, true, 6000);
  }).catch(e => console.error(e)).finally(() => {
    draw.busy = Math.max(0, draw.busy - 1); draw.pending = draw.pending.filter(m => m !== mark);
    if (live()) renderRoute();
  });
}
// the map buttons and the messages sit clear of the drawing's banner and bar, whose height depends on the screen
function measureBars() {
  const s = document.body.style;
  s.setProperty('--drawh', `${$('drawBar').offsetHeight}px`); s.setProperty('--toph', `${Math.max($('drawTop').offsetHeight, $('pickBar').offsetHeight)}px`);
}
{ const ro = new ResizeObserver(measureBars); for (const id of ['drawBar', 'drawTop', 'pickBar']) ro.observe($(id)); }
$('drawGo').addEventListener('click', () => startDraw(true));
$('drawEdit').addEventListener('click', () => startDraw(false));
$('drawUndo').addEventListener('click', () => {
  const gen = draw.gen;
  draw.q = draw.q.then(() => { if (!draw.on || draw.gen !== gen) return; route.undo(); draw.note = ''; renderRoute(); buzz(12); });
});
$('drawDone').addEventListener('click', () => stopDraw(true));
// carry on beyond the end of the paths anyway: a straight line, judged like the rest (rock, glacier, steep ground)
$('drawOff').addEventListener('click', () => {
  const b = draw.offer; if (!b) return; draw.offer = null;
  route.addStep(b[0], b[1]); draw.note = 'Ligne droite hors sentier ajoutée : regarde le verdict (parois, glacier, pentes raides).'; renderRoute();
});
// giving up a drawing: a second touch confirms, so a slip of the finger loses nothing
$('drawQuit').addEventListener('click', () => {
  if (route.ends.length < 2 || performance.now() - draw.quitArmed < 3500) { stopDraw(false); toast('Tracé abandonné.'); return; }
  draw.quitArmed = performance.now(); toast('Touche encore × pour abandonner ce tracé (ou « Terminer » pour le garder).', true, 3500);
});
$('drawMe').addEventListener('click', () => {
  if (gps.pos) { drawStep(gps.pos.x, gps.pos.z); return; }
  draw.wantGps = true; if (!gps.on) { gpsCentered = true; gps.start(); } renderDraw();
});
// ---------- can it be walked? (routebook.js walkability): verdict, and the stretches coloured on the map ----------
let walkTimer = null, walkTries = 0, walkSig = '';
function scheduleWalk(reset) { if (reset) walkTries = 0; clearTimeout(walkTimer); walkTimer = setTimeout(analyseWalk, 300); }
const judge = S => walkability(S, {
  slopeAt: (x, z) => engine.slopeAt(x, z), onGlacier: (x, z) => glaciers.contains(x, z), pathDist: (x, z) => trails.pathDist(x, z),
  stations: trails.lifts().flatMap(l => [l.a, l.b])
});
function analyseWalk() {
  const S = route.samples;
  if (S.length < 2) { route.walk = null; if (route.hazards.length) route.setHazards([]); $('walkOut').innerHTML = ''; return; }
  // the paths and glaciers along the whole line are asked for (kept on the device), then the line is judged again
  for (let i = 0; i < S.length; i += 150) { trails.ensure(S[i].x, S[i].z); glaciers.ensure(S[i].x, S[i].z); }
  const w = judge(S);
  route.walk = w;
  showHazards();
  renderWalk();
  if (w.unknown > 0 && ++walkTries < 20) { clearTimeout(walkTimer); walkTimer = setTimeout(analyseWalk, 3000); } // paths still loading
  else scheduleExposure();
}
// the stretches drawn on the map: what is not a walk, and what lies under avalanche slopes
function showHazards() {
  const ski = activity.v === 'ski' && route.ski, walk = (route.walk?.stretches ?? []).filter(s => !ski || s.kind === 'rock' || s.kind === 'glacier');
  // a few metres (one sample over a rock step) would only be a dot: 15 m and more
  const list = [...walk, ...(ski ? route.ski.stretches : []), ...(route.expo?.stretches ?? [])].filter(s => s.d1 - s.d0 >= 15);
  const sig = JSON.stringify(list.map(s => [Math.round(s.d0), Math.round(s.d1), s.kind]));
  if (sig !== walkSig) { walkSig = sig; route.setHazards(list); }
}
// slopes above the line (routebook.js exposure): worked out once the line's paths are known, again while part of the
// relief around it was missing (it keeps arriving), at most 4 times
let expoKey = '', expoTries = 0, expoBusy = false;
function scheduleExposure(again = false) {
  const key = routeKey;
  if (key !== expoKey) { expoKey = key; expoTries = 0; route.expo = null; }
  else if (expoBusy || (!again && route.expo) || expoTries >= 4) return;
  expoTries++; expoBusy = true;
  setTimeout(async () => {
    const e = await exposure(route.samples, (x, z) => engine.heightAt(x, z), { alive: () => routeKey === key }).catch(() => null);
    expoBusy = false;
    if (!e || routeKey !== key) return;
    route.expo = e; showHazards(); renderWalk();
    if (e.unknown > 50 && expoTries < 4) setTimeout(() => scheduleExposure(true), 15000);
  }, 800);
}
const walkText = (w, e = null) => {
  const m = v => `${fmt(v)} m`, bits = [];
  if (w.rock > 30) bits.push(`<span class="wk rock">Non faisable à pied</span> : ${m(w.rock)} dans des parois (terrain jusqu'à ${Math.round(w.rockMax)}°) : passages d'escalade. C'est un itinéraire d'alpinisme : matériel, expérience, guide conseillé.`);
  if (w.glacier > 50) bits.push(`<span class="wk glacier">Glacier</span> sur ${m(w.glacier)} : crevasses, encordement et matériel d'alpinisme.`);
  const ski = activity.v === 'ski';
  if (w.steep > 50 && !ski) bits.push(`<span class="wk steep">Pentes de 35° et plus</span> hors sentier sur ${m(w.steep)} : terrain très raide, une glissade ne s'arrête pas.`);
  if (w.off > 200 && !ski) bits.push(`<span class="wk off">Hors sentier</span> sur ${m(w.off)} (pas de chemin IGN à moins de 40 m).`);
  if (!bits.length && !ski && w.unknown <= w.total * 0.3) bits.push(`<span class="wk path">Sur sentiers et chemins</span> ${w.lift ? 'pour la marche' : 'de bout en bout'} (IGN), sans paroi ni glacier.`);
  if (e?.exposed > 50) bits.push(`<span class="wk under">Sous des pentes de 30° et plus</span> sur ${m(e.exposed)} : avec de la neige, une avalanche partie au-dessus peut atteindre le tracé (pente de 30 à 60° à moins de 1 km, tournée vers lui, portée calculée par le modèle norvégien α-β). La forêt, qui retient souvent la neige, n'est pas comptée. Regarde le bulletin d'avalanche.`);
  else if (e && e.unknown <= 50) bits.push(`<span class="small">Aucune pente de 30° et plus d'où une avalanche pourrait atteindre le tracé (à moins de 1 km, modèle α-β).</span>`);
  if (w.lift > 0) bits.push(`<span class="wk lift">Remontée</span> sur ${km(w.lift)} km : vérifie qu'elle fonctionne ce jour-là (horaires, fermetures hors saison et pour révision). Le temps de montée en cabine n'est pas compté.`);
  if (w.unknown > 0) bits.push(`<span class="small">Sentiers pas encore chargés sur ${m(w.unknown)} : vérification en cours…</span>`);
  return bits;
};
function renderWalk() {
  const w = route.walk; if (!w) { $('walkOut').innerHTML = ''; return; }
  $('walkOut').innerHTML = `<div class="walk">${walkText(w, route.expo).map(b => `<p class="cline">${b}</p>`).join('')}
    <p class="cnote">Mesuré sur le relief LiDAR IGN (pente du terrain traversé et des pentes au-dessus), les sentiers et les glaciers de la BD TOPO IGN. Ne dit rien de la neige, de la glace ou de l'état des chemins du jour.</p></div>`;
  if (draw.on) renderDraw();
}

// ---------- my itineraries, an outing in several days, when to leave (routebook.js) ----------
const bookPick = new Set();
const factsLine = f => `${km(f.dist)} km · ${hm(f.hours)} · +${fmt(f.up)} m / −${fmt(f.down)} m · point haut ${fmt(f.max)} m${f.steep30 > 20 ? ` · ${fmt(f.steep30)} m à travers des pentes ≥ 30°` : ''}`;
function renderBook() {
  const list = loadBook(); $('bookCnt').textContent = list.length ? fmt(list.length) : '';
  $('bookOut').innerHTML = list.length ? `<div class="book">${list.map(r => `<div class="item"><input type="checkbox" data-cmp="${r.id}" ${bookPick.has(r.id) ? 'checked' : ''} aria-label="Comparer ${esc(r.name)}"><b>${esc(r.name)}</b>
    <span class="meta">${r.facts ? factsLine(r.facts) : ''}${r.nights?.length ? ` · ${r.nights.length + 1} jours` : ''} · gardé le ${new Date(r.saved).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span>
    <div class="btns"><button type="button" class="mini" data-open="${r.id}">Ouvrir</button><button type="button" class="mini" data-del="${r.id}">Supprimer</button></div></div>`).join('')}</div>`
    : "<p class=\"cline small\">Aucun itinéraire gardé pour l’instant.</p>";
  const pick = list.filter(r => bookPick.has(r.id) && r.facts);
  if (pick.length < 2) { $('bookCmp').innerHTML = pick.length ? '<p class="cline small">Coche un deuxième itinéraire pour comparer.</p>' : ''; return; }
  // each row: the value of every itinerary, the lowest one highlighted
  const rows = [['Distance', f => f.dist, v => `${km(v)} km`], ['Temps de marche', f => f.hours, hm], ['Dénivelé +', f => f.up, v => `${fmt(v)} m`], ['Dénivelé −', f => f.down, v => `${fmt(v)} m`],
    ['Point haut', f => f.max, v => `${fmt(v)} m`], ['Raideur max du tracé', f => f.steepDeg, v => `${Math.round(v)}°`], ['Traverse des pentes ≥ 30°', f => f.steep30, v => `${fmt(v)} m`]];
  $('bookCmp').innerHTML = `<h3>Comparaison</h3><div class="tw"><table class="cmp"><thead><tr><th></th>${pick.map(r => `<th>${esc(r.name)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([label, get, show]) => { const vals = pick.map(r => get(r.facts)), lo = Math.min(...vals); return `<tr><th>${label}</th>${vals.map(v => `<td class="${v === lo && vals.some(x => x !== lo) ? 'best' : ''}">${show(v)}</td>`).join('')}</tr>`; }).join('')}
    <tr><th>Jours</th>${pick.map(r => `<td>${(r.nights?.length ?? 0) + 1}</td>`).join('')}</tr></tbody></table></div>
    <p class="cnote">En bleu : la valeur la plus basse de la ligne. Temps DIN 33466 sans pauses, relief LiDAR IGN au moment où l'itinéraire a été gardé${pick.some(r => !r.facts.complete) ? ' (relief partiel pour certains)' : ''}.</p>`;
}
$('bookSave').addEventListener('click', () => {
  const f = routeFacts(route.samples, (x, z) => engine.slopeAt(x, z));
  if (!f) { toast('Relief pas encore chargé sous le tracé : attends un instant.', true); return; }
  const list = loadBook(), ll = route.pts.map(([x, z]) => worldToLonLat(x, z).map(v => +v.toFixed(6))), name = route.name || 'Mon itinéraire';
  const same = list.findIndex(r => r.name === name && r.ll.length === ll.length);
  const entry = { id: same >= 0 ? list[same].id : Date.now().toString(36), name, ll, ends: route.ends, keep: route.keep, nights: route.nights, net: netString(route.net), facts: f, saved: Date.now() };
  if (same >= 0) list[same] = entry; else list.unshift(entry);
  if (!saveBook(list)) { toast("Mémoire de l'appareil pleine : itinéraire non gardé.", true); return; }
  toast(same >= 0 ? 'Itinéraire mis à jour dans « Mes itinéraires ».' : 'Gardé dans « Mes itinéraires » (Rando).'); renderBook();
});
$('bookOut').addEventListener('click', e => {
  const open = e.target.closest('[data-open]'), del = e.target.closest('[data-del]');
  if (open) {
    const r = loadBook().find(x => x.id === open.dataset.open); if (!r) return;
    route.setPath(r.ll.map(([lon, lat]) => lonLatToWorld(lon, lat)), r.name, r.nights ?? []); if (r.net?.length === r.ll.length) route.net = [...r.net].map(Number); route.ends = r.ends ?? []; route.keep = r.keep ?? 0; route.save();
    routeReady(`« ${r.name} » ouvert`);
  }
  if (del) {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Confirmer'; setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Supprimer'; }, 4000); return; }
    saveBook(loadBook().filter(x => x.id !== del.dataset.del)); bookPick.delete(del.dataset.del); renderBook();
  }
});
$('bookOut').addEventListener('change', e => {
  const c = e.target.closest('[data-cmp]'); if (!c) return;
  if (c.checked) { if (bookPick.size >= 3) { c.checked = false; toast('Trois itinéraires au plus à la fois.', true); return; } bookPick.add(c.dataset.cmp); } else bookPick.delete(c.dataset.cmp);
  renderBook();
});
renderBook();
// several days: the huts within 250 m of the line, and the steps drawn, can each be a night; the numbers per day follow
function renderDays() {
  const S = route.samples; if (S.length < 2) { $('daysOut').innerHTML = ''; return; }
  let acc = 0; const dAt = []; route.pts.forEach((p, i) => { if (i) acc += Math.hypot(p[0] - route.pts[i - 1][0], p[1] - route.pts[i - 1][1]); dAt.push(acc); });
  const total = S[S.length - 1].d, spots = nightSpots(S, PLACES);
  route.ends.slice(1, -1).forEach((e, k) => { const d = dAt[e]; if (!spots.some(s => Math.abs(s.d - d) < 300)) spots.push({ d, name: `Étape ${k + 2} du tracé`, alt: groundAt(...route.pts[e]) }); });
  spots.sort((a, b) => a.d - b.d);
  const nights = route.nights.filter(n => n < total);
  $('daysCnt').textContent = nights.length ? `${nights.length + 1} jours` : '';
  const days = stages(S, nights);
  $('daysOut').innerHTML = (spots.length ? `<p class="cline small">Coche où tu dors : refuges et abris à moins de 250 m du tracé (et les étapes que tu as posées).</p><div class="days">${spots.map(s => `<label class="night"><input type="checkbox" data-night="${s.d.toFixed(0)}" ${nights.some(n => Math.abs(n - Math.round(s.d)) < 1) ? 'checked' : ''}><span>${esc(s.name)}${s.alt ? ` · ${fmt(s.alt)} m` : ''} <span class="small">· km ${km(s.d)}</span></span></label>`).join('')}</div>`
    : "<p class=\"cline small\">Pas de refuge ni d’abri à moins de 250 m du tracé : pour une sortie de plusieurs jours, trace-la en posant une étape à chaque nuit.</p>")
    + (days.length > 1 ? `<div class="tw"><table><thead><tr><th></th><th class="n">km</th><th class="n">D+</th><th class="n">D−</th><th class="n">Temps</th></tr></thead><tbody>${days.map((d, i) => `<tr><th>Jour ${i + 1}</th><td class="n">${km(d.dist)}</td><td class="n">${fmt(d.up)}</td><td class="n">${fmt(d.down)}</td><td class="n">${hm(d.hours)}</td></tr>`).join('')}</tbody></table></div>` : '');
}
$('daysOut').addEventListener('change', e => {
  const c = e.target.closest('[data-night]'); if (!c) return;
  const d = +c.dataset.night; route.nights = c.checked ? [...route.nights.filter(n => Math.abs(n - d) >= 1), d] : route.nights.filter(n => Math.abs(n - d) >= 1);
  route.save(); renderDays();
});
// when to leave: forecast at the highest point (Météo-France) and daylight; asked when the section is opened
$('d-when').addEventListener('toggle', async () => {
  if (!$('d-when').open || $('whenOut').dataset.key === routeKey) return;
  const S = route.samples, hi = S.reduce((b, s) => (s.h != null && s.h > (b?.h ?? -Infinity) ? s : b), null);
  if (!hi) { $('whenOut').innerHTML = '<p class="cline small">Relief pas encore chargé sous le tracé.</p>'; return; }
  $('whenOut').innerHTML = '<p class="cmeta">Prévision au point haut…</p>';
  try {
    const [lon, lat] = worldToLonLat(hi.x, hi.z), f = await pointForecast(lat, lon, hi.h), w = whenToLeave(S, f.hourly, lat, lon);
    const lines = w.days.map((d, k) => {
      const name = k ? 'Demain' : "Aujourd'hui", bad = d.bad ? (WMO[d.bad.code] || 'mauvais temps').toLowerCase() : '';
      const reason = d.reason === 'weather' ? `pour être au point haut une heure avant « ${bad} » prévu vers ${hhmm(d.bad.at)}` : `pour rentrer avant le coucher du soleil (${hhmm(d.set)})`;
      if (!d.ok) return `<p class="cline"><b>${name}</b> : pas assez de temps${d.bad && d.bad.at < d.earliest ? ` (${bad} prévu dès ${hhmm(d.bad.at)})` : k === 0 ? " (trop tard pour partir aujourd’hui)" : ''}.</p>`;
      return `<p class="cline"><b>${name}</b> : départ entre <b>${hhmm(d.earliest)}</b>${+d.earliest === +d.rise ? ' (lever du soleil)' : ''} et <b>${hhmm(d.latest)}</b>, ${reason}.</p>`;
    });
    $('whenOut').innerHTML = lines.join('') + `<p class="cnote">Point haut ${fmt(w.hiAlt)} m atteint en ${hm(w.toTop)}, itinéraire complet en ${hm(w.total)} : temps DIN 33466 sans pauses (ajoute les tiennes). Prévision Météo-France au point haut, reçue à ${hhmm(new Date())} ; les orages de montagne arrivent souvent plus tôt que prévu.</p>`;
    $('whenOut').dataset.key = routeKey;
  } catch (e) { $('whenOut').innerHTML = `<p class="cline">Prévision indisponible (${esc(why(e))}).</p>`; }
});

// ---------- weather along the way: the forecast at each point at the hour one walks by ----------
// Points: the start, then one per hour of walking, the highest point and the end; the hour at each from the chosen
// start and the DIN walking time (no breaks, no time on lifts). One request for all the points, each at its altitude.
const rwx = { key: null, pts: null, fc: null, at: null, got: null };
const pad2 = n => String(n).padStart(2, '0');
const localInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function rwxPoints() {
  const S = route.samples; if (S.length < 2 || S.some(s => s.h == null)) return null;
  const hoursAt = i => pathStats(S.slice(0, i + 1))?.hours ?? 0, hi = S.reduce((b, s, i) => s.h > S[b].h ? i : b, 0);
  const out = [{ i: 0, what: 'Départ' }];
  let next = 1;
  for (let i = 25; i < S.length - 1; i += 25) { const h = hoursAt(i); if (h >= next) { out.push({ i, what: `${next} h de marche` }); next = Math.floor(h) + 1; } }
  if (hi > 0 && hi < S.length - 1) out.push({ i: hi, what: 'Point haut' });
  out.push({ i: S.length - 1, what: 'Arrivée' });
  return out.sort((a, b) => a.i - b.i).filter((p, k, a) => !k || p.i - a[k - 1].i > 10 || p.what === 'Point haut')
    .map(p => { const s = S[p.i], [lon, lat] = worldToLonLat(s.x, s.z); return { ...p, d: s.d, alt: s.h, lat, lon, hours: hoursAt(p.i) }; });
}
async function renderRouteWeather() {
  if (!$('d-rwx').open) return;
  if (rwx.key !== routeKey) {
    rwx.pts = rwxPoints();
    if (!rwx.pts) { $('rwxOut').innerHTML = '<p class="cline small">Relief pas encore chargé sous le tracé.</p>'; return; }
    $('rwxOut').innerHTML = '<p class="cmeta">Prévision aux points de passage…</p>';
    try { rwx.fc = await routeForecast(rwx.pts); rwx.got = new Date(); rwx.key = routeKey; }
    catch (e) { $('rwxOut').innerHTML = `<p class="cline">Prévision indisponible (${esc(why(e))}).</p>`; return; }
  }
  const start = new Date($('rwxAt').value || Date.now());
  let worst = null; const flag = (lvl, txt) => { if (!worst || lvl > worst.lvl) worst = { lvl, txt }; };
  const rows = rwx.pts.map((p, k) => {
    const at = new Date(+start + p.hours * 3600e3), h = rwx.fc[k], r = new Date(+at + 30 * 60e3); // the nearest forecast hour
    const key = `${r.getFullYear()}-${pad2(r.getMonth() + 1)}-${pad2(r.getDate())}T${pad2(r.getHours())}:00`, j = h.time.indexOf(key);
    const where = `<th>${esc(p.what)}<br><span class="small">${hhmm(at)} · km ${km(p.d)} · ${fmt(p.alt)} m</span></th>`;
    if (j < 0 || h.temperature_2m[j] == null) return `<tr>${where}<td colspan="3" class="small">au-delà de la prévision</td></tr>`;
    const code = h.weather_code[j], pr = h.precipitation[j] ?? 0, sn = h.snowfall[j] ?? 0, t = h.temperature_2m[j], w = h.wind_speed_10m[j], g = h.wind_gusts_10m[j];
    const storm = code >= 95, wet = pr >= 0.3 || (code >= 51 && code < 95), windy = g >= 60, cold = t <= 0;
    if (storm) flag(3, `orage prévu vers ${hhmm(at)} (${esc(p.what.toLowerCase())})`);
    else if (wet) flag(2, `${sn > 0.1 ? 'neige' : 'pluie'} prévue vers ${hhmm(at)} (${fmt(p.alt)} m)`);
    if (windy) flag(windy && g >= 80 ? 2.5 : 1.5, `rafales à ${fmt(g)} km/h vers ${hhmm(at)} (${fmt(p.alt)} m)`);
    if (cold) flag(1, `${t1(t)} °C vers ${hhmm(at)} (${fmt(p.alt)} m)`);
    return `<tr>${where}<td class="${storm ? 'bad' : wet ? 'warn' : ''}">${esc(WMO[code] ?? '—')}${pr >= 0.1 ? `<br><span class="small">${t1(pr)} mm${sn > 0.1 ? ` (${t1(sn)} cm de neige)` : ''}</span>` : ''}</td>
      <td class="n${cold ? ' cold' : ''}">${t1(t)} °C</td><td class="n${windy ? ' warn' : ''}">${fmt(w)}<br><span class="small">raf. ${fmt(g)}</span></td></tr>`;
  });
  $('rwxOut').innerHTML = `<p class="cline">${worst ? `<b>À surveiller :</b> ${worst.txt}.` : 'Rien de marquant prévu sur le trajet (ni pluie, ni orage, ni rafales de 60 km/h, ni gel).'}</p>
    <div class="tw"><table class="cmp rwx"><thead><tr><th>Passage</th><th>Ciel</th><th class="n">Temp.</th><th class="n">Vent km/h</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <p class="cnote">Prévision Météo-France (modèles AROME et ARPEGE, via Open-Meteo) à l'altitude de chaque point, reçue à ${hhmm(rwx.got)}. Heures de passage selon la norme DIN 33466, sans pauses${route.stats()?.ride ? ' ni temps en remontée' : ''} : ajoute les tiennes. Le vent est celui à 10 m du sol, plus fort sur les crêtes.</p>`;
}
$('d-rwx').addEventListener('toggle', () => {
  if (!$('d-rwx').open) return;
  // start: the value chosen before, or the next full hour
  if (!$('rwxAt').value) { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); $('rwxAt').value = localInput(d); }
  renderRouteWeather();
});
$('rwxAt').addEventListener('change', renderRouteWeather);

// ---------- guidance at the forks (guide.js): the list, and the instruction said ahead during an outing ----------
// mode: off, vibrate, or vibrate and speak (French voice of the phone). The forks are worked out again while the
// paths along the line keep arriving (up to 10 times, every 20 s).
const guide = { key: null, list: [], at: 0, tries: 0, said: new Set(), mode: (() => { try { return localStorage.getItem('midi3d-guide') || 'vibe'; } catch { return 'vibe'; } })() };
function guideList() {
  if (route.samples.length < 3) return [];
  if (guide.key !== routeKey || (guide.tries < 10 && Date.now() - guide.at > 20e3)) {
    if (guide.key !== routeKey) guide.tries = 0;
    const places = [...PLACES.filter(p => p.name && !p.area && !p.cam && !p.nivo), ...[...lakes.lakes.values()].filter(l => l.name).map(l => ({ name: l.name, x: l.cx, z: l.cz }))];
    guide.list = junctions(route.samples, trails.ways(), places); guide.key = routeKey; guide.at = Date.now(); guide.tries++;
  }
  return guide.list;
}
function renderGuide() {
  document.querySelectorAll('[data-guide]').forEach(b => b.classList.toggle('on', b.dataset.guide === guide.mode));
  if (!$('d-guide').open) return;
  const list = guideList(); $('guideCnt').textContent = list.length ? `(${list.length})` : '';
  $('guideOut').innerHTML = (list.length ? `<ol class="road">${list.map(j => `<li><b>km ${km(j.d)}</b> ${esc(j.text)}${j.toward ? `, direction ${esc(j.toward)}` : ''}</li>`).join('')}</ol>`
    : '<p class="cline small">Aucun croisement de sentiers sur le tracé (ou sentiers pas encore chargés).</p>')
    + `<p class="cnote">Croisements des sentiers et chemins de la BD TOPO IGN sur le tracé (pas ceux avec les routes). Pendant la sortie, avec ta position, la consigne vient environ 60 m avant chaque croisement${guide.mode === 'voice' ? ', à voix haute' : guide.mode === 'vibe' ? ', avec le vibreur' : ' (guidage désactivé)'}. Regarde toujours les panneaux.</p>`;
}
$('d-guide').addEventListener('toggle', renderGuide);
document.querySelectorAll('[data-guide]').forEach(b => b.addEventListener('click', () => {
  guide.mode = b.dataset.guide; try { localStorage.setItem('midi3d-guide', guide.mode); } catch { }
  // the voice speaks once now: phones only let a page speak after a touch
  if (guide.mode === 'voice') speak('Guidage vocal activé.');
  toast(guide.mode === 'off' ? 'Guidage désactivé.' : guide.mode === 'voice' ? 'Guidage à voix haute aux croisements.' : 'Guidage avec le vibreur aux croisements.');
  renderGuide();
}));
function speak(text) {
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'fr-FR'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { }
}
// on each GPS fix on the itinerary: the next fork within 70 m is said once
function guideFix(prog) {
  if (guide.mode === 'off' || !prog || prog.off > 60) return null;
  const next = guideList().find(j => j.d > prog.done - 3); if (!next) return null;
  const left = next.d - prog.done;
  if (left < 70 && !guide.said.has(next.d)) {
    guide.said.add(next.d);
    const text = say(next, Math.max(10, Math.round(left / 10) * 10));
    toast(text, false, 7000); buzz([90, 70, 90]); if (guide.mode === 'voice') speak(text);
  }
  return { j: next, left };
}

// ---------- the outing planned for a day (planned.js): kept, checked when the app opens, reminders ----------
let planned = loadPlanned();
const plannedLink = () => `${location.origin}${location.pathname}?site=${planned?.site ?? SITE.id}&sortie=1`;
const dayWord = d => { const t = new Date(); t.setHours(0, 0, 0, 0); const k = Math.round((new Date(d).setHours(0, 0, 0, 0) - t) / 864e5); return k === 0 ? "aujourd'hui" : k === 1 ? 'demain' : k === -1 ? 'hier' : `le ${new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`; };
$('d-plan2').addEventListener('toggle', () => {
  if (!$('d-plan2').open) return;
  if (!$('pvDate').value) { const d = new Date(); d.setDate(d.getDate() + 1); $('pvDate').value = isoDay(d); }
  $('pvRemind').checked = !!planned?.remind;
  $('pvInfo').innerHTML = `<p class="cnote">Gardée sur l'appareil. À chaque ouverture de l'appli les jours d'avant, la sortie est revérifiée : prévision Météo-France à son point haut pour les heures de marche, orages, bulletin d'avalanche. Avec les rappels, ton téléphone reçoit un message la veille à 19 h et une heure avant le départ, par l'application gratuite ntfy (un site web ne peut pas se réveiller seul à une heure donnée) : le message te dit d'ouvrir l'appli, qui vérifie alors.</p>`;
});
$('pvSave').addEventListener('click', async () => {
  const st = route.stats(); if (!st || route.samples.length < 2) { toast("Charge d'abord un itinéraire.", true); return; }
  if (!$('pvDate').value) { toast('Choisis le jour.', true); return; }
  const S = route.samples, hi = S.reduce((b, s) => (s.h != null && s.h > (b?.h ?? -Infinity) ? s : b), null), [hlon, hlat] = worldToLonLat(hi.x, hi.z);
  const old = planned;
  planned = {
    name: route.name || 'Ma sortie', site: SITE.id, date: $('pvDate').value, start: $('pvTime').value || '07:00', hours: st.hours,
    ll: route.pts.map(([x, z]) => worldToLonLat(x, z).map(v => +v.toFixed(6))), net: netString(route.net), hi: { lon: hlon, lat: hlat, alt: hi.h },
    remind: $('pvRemind').checked, reminders: []
  };
  if (leaveAt(planned) < Date.now()) { planned = old; toast('Ce départ est déjà passé.', true); return; }
  $('pvSave').disabled = true;
  await cancelReminders(old);
  let note = '';
  if (planned.remind) {
    try {
      const r = await scheduleReminders(planned, plannedLink()); planned.reminders = r.sent;
      note = r.sent.length ? `${r.sent.length} rappel${r.sent.length > 1 ? 's' : ''} programmé${r.sent.length > 1 ? 's' : ''}.` : 'Les rappels seront programmés à une ouverture de l\'appli dans les 3 jours avant (ntfy les garde 3 jours au plus).';
    } catch (e) { note = `Rappels impossibles (${why(e)}) : réessaie plus tard.`; }
  }
  savePlanned(planned); $('pvSave').disabled = false;
  toast(`Sortie prévue ${dayWord(leaveAt(planned))} à ${planned.start}. ${note}`, false, 6000);
  renderReminderHelp(note); checkPlanned();
});
function renderReminderHelp(note = '') {
  const t = reminderTopic(); if (!planned?.remind || !t) { $('pvInfo').innerHTML = note ? `<p class="cline small">${esc(note)}</p>` : ''; return; }
  $('pvInfo').innerHTML = `<p class="cline small">${esc(note)}</p><p class="cline small">Pour recevoir les rappels : installe l'application <b>ntfy</b> (Android ou iPhone, gratuite), puis abonne-toi au canal <b class="mono">${esc(t)}</b> (bouton +, serveur ntfy.sh). Ce canal est propre à ce téléphone : garde-le pour toi.</p>
    <button type="button" class="mini wide" data-copy-topic>Copier le nom du canal</button>`;
}
$('pvInfo').addEventListener('click', e => { if (e.target.closest('[data-copy-topic]')) navigator.clipboard?.writeText(reminderTopic()).then(() => toast('Nom du canal copié.'), () => toast('Copie impossible : recopie-le à la main.', true)); });
// the check: forecast at the highest point for the hours of the outing (from 3 days before), avalanche bulletin
async function checkPlanned() {
  if (!planned) { $('plannedCard').hidden = true; return; }
  const leave = leaveAt(planned), end = new Date(+leave + (planned.hours || 4) * 3600e3);
  if (end < Date.now() - 6 * 3600e3) { await cancelReminders(planned); planned = null; savePlanned(null); $('plannedCard').hidden = true; return; } // over
  // reminders asked for but not scheduled yet (the outing was more than 3 days ahead): now
  if (planned.remind && !planned.reminders?.length && leave - Date.now() < 3 * 864e5) {
    try { const r = await scheduleReminders(planned, plannedLink()); planned.reminders = r.sent; savePlanned(planned); } catch { }
  }
  const head = `<p class="rname">Sortie prévue ${dayWord(leave)} à ${esc(planned.start)}</p><p class="cline"><b>${esc(planned.name)}</b> · point haut ${fmt(planned.hi.alt)} m · ${hm(planned.hours)} de marche</p>`;
  const open = `<button type="button" class="mini wide" data-open-planned>Ouvrir l'itinéraire</button><button type="button" class="mini wide" data-drop-planned>Annuler la sortie prévue</button>`;
  $('plannedCard').hidden = false;
  if (leave - Date.now() > 3 * 864e5) { $('plannedCard').innerHTML = `${head}<p class="cline small">La prévision au point haut sera là 3 jours avant.</p>${open}`; return; }
  $('plannedCard').innerHTML = `${head}<p class="cmeta">Vérification de la météo…</p>${open}`;
  const bits = [];
  try {
    const [h] = await routeForecast([planned.hi]);
    let storm = null, wet = null, gust = 0, tmin = Infinity;
    h.time.forEach((t, i) => {
      const at = new Date(t); if (at < +leave - 1800e3 || at > +end + 1800e3) return;
      if (h.weather_code[i] >= 95 && !storm) storm = at;
      if ((h.precipitation[i] >= 0.3 || (h.weather_code[i] >= 51 && h.weather_code[i] < 95)) && !wet) wet = { at, snow: (h.snowfall[i] ?? 0) > 0.1 };
      gust = Math.max(gust, h.wind_gusts_10m[i] ?? 0); tmin = Math.min(tmin, h.temperature_2m[i] ?? Infinity);
    });
    if (storm) bits.push(`<span class="bad">Orage prévu vers ${hhmm(storm)}</span>`);
    if (wet) bits.push(`<span class="warn">${wet.snow ? 'Neige' : 'Pluie'} prévue vers ${hhmm(wet.at)}</span>`);
    if (gust >= 60) bits.push(`<span class="warn">Rafales jusqu'à ${fmt(gust)} km/h</span>`);
    if (tmin <= 0) bits.push(`Jusqu'à ${t1(tmin)} °C`);
    if (!bits.length) bits.push('Rien de marquant prévu au point haut pendant la sortie');
  } catch (e) { bits.push(`Prévision indisponible (${esc(why(e))})`); }
  let beraTxt = '';
  if (planned.site === SITE.id && state.bera) {
    const b = state.bera, covers = b.validUntil >= +leave - 6 * 3600e3;
    const when = b.issued.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    beraTxt = covers ? beraAtText(planned.hi.alt)
      : Date.now() - b.validUntil > 3 * 864e5 ? `<p class="cline small">Pas de bulletin d'avalanche en cours (le dernier date du ${when}).</p>`
      : `<p class="cline small">Bulletin d'avalanche du ${when} : il ne couvre pas encore ce jour (le suivant paraît vers 16 h la veille).</p>`;
  }
  $('plannedCard').innerHTML = `${head}<p class="cline">${bits.join(' · ')}.</p>${beraTxt}<p class="cnote">Prévision Météo-France au point haut (${fmt(planned.hi.alt)} m) pour ${hhmm(leave)}–${hhmm(end)}, vérifiée à ${hhmm(new Date())}.</p>${open}`;
  return bits;
}
$('plannedCard').addEventListener('click', async e => {
  if (e.target.closest('[data-open-planned]')) {
    if (planned.site !== SITE.id) { location.href = plannedLink(); return; }
    route.setPath(planned.ll.map(([lon, lat]) => lonLatToWorld(lon, lat)), planned.name, [], planned.net?.length === planned.ll.length ? [...planned.net].map(Number) : false);
    routeReady(`« ${planned.name} » ouvert`);
  }
  if (e.target.closest('[data-drop-planned]')) { await cancelReminders(planned); planned = null; savePlanned(null); $('plannedCard').hidden = true; toast('Sortie prévue annulée (et ses rappels).'); }
});
// at opening: checked, and said when it is today or tomorrow (or when the app was opened from a reminder)
setTimeout(async () => {
  if (!planned) return;
  const bits = await checkPlanned(), leave = planned && leaveAt(planned);
  if (!planned || !bits) return;
  const fromReminder = new URLSearchParams(location.search).has('sortie');
  if (fromReminder) openSheet('route', true);
  if (fromReminder || leave - Date.now() < 36 * 3600e3) toast(`Sortie ${dayWord(leave)} (${planned.name}) : ${bits.map(b => b.replace(/<[^>]+>/g, '')).join(' · ')}.`, false, 8000);
}, 4000);

// ---------- snow measured at the mountain stations, webcams (daily copies in data/, see scripts/) ----------
// Météo-France's nivo-meteorological network: the latest measure of each station near the view, with its date;
// stations of the last 4 days also as labels on the map. Mostly winter: off season the dates say how old it is.
const nivo = { data: null, ids: new Set() };
const kmTo = (lat, lon) => { const [tl, ta] = worldToLonLat(controls.target.x, controls.target.z), r = Math.PI / 180; return Math.hypot((lon - tl) * Math.cos(lat * r), lat - ta) * 111.2; };
fetch('data/nivo.json').then(r => r.ok ? r.json() : null).catch(() => null).then(d => { nivo.data = d; renderNivo(); nivoLabels(); });
function renderNivo() {
  const d = nivo.data, el = $('nivo');
  if (!d) { el.innerHTML = '<p class="cline small">Mesures indisponibles (pas encore copiées, ou hors ligne sans copie).</p>'; return; }
  const near = d.stations.filter(s => s.lat != null).map(s => ({ ...s, km: kmTo(s.lat, s.lon), at: new Date(s.time) })).filter(s => s.km < 40).sort((a, b) => a.km - b.km).slice(0, 8);
  if (!near.length) { el.innerHTML = '<p class="cline small">Pas de station de mesure de la neige à moins de 40 km de la vue.</p>'; return; }
  el.innerHTML = `<div class="tw"><table class="cmp"><thead><tr><th>Station</th><th class="n">Neige</th><th class="n">Fraîche</th><th class="n">Mesure</th></tr></thead><tbody>${near.map(s => {
    const old = Date.now() - s.at > 3 * 864e5;
    return `<tr><th>${esc(s.name)}<br><span class="small">${s.alt != null ? fmt(s.alt) + ' m · ' : ''}${t1(s.km)} km</span></th><td class="n"><b>${s.snow_cm} cm</b></td><td class="n">${s.fresh_cm != null ? s.fresh_cm + ' cm' : '—'}</td><td class="n${old ? ' stale' : ''}">${s.at.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}${old ? '' : ' ' + hhmm(s.at)}</td></tr>`;
  }).join('')}</tbody></table></div>
    <p class="cnote">Mesures au sol des stations de montagne du réseau nivo-météorologique (Météo-France et ses partenaires), surtout en hiver ; en orange, une mesure de plus de 3 jours. Une station mesure la neige à son endroit seulement (souvent un domaine skiable, à plat). ${esc(d.source)}, copie du ${new Date(d.fetched + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}.</p>`;
}
$('tab-cond').addEventListener('click', renderNivo); // the stations nearest to wherever the view is now
function nivoLabels() {
  for (const s of nivo.data?.stations ?? []) {
    if (s.lat == null || Date.now() - new Date(s.time) > 4 * 864e5 || nivo.ids.has(s.name)) continue; nivo.ids.add(s.name);
    const [x, z] = lonLatToWorld(s.lon, s.lat), p = { name: s.name, alt: s.alt, x, z, h: s.alt ?? 1500, small: true, nivo: s };
    const el = document.createElement('button'); el.type = 'button'; el.className = 'label small nivo hidden';
    el.innerHTML = `<span class="t"><span class="n">❄ ${esc(s.name)}</span><span class="h">${s.snow_cm} cm</span></span>`;
    el.addEventListener('click', () => openPlace(p));
    labelsEl.appendChild(el); p.el = el; PLACES.push(p);
  }
}
// webcams mapped in OpenStreetMap: their own page opens (the pictures belong to their owners)
const camName = (c) => c.name || (() => { try { const u = new URL(c.url); return `${u.hostname.replace(/^(www|m|app)\./, '').split('.')[0]} · ${decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]/g, ' ')}`.trim(); } catch { return 'Webcam'; } })();
fetch(`data/webcams-${SITE.id}.json`).then(r => r.ok ? r.json() : null).catch(() => null).then(d => {
  for (const c of d?.webcams ?? []) {
    const [x, z] = lonLatToWorld(c.lon, c.lat), p = { name: camName(c), x, z, h: groundAt(x, z) ?? 1500, small: true, cam: c.url };
    const el = document.createElement('button'); el.type = 'button'; el.className = 'label small cam hidden';
    el.innerHTML = `<span class="t"><span class="n">📷 ${esc(p.name)}</span></span>`; el.title = 'Ouvrir la webcam';
    el.addEventListener('click', () => openPlace(p));
    labelsEl.appendChild(el); p.el = el; PLACES.push(p);
  }
});
state.webcams = true; $('c-webcams').addEventListener('change', e => { state.webcams = e.target.checked; });

// ---------- sharing my position live, following someone's (share.js) ----------
const liveShare = new LiveShare(renderShare);
let shareWake = null;
try { $('shareName').value = localStorage.getItem('midi3d-share-name') || ''; } catch { }
const followBase = () => `${location.origin}${location.pathname}?site=${SITE.id}`;
function renderShare() {
  const on = liveShare.on, s = liveShare.state;
  $('shareGo').hidden = on; $('shareName').disabled = on; $('shareOn').hidden = !on; $('shareCnt').textContent = on ? 'en cours' : '';
  if (on) {
    const last = s.last ? `dernier envoi ${ago2(s.last.t)}` : gps.pos ? 'premier envoi en cours…' : 'en attente de ta position GPS…';
    $('shareInfo').innerHTML = `<b>Partage en cours</b> · ${last} · ${s.sent} envoi${s.sent > 1 ? 's' : ''} aujourd'hui (limite du service : 250)${s.error ? ` · <span class="stale">échec du dernier envoi : ${esc(s.error)}</span>` : ''} · s'arrête à ${hhmm(new Date(s.until))}.`;
    $('shareLink').textContent = liveShare.link(followBase());
    if (!shareWake) navigator.wakeLock?.request('screen').then(w => { shareWake = w; w.addEventListener('release', () => { shareWake = null; }); }).catch(() => { });
  } else { shareWake?.release().catch(() => { }); shareWake = null; }
  renderTrip();
}
$('shareGo').addEventListener('click', () => {
  const name = $('shareName').value.trim(); try { localStorage.setItem('midi3d-share-name', name); } catch { }
  liveShare.start(name); if (!gps.on) { gpsCentered = false; gps.start(); } else if (gps.pos) liveShare.fix(gps.pos);
  toast("Partage démarré : envoie maintenant le lien à ton proche.", false, 4000);
});
$('shareStop').addEventListener('click', async () => { await liveShare.stop(); toast('Partage arrêté : ton proche voit « partage terminé ».'); });
$('shareSend').addEventListener('click', async () => {
  const url = liveShare.link(followBase()), text = `Suis ma position en montagne en direct${liveShare.state.name ? ` (${liveShare.state.name})` : ''} :`;
  try { if (navigator.share) { await navigator.share({ title: 'Ma position en direct', text, url }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Lien copié : colle-le dans un message.'); } catch { toast('Copie impossible : le lien est affiché sous les boutons.', true); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && liveShare.on) renderShare(); });
renderShare();
// someone else's position, from a shared link (?suivre=…): a marker and the way walked, and a card with the news
const followChannel = new URLSearchParams(location.search).get('suivre');
const follow = /^m3d-[a-z0-9]{10,40}$/.test(followChannel ?? '') ? new LiveFollow({ scene, channel: followChannel, onChange: renderFollow }) : null;
let followFlown = false;
function renderFollow() {
  const f = follow, p = f.last, card = $('followCard');
  if (!p) { card.innerHTML = f.error ? `Suivi : pas de réponse du service (${esc(f.error)}), nouvel essai dans 30 s.` : f.ended ? `Le partage de position de <b>${esc(f.name ?? '')}</b> est terminé.` : "Suivi d'une position partagée : en attente d'un premier envoi…"; card.hidden = false; return; }
  const age = (Date.now() - p.t) / 60e3;
  card.innerHTML = `<div><b>${esc(p.name || 'Position partagée')}</b> · vu ${ago2(p.t)}${p.alt != null ? ` · ${fmt(p.alt)} m` : ''} · ±${fmt(p.acc)} m${p.batt != null ? ` · batterie ${p.batt} %` : ''}</div>`
    + (f.ended ? '<div>Partage terminé.</div>' : age > 15 ? `<div class="warn">Pas de nouvelle position depuis ${Math.round(age)} min (pas de réseau là-haut, ou écran verrouillé).</div>` : '')
    + `<button type="button" class="mini" id="followGo">Centrer sur ${esc(p.name || 'la position')}</button>`;
  card.hidden = false;
  $('followGo').onclick = () => flyToLonLat(p.lon, p.lat);
  if (!followFlown && started) { followFlown = true; flyToLonLat(p.lon, p.lat); pin = null; } // (before the relief is there, the opening view takes it: see drawFrame)
}
if (follow) setInterval(() => { if (follow.last) renderFollow(); }, 30e3); // "vu il y a…" keeps counting
// the steps on screen: start (D), steps, end (A), and the touches still being worked out
const marks = { els: [], n: 0 };
function updateRouteMarks() {
  const st = route.pts.length && !sight.on ? route.steps : [];
  // while drawing every step is shown; otherwise only the start and the end
  const list = (route.drawing ? st : st.length > 1 ? [st[0], st[st.length - 1]] : st).map((p, i, a) => ({ x: p[0], z: p[1], k: i === 0 ? 'start' : i === a.length - 1 ? 'end' : '' }));
  const steps = list.length;
  if (draw.on) for (const m of draw.pending) list.push({ x: m.x, z: m.z, k: 'pending' });
  const w = stage.clientWidth, h = stage.clientHeight;
  while (marks.els.length < list.length) { const el = document.createElement('i'); $('routeMarks').appendChild(el); marks.els.push(el); }
  marks.els.forEach((el, i) => {
    const m = list[i]; if (!m) { if (el.className !== 'rmark hidden') el.className = 'rmark hidden'; return; }
    proj.set(m.x, (groundAt(m.x, m.z) ?? 0) * state.exag, m.z).project(camera);
    const on = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
    const cls = ['rmark', m.k, on ? '' : 'hidden'].filter(Boolean).join(' ');
    // the step just added pops up: the touch was taken
    if (i === steps - 1 && steps > marks.n && route.drawing) { el.className = cls; void el.offsetWidth; el.className = cls + ' pop'; }
    else if (el.className.replace(/ pop$/, '') !== cls) el.className = cls;
    const txt = m.k === 'start' ? 'D' : m.k === 'end' ? 'A' : ''; if (el.textContent !== txt) el.textContent = txt;
    if (on) el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px, ${(-proj.y * 0.5 + 0.5) * h}px)`;
  });
  marks.n = steps;
}
// fly to see the whole itinerary
function frameRoute() {
  const xs = route.pts.map(p => p[0]), zs = route.pts.map(p => p[1]); if (!xs.length) return;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 800);
  engine.ensureRoots(cx, cz, 45000);
  const t = new THREE.Vector3(cx, (groundAt(cx, cz) ?? controls.target.y) * state.exag, cz);
  startFly(t, t.clone().add(new THREE.Vector3(-0.5, 0.75, 0.9).normalize().multiplyScalar(ext * 1.3)), 2400);
}

// ---------- itinerary proposals (planner.js): from a start to a destination, or ideas around the start ----------
const plan = { from: null, to: null, waitGps: false }; // from null = my position
const llName = p => p.name ?? `${p.lat.toFixed(4)}° N, ${p.lon.toFixed(4)}° E`;
function planStart() { return plan.from ?? (gps.pos ? { lon: gps.pos.lon, lat: gps.pos.lat, name: 'ma position' } : null); }
function renderPlan() {
  $('plFrom').textContent = plan.from ? llName(plan.from) : gps.pos ? 'ma position' : gps.on ? 'ma position (recherche du GPS…)' : 'ma position (localisation à activer, ou choisis un autre départ)';
  $('plTo').textContent = plan.to ? llName(plan.to) : 'à choisir';
}
// the chosen value blinks: the choice was taken
const flashEl = id => { const el = $(id); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };
// back to the planner in "Rando", opened, after a point was chosen on the map
function showPlanner() { openSheet('route', true); $('d-plan').open = true; $('d-plan').scrollIntoView({ block: 'nearest' }); }
// as soon as both ends are known, the itinerary is computed: nothing more to press
function planMaybe() {
  if (!plan.to) return;
  const from = planStart();
  if (from) { planGo(from, plan.to); return; }
  // the start is "my position", not known yet: computed when the GPS answers
  plan.waitGps = true; if (!gps.on) { gpsCentered = true; gps.start(); }
  $('plNote').textContent = 'En attente de ta position GPS pour partir de là… (ou choisis un autre départ)';
}
const hitPlace = (hit, what) => { const [lon, lat] = worldToLonLat(hit.x, hit.z); return { lon, lat, name: hit.name ?? `${what} (${fmt(hit.h)} m)` }; };
$('plFromGps').addEventListener('click', () => { plan.from = null; if (!gps.on) { gpsCentered = true; gps.start(); } renderPlan(); flashEl('plFrom'); planMaybe(); });
$('plFromTap').addEventListener('click', () => startPick('Touche le départ sur la carte (ou le nom d\'un lieu).', hit => {
  plan.from = hitPlace(hit, 'point touché'); renderPlan(); showPlanner(); flashEl('plFrom');
  if (plan.to) planMaybe(); else toast('Départ choisi. Choisis maintenant l\'arrivée.');
}));
$('plToTap').addEventListener('click', () => startPick("Touche l'arrivée sur la carte (ou le nom d'un refuge, d'un lac…).", hit => {
  plan.to = hitPlace(hit, 'point touché'); renderPlan(); showPlanner(); flashEl('plTo'); planMaybe();
}));
$('plFromCenter').addEventListener('click', () => {
  const h = pick(0, 0); if (!h) { toast('Le centre de l\'écran ne montre pas le relief.', true); return; }
  const [lon, lat] = worldToLonLat(h.x, h.z); plan.from = { lon, lat, name: `centre de l'écran (${fmt(h.h)} m)` }; renderPlan(); flashEl('plFrom'); planMaybe();
});
$('planOpen').addEventListener('click', () => { $('d-plan').open = true; $('d-plan').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
$('plSearch').addEventListener('submit', async e => {
  e.preventDefault(); const q = $('plQ').value.trim(); if (q.length < 2) return;
  $('plQ').blur(); $('plResults').innerHTML = ''; $('plNote').textContent = 'Recherche…';
  try {
    const s = planStart() ?? (() => { const [lon, lat] = worldToLonLat(controls.target.x, controls.target.z); return { lon, lat }; })();
    const list = await searchPlaces(q, s); $('plNote').textContent = list.length ? '' : `Aucun lieu trouvé pour « ${q} ».`;
    list.forEach(p => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'place';
      b.innerHTML = `<span>${esc(p.name)}</span><span class="pa">${esc(p.detail || p.src)}</span>`;
      b.addEventListener('click', () => { plan.to = { lon: p.lon, lat: p.lat, name: p.name }; $('plResults').innerHTML = ''; renderPlan(); flashEl('plTo'); planMaybe(); });
      $('plResults').appendChild(b);
    });
  } catch (err) { $('plNote').textContent = `Recherche impossible : ${why(err)}.`; }
});
function offPathNote(r, toName) {
  const bits = [];
  if (r.offStart > 60) bits.push(`le départ est à ${fmt(r.offStart)} m du sentier le plus proche`);
  if (r.offEnd > 60) bits.push(`les sentiers s'arrêtent à ${fmt(r.offEnd)} m ${toName ? `de ${toName}` : "de l'arrivée"} (au-delà, terrain hors sentier : non tracé)`);
  return bits.length ? bits.join(' ; ') + '.' : '';
}
// On foot by the IGN paths, and the ways with lifts (liftplan.js) when they save a quarter of the walk or more,
// or when on foot it is not a walk (faces, glaciers): each judged like the itinerary card, the best one laid
let planGen = 0;
async function planGo(from, to) {
  const gen = ++planGen, title = `${from.name ?? 'Départ'} → ${to.name ?? 'Arrivée'}`;
  $('plNote').textContent = "Calcul de l'itinéraire par l'IGN…"; $('plOpts').innerHTML = ''; $('plGo').disabled = true;
  let r = null, err = null;
  try { r = await walkingRoute(from, to); } catch (e) { err = e; }
  if (gen !== planGen) return;
  const opts = [];
  if (r) {
    opts.push({ title: 'À pied', name: title, pts: r.pts, net: true, note: offPathNote(r, to.name) });
    route.setPath(r.pts, title, [], true); renderRoute();
  }
  $('plNote').textContent = r ? 'Recherche des remontées sur le trajet…' : `À pied : ${why(err)}. Recherche des remontées…`;
  try {
    const a = lonLatToWorld(from.lon, from.lat), b = lonLatToWorld(to.lon, to.lat), n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1500)), waits = [];
    for (let k = 0; k <= n; k++) waits.push(trails.ensure(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n));
    await Promise.race([Promise.all(waits), new Promise(res => setTimeout(res, 12000))]);
    const [za, zb] = await altitudes([from, to]).catch(() => [groundAt(...a), groundAt(...b)]);
    if (gen !== planGen) return;
    const direct = r ? pathStats(resamplePath(r.pts, groundAt)) : null;
    if (za != null && zb != null) {
      const ll = p => { const [lon, lat] = worldToLonLat(p[0], p[1]); return { lon, lat }; };
      for (const o of await liftPlans({ a, b, za, zb, lifts: trails.lifts(), groundAt, ll, directHours: direct?.hours ?? Infinity }))
        opts.push({ title: `Avec ${o.name}`, name: `${title} (${o.name})`, pts: o.pts, net: o.net, note: [offPathNote(o, to.name), o.lifts.some(l => l.kind === 'chair') ? "Télésiège : souvent fermé l'été hors des stations ouvertes l'été." : ''].filter(Boolean).join(' ') });
    }
  } catch { /* the ways with lifts are a plus: on foot stays */ }
  if (gen !== planGen) return;
  $('plGo').disabled = false;
  if (!opts.length) { $('plNote').textContent = `Itinéraire impossible : ${why(err)}.`; toast(`Itinéraire impossible : ${why(err)}.`, true, 4500); return; }
  // each way judged (paths and glaciers along it asked for first)
  for (const o of opts) {
    o.S = resamplePath(o.pts, groundAt, Array.isArray(o.net) ? o.net : o.pts.map(() => 1));
    for (let i = 0; i < o.S.length; i += 150) { trails.ensure(o.S[i].x, o.S[i].z); glaciers.ensure(o.S[i].x, o.S[i].z); }
  }
  await new Promise(res => setTimeout(res, 1500)); if (gen !== planGen) return;
  const rank = { path: 0, unknown: 1, off: 2, steep: 3, glacier: 4, rock: 5 };
  for (const o of opts) { o.st = pathStats(o.S); o.w = judge(o.S); }
  // a way with lifts that another way beats on both counts (verdict and walking time) is left out; on foot stays
  const worse = (p, q) => rank[q.w.level] <= rank[p.w.level] && (q.st?.hours ?? 99) <= (p.st?.hours ?? 99) && q !== p;
  for (let i = opts.length - 1; i >= 0; i--) if (opts[i].title !== 'À pied' && opts.some(q => worse(opts[i], q))) opts.splice(i, 1);
  // the way laid: on foot when it is a walk (the lifts stay offered); otherwise the one that can be walked, quickest first
  const foot = opts.find(o => o.title === 'À pied');
  const best = foot && rank[foot.w.level] < rank.glacier ? foot : [...opts].sort((p, q) => rank[p.w.level] - rank[q.w.level] || (p.st?.hours ?? 99) - (q.st?.hours ?? 99))[0];
  const pickOpt = o => {
    route.setPath(o.pts, o.name, [], o.net);
    $('plNote').textContent = ['Itinéraire IGN sur sentiers et chemins : vérifie l\'état (neige, fermetures, difficulté) avant de partir.', o.note].filter(Boolean).join(' ');
    [...$('plOpts').querySelectorAll('.place')].forEach((el, i) => el.classList.toggle('on', opts[i] === o));
  };
  const verdict = w => w.level === 'rock' ? '<span class="wk rock">Escalade</span>' : w.level === 'glacier' ? '<span class="wk glacier">Glacier</span>'
    : w.level === 'steep' ? '<span class="wk steep">Pentes raides</span>' : w.level === 'off' ? '<span class="wk off">Hors sentier</span>' : w.level === 'path' ? '<span class="wk path">Sentiers</span>' : '';
  $('plOpts').innerHTML = opts.length > 1 ? '<p class="cmeta">Plusieurs façons d\'y aller : touche pour choisir.</p><div class="places results ideas"></div>' : '';
  if (opts.length > 1) for (const o of opts) {
    const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'place';
    bt.innerHTML = `<span>${esc(o.title)}</span><span class="pa">${verdict(o.w)} ${o.st ? `marche ${km(o.st.dist)} km · +${fmt(o.st.up)} m · ${hm(o.st.hours)}${o.st.ride ? ` · remontée ${km(o.st.ride)} km, +${fmt(o.st.rideUp)} m` : ''}` : ''}</span>`;
    bt.addEventListener('click', () => { pickOpt(o); routeReady(o.title); });
    $('plOpts').lastChild.appendChild(bt);
  }
  pickOpt(best);
  const first = opts[0];
  routeReady(best === first ? 'Itinéraire tracé' : first.title === 'À pied' && rank[first.w.level] >= rank.glacier
    ? `À pied, ce n'est pas une randonnée (${first.w.level === 'rock' ? 'parois' : 'glacier'}) : itinéraire « ${best.title} » proposé` : best.title);
}
$('plGo').addEventListener('click', () => {
  const from = planStart();
  if (!from) { $('plNote').textContent = 'Choisis un départ (ta position, un point touché ou le centre de l\'écran).'; return; }
  if (!plan.to) { $('plNote').textContent = "Choisis une arrivée (recherche ou point touché)."; return; }
  planGo(from, plan.to);
});
// ideas: huts, lakes and named places within 12 km of the start, walked there by the IGN paths, quickest first
$('plIdeas').addEventListener('click', async () => {
  const from = planStart();
  if (!from) { $('plNote').textContent = 'Choisis d\'abord un départ.'; return; }
  const [fx, fz] = lonLatToWorld(from.lon, from.lat), cands = [];
  for (const p of PLACES) if (!p.area && p.name) cands.push({ name: p.name, x: p.x, z: p.z, kind: p.hut ? 'refuge' : 'sommet ou repère' });
  for (const l of lakes.lakes.values()) if (l.name) cands.push({ name: l.name, x: l.cx, z: l.cz, kind: 'lac' });
  const seen = new Set(), near = cands.map(c => ({ ...c, d: Math.hypot(c.x - fx, c.z - fz) }))
    .filter(c => c.d > 300 && c.d < 12000 && !seen.has(c.name) && seen.add(c.name)).sort((a, b) => a.d - b.d).slice(0, 8);
  if (!near.length) { $('plIdeasOut').innerHTML = '<p class="cline small">Pas de refuge, lac ou sommet connu à moins de 12 km.</p>'; return; }
  $('plIdeasOut').innerHTML = '<p class="cmeta">Calcul des itinéraires…</p>';
  const out = [];
  for (const c of near) { // one after the other: polite to the IGN service
    try {
      const [lon, lat] = worldToLonLat(c.x, c.z), r = await walkingRoute(from, { lon, lat }), st = pathStats(resamplePath(r.pts, groundAt));
      // every goal is kept, labelled like the catalogue (high mountain above 3 000 m or beyond the paths)
      if (st) out.push({ ...c, r, st, cls: classify({ ...st, offEnd: r.offEnd }), to: { lon, lat, name: c.name } });
    } catch { }
    $('plIdeasOut').innerHTML = `<p class="cmeta">Calcul des itinéraires… ${out.length} / ${near.length}</p>`;
  }
  out.sort((a, b) => a.st.hours - b.st.hours);
  $('plIdeasOut').innerHTML = out.length ? '<div class="places results ideas"></div>' : '<p class="cline small">Aucun itinéraire trouvé.</p>';
  for (const o of out) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'place';
    b.innerHTML = `<span>${esc(o.name)}</span><span class="pa"><span class="cls ${o.cls}">${CLASS_NAMES[o.cls]}</span>${o.kind} · ${hm(o.st.hours)} · ${(o.st.dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km · +${fmt(o.st.up)} m${o.r.offEnd > 60 ? ` · sentier jusqu'à ${fmt(o.r.offEnd)} m du but` : ''}</span>`;
    b.addEventListener('click', () => { route.setPath(o.r.pts, `${from.name ?? 'Départ'} → ${o.name}`, [], true); $('plNote').textContent = offPathNote(o.r, o.name); routeReady(o.name); });
    $('plIdeasOut').firstChild.appendChild(b);
  }
});
renderPlan();

// ---------- hikes catalogue (hikes.js): every named goal of the massif, from the nearest start ----------
let hkFilter = 'all', hkList = [], hkBuilding = null;
loadHikes(SITE).then(c => { if (!hkBuilding) { hkList = c?.hikes ?? []; renderHikes(); } }); // the catalogue shipped with the app (built beforehand), or the device's own
function renderHikes(done, total) {
  const shown = hkList.filter(h => hkFilter === 'all' || h.cls === hkFilter).sort((a, b) => a.hours - b.hours);
  if (hkBuilding) $('hkInfo').textContent = `Construction de la liste… ${done} / ${total} (les itinéraires arrivent au fur et à mesure)`;
  else if (hkList.length) $('hkInfo').textContent = `${hkList.length} itinéraires pour ce massif · ${shown.length} affichés, du plus court au plus long.`;
  $('hkBuild').hidden = !!hkBuilding || hkList.length > 0;
  $('hkCount').textContent = hkList.length ? fmt(hkList.length) : '';
  const box = $('hkList'); box.innerHTML = '';
  for (const h of shown) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'place';
    b.innerHTML = `<span>${esc(h.name)}${h.alt ? ` · ${fmt(h.alt)} m` : ''}</span><span class="pa"><span class="cls ${h.cls}">${CLASS_NAMES[h.cls]}</span>${h.kind} · depuis ${h.start === 'parking' ? `un parking à ${fmt(h.startAlt ?? 0)} m` : esc(h.start)} · ${hm(h.hours)} · ${(h.dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km · +${fmt(h.up)} m · point haut ${fmt(h.max)} m${h.offEnd > 150 ? ` · les sentiers s'arrêtent à ${fmt(h.offEnd)} m du but, la fin est hors sentier` : ''}</span>`;
    b.addEventListener('click', () => {
      route.setPath(hikePath(h), `${h.name} depuis ${h.start}`, [], true); routeReady(h.name);
      if (h.cls === 'alpine') setTimeout(() => toast("Haute montagne : glacier ou rocher, crevasses et chutes de pierres possibles. Matériel d'alpinisme, expérience et encordement nécessaires ; guide conseillé. Le tracé s'arrête au bout des sentiers.", true, 7000), 4600);
    });
    box.appendChild(b);
  }
}
document.querySelectorAll('[data-hk]').forEach(b => b.addEventListener('click', () => {
  hkFilter = b.dataset.hk; document.querySelectorAll('[data-hk]').forEach(x => x.setAttribute('aria-pressed', x === b)); renderHikes();
}));
$('hkBuild').addEventListener('click', async () => {
  if (hkBuilding) return; hkBuilding = new AbortController(); renderHikes(hkList.length, '…');
  try { hkList = await buildHikes(SITE, (list, done, total) => { hkList = list; renderHikes(done, total); }, hkBuilding.signal); }
  catch (err) { $('hkInfo').textContent = `Construction impossible : ${why(err)}. Réessaie avec du réseau.`; }
  hkBuilding = null; renderHikes();
});
renderHikes();

// ---------- camptocamp: topos and recent outings (daily copy, c2c.js) ----------
let c2c = null, c2cFilter = 'all', c2cShown = 30;
const c2cDate = d => new Date(d + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const condBadge = c => C2C_COND[c] ? `<span class="cnd" style="--c:${C2C_COND[c][1]}">${C2C_COND[c][0]}</span>` : '';
$('c2cFilters').innerHTML = C2C_FILTERS.map(([k, n]) => `<button type="button" data-c2c="${k}" aria-pressed="${k === 'all'}">${n}</button>`).join('');
loadC2C(SITE).then(d => {
  if (!d) { $('c2cInfo').textContent = "Topos camptocamp indisponibles (pas encore copiés pour ce massif, ou hors ligne sans copie)."; return; }
  c2c = prepareC2C(d); renderC2C();
});
function renderC2C() {
  if (!c2c) return;
  const T = controls.target, recent = $('c2cRecent').checked, last = r => r.outings[0]?.d ?? '';
  const list = c2c.routes.filter(r => c2cMatches(r, c2cFilter)).map(r => ({ r, km: Math.hypot(r.x - T.x, r.z - T.z) / 1000 }))
    .sort((a, b) => recent && (last(a.r) || last(b.r)) && last(a.r) !== last(b.r) ? last(b.r).localeCompare(last(a.r)) : a.km - b.km);
  const withOut = c2c.routes.filter(r => r.outings.length).length;
  $('c2cInfo').textContent = `${fmt(c2c.routes.length)} itinéraires, ${fmt(c2c.outings.length)} sorties des 45 derniers jours (${withOut} itinéraires parcourus) · copie camptocamp du ${new Date(c2c.fetched + "T12:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}. ${recent ? 'Les plus récemment parcourus' : 'Les plus proches du centre de la vue'} d'abord.`;
  const box = $('c2cList'); box.innerHTML = '';
  for (const { r, km } of list.slice(0, c2cShown)) {
    const o = r.outings[0], b = document.createElement('button'); b.type = 'button'; b.className = 'place';
    const meta = [activityText(r.act), ratingText(r), r.dup ? `+${fmt(r.dup)} m` : '', r.emax ? `${fmt(r.emax)} m` : '', r.or.join('/'), `à ${km < 10 ? t1(km) : fmt(km)} km`].filter(Boolean).join(' · ');
    b.innerHTML = `<span>${esc(r.t)}</span><span class="pa">${esc(meta)}</span>${o ? `<span class="pa">${condBadge(o.c)} ${c2cDate(o.d)}${r.outings.length > 1 ? ` · ${r.outings.length} sorties en 45 j` : ''}</span>` : ''}`;
    b.addEventListener('click', () => showC2C(r));
    box.appendChild(b);
  }
  $('c2cMore').hidden = list.length <= c2cShown;
}
function showC2C(r) {
  const line = c2cLine(c2c, r);
  if (line) { route.setPath(line, r.t); renderRoute(); frameRoute(); toast('Tracé camptocamp posé sur la carte.'); }
  else flyToLonLat(r.ll[0], r.ll[1]);
  const outs = r.outings.map(o => `<div class="out"><p><b>${c2cDate(o.d)}</b> ${condBadge(o.c)} · ${esc(o.by || 'anonyme')}${o.emax ? ` · jusqu'à ${fmt(o.emax)} m` : ''}</p>
    ${o.cond ? `<p>${esc(o.cond)}</p>` : '<p class="small">Pas de texte sur les conditions.</p>'}
    ${snowText(o.snow) ? `<p class="small">${esc(snowText(o.snow))}</p>` : ''}${o.wx ? `<p class="small">Météo : ${esc(o.wx)}</p>` : ''}
    <p class="small"><a href="https://www.camptocamp.org/outings/${o.id}" target="_blank" rel="noopener">Compte rendu complet sur camptocamp.org</a></p></div>`).join('');
  $('c2cDetail').innerHTML = `<h4>${esc(r.t)}</h4>
    <p class="cmeta">${esc([activityText(r.act), ratingText(r), r.dup ? `+${fmt(r.dup)} m` : '', r.emax ? `point haut ${fmt(r.emax)} m` : '', r.or.length ? `orientation ${r.or.join('/')}` : ''].filter(Boolean).join(' · '))}</p>
    <p class="small">${line ? 'Tracé camptocamp posé sur la carte (profil et survol dans « Itinéraire » ci-dessous).' : "Pas de tracé détaillé dans la copie : la carte montre le point de l'itinéraire."}
      <a href="https://www.camptocamp.org/routes/${r.id}" target="_blank" rel="noopener">Topo complet sur camptocamp.org</a></p>
    ${outs || '<p class="small">Aucune sortie publiée sur cet itinéraire ces 45 derniers jours.</p>'}`;
  $('c2cDetail').scrollIntoView({ block: 'nearest' });
}
document.getElementById('c2cFilters').addEventListener('click', e => {
  const b = e.target.closest('[data-c2c]'); if (!b) return;
  c2cFilter = b.dataset.c2c; c2cShown = 30; document.querySelectorAll('[data-c2c]').forEach(x => x.setAttribute('aria-pressed', x === b)); renderC2C();
});
$('c2cRecent').addEventListener('change', () => { c2cShown = 30; renderC2C(); });
$('c2cMore').addEventListener('click', () => { c2cShown += 30; renderC2C(); });
$('tab-route').addEventListener('click', () => renderC2C()); // distances from wherever the view is now
$('gpxOut').addEventListener('click', () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([route.toGPX()], { type: 'application/gpx+xml' }));
  a.download = (route.name || 'itineraire').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.gpx'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
// touching the profile shows where that point is on the map
$('routeOut').addEventListener('pointermove', e => {
  const svg = e.target.closest('.profile svg'); if (!svg) return;
  const r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * 320, f = (vx - +svg.dataset.l) / +svg.dataset.w;
  if (f < 0 || f > 1) return;
  const d = f * +svg.dataset.dist; route.showCursor(d, camera, state.exag);
  const cur = svg.querySelector('.cur'); cur.setAttribute('x1', vx); cur.setAttribute('x2', vx); cur.setAttribute('visible', 'true');
  const p = route.pointAt(d); if (p) $('rAlt').textContent = `${fmt(p.h)} m · km ${(d / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`;
});
$('routeOut').addEventListener('pointerleave', () => route.showCursor(null));
// flight along the itinerary: ~1 minute whatever its length, camera behind and above, looking ahead
// the flight filmed: the 3D image recorded while flying along (names and panels are not in the film)
$('flyRec').addEventListener('click', () => {
  if (!(route.length > 0)) { $('routePackInfo').textContent = "Charge d'abord un itinéraire."; return; }
  const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => window.MediaRecorder?.isTypeSupported(t));
  if (!type || !renderer.domElement.captureStream) { $('routePackInfo').textContent = "Ce navigateur ne sait pas filmer l'image 3D."; return; }
  const rec = new MediaRecorder(renderer.domElement.captureStream(30), { mimeType: type, videoBitsPerSecond: 8e6 }), parts = [];
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  rec.onstop = () => {
    const a = document.createElement('a'), ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    a.href = URL.createObjectURL(new Blob(parts, { type: type.split(';')[0] }));
    a.download = `survol-${(route.name || 'itineraire').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40)}.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('routePackInfo').textContent = 'Vidéo du survol enregistrée.';
  };
  rec.start(1000); $('routePackInfo').textContent = 'Survol filmé en cours… la vidéo se télécharge à la fin.';
  flyRoute = { d: 0, speed: Math.min(160, Math.max(25, route.length / 60)) }; fly = null; closeSheets();
  const watch = setInterval(() => { if (!flyRoute) { clearInterval(watch); rec.stop(); } }, 250);
});
$('flyGo').addEventListener('click', () => { if (route.length > 0) { flyRoute = { d: 0, speed: Math.min(160, Math.max(25, route.length / 60)) }; fly = null; closeSheets(); toast('Survol : touche la carte pour l\'arrêter.'); } });
function flyAlongRoute(dt) {
  const r = flyRoute; r.d += dt * r.speed;
  if (r.d > route.length) { flyRoute = null; return; }
  const p = route.pointAt(r.d), ahead = route.pointAt(Math.min(route.length, r.d + 350)), back = route.pointAt(Math.max(0, r.d - 250));
  const e = state.exag, tgt = new THREE.Vector3(ahead.x, ahead.h * e, ahead.z), eye = new THREE.Vector3(back.x, Math.max(back.h, p.h) * e + 160, back.z);
  controls.target.lerp(tgt, 0.08); camera.position.lerp(eye, 0.08);
}
renderRoute();

// ---------- viewfinder: the view from where one stands, turned with the phone ----------
const sight = new Sight();
async function sightOn() {
  const err = await sight.start(); // asks iOS for the compass: must stay in the tap's call stack
  if (err) { $('sightNote').textContent = err; return; }
  if (!gps.on) { gpsCentered = true; gps.start(); }
  if (state.exag !== 1) { $('exag').value = 1; $('exag').dispatchEvent(new Event('input')); } // true relief only
  if (google.on) setView('ign');
  controls.enabled = false; fly = null; flyRoute = null; closeSheets();
  document.body.classList.add('sight'); $('sightBar').hidden = false;
}
// ----- augmented reality: the back camera's picture behind the names of the summits -----
// The 3D view's field of view is set to the camera's as it appears on screen (picture cropped to fill it):
// phone main cameras see about 66° along the long side of the picture; a ± adjustment is kept on the device.
let camStream = null, fovAdj = 1;
try { fovAdj = +localStorage.getItem('midi3d-cam-fov') || 1; } catch { }
function camFov() {
  const v = $('camFeed'), vw = v.videoWidth, vh = v.videoHeight, W = stage.clientWidth, H = stage.clientHeight;
  if (!vw || !vh) return;
  const f = (Math.max(vw, vh) / 2) / Math.tan(66 * Math.PI / 360), s = Math.max(W / vw, H / vh);
  camera.fov = 2 * Math.atan((H / s / 2) / f) * 180 / Math.PI * fovAdj; camera.updateProjectionMatrix();
}
async function camOn() {
  if (!navigator.mediaDevices?.getUserMedia) { $('sightInfo').textContent = "Pas d'accès à la caméra sur cet appareil."; return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
  } catch (e) { $('sightInfo').textContent = e.name === 'NotAllowedError' ? 'Caméra refusée : autorise-la pour ce site.' : `Caméra indisponible (${e.message}).`; return; }
  const v = $('camFeed'); v.srcObject = camStream; v.hidden = false; await v.play().catch(() => { });
  v.onloadedmetadata = camFov; camFov();
  document.body.classList.add('cam'); $('camBtn').setAttribute('aria-pressed', 'true');
  for (const id of ['reliefBtn', 'fovMinus', 'fovPlus']) $(id).hidden = false;
}
function camOff() {
  camStream?.getTracks().forEach(t => t.stop()); camStream = null;
  const v = $('camFeed'); v.srcObject = null; v.hidden = true;
  document.body.classList.remove('cam', 'relief'); $('camBtn').setAttribute('aria-pressed', 'false');
  for (const id of ['reliefBtn', 'fovMinus', 'fovPlus']) $(id).hidden = true;
  camera.fov = 50; camera.updateProjectionMatrix();
}
$('camBtn').addEventListener('click', () => camStream ? camOff() : camOn());
$('reliefBtn').addEventListener('click', () => { const on = document.body.classList.toggle('relief'); $('reliefBtn').setAttribute('aria-pressed', on); });
const nudgeFov = k => { fovAdj = Math.min(1.4, Math.max(0.7, fovAdj * k)); try { localStorage.setItem('midi3d-cam-fov', fovAdj); } catch { } camFov(); };
$('fovMinus').addEventListener('click', () => nudgeFov(1 / 1.03)); $('fovPlus').addEventListener('click', () => nudgeFov(1.03));
addEventListener('resize', () => { if (camStream) setTimeout(camFov, 300); }); // turning the phone changes the crop
function sightOffNow() {
  if (camStream) camOff();
  sight.stop(); document.body.classList.remove('sight'); $('sightBar').hidden = true;
  // hand back to the map, looking where the phone looked
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  controls.target.copy(camera.position).addScaledVector(dir, 600); camera.position.addScaledVector(dir, -200).y += 150;
  controls.enabled = true;
}
$('sightGo').addEventListener('click', sightOn);
$('sightOff').addEventListener('click', sightOffNow);
// dragging sideways turns the view by hand: phone compasses are often a few degrees off
let sightDrag = null;
renderer.domElement.addEventListener('pointerdown', e => { if (sight.on) sightDrag = e.clientX; });
renderer.domElement.addEventListener('pointermove', e => { if (sight.on && sightDrag != null) { sight.nudge((e.clientX - sightDrag) * 0.08); sightDrag = e.clientX; } });
addEventListener('pointerup', () => { sightDrag = null; });
function sightFrame() {
  const p = gps.pos;
  if (!p) { $('sightInfo').textContent = 'Viseur · recherche de ta position GPS…'; return; }
  const g = groundAt(p.x, p.z) ?? p.gpsAlt ?? 0;
  const ok = sight.apply(camera, new THREE.Vector3(p.x, g + 1.7, p.z));
  $('sightInfo').textContent = !ok ? 'Viseur · en attente de la boussole…'
    : `Viseur · ±${fmt(p.acc)} m${sight.absolute ? '' : ' · boussole relative : glisse pour caler le nord'}${sight.offset ? ` · calage ${Math.round(sight.offset)}°` : ''}`;
}
const seg = (group, key, fn) => document.querySelectorAll(`[data-${group}]`).forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll(`[data-${group}]`).forEach(x => x.setAttribute('aria-pressed', x === b)); state[key] = b.dataset[group]; fn?.(b.dataset[group]);
}));
const markSeg = (group, val) => document.querySelectorAll(`[data-${group}]`).forEach(x => x.setAttribute('aria-pressed', x.dataset[group] === val));
seg('render', 'render', v => { U.visToday.value = v === 'sat' ? 1 : 0; engine.setOverlay('vis', v === 'sat'); });
// the real sun lights the snow far brighter than the photo's own exposure: the final image is exposed a little lower
seg('light', 'light', v => { U.light.value = v === 'sun' ? 1 : 0; U.night.value = v === 'sun' ? state.night ?? 0 : 0; post.final.uniforms.exposure.value = v === 'sun' ? 0.82 : 1; $('f-time').classList.toggle('dim', v !== 'sun'); });
seg('quality', 'quality', applyQuality);
seg('precip', 'precip', applyPrecip);
$('time').addEventListener('input', e => { state.hourOffset = +e.target.value; updateSky(); });
$('now').addEventListener('click', () => { $('time').value = 0; state.hourOffset = 0; state.dayOffset = 0; $('sunDate').value = isoDay(new Date()); updateSky(); });
$('exag').addEventListener('input', e => {
  const v = +e.target.value, r = v / state.exag; state.exag = v; U.exag.value = v; engine.setExaggeration(v);
  controls.target.y *= r; camera.position.y *= r; placeCable(); $('exagOut').textContent = '×' + v.toFixed(2).replace(/0$/, '');
});
$('vivid').addEventListener('input', e => { U.vivid.value = +e.target.value; $('vividOut').textContent = +e.target.value < 0.02 ? 'naturelles' : '+' + Math.round(+e.target.value * 100) + ' %'; });
$('c-snowtoday').addEventListener('change', e => { state.snowToday = e.target.checked; U.snowToday.value = e.target.checked ? 1 : 0; engine.setOverlay('snow', e.target.checked); });
$('c-clouds').addEventListener('change', e => setWeatherShown(e.target.checked, false));
// one switch for the real weather on screen (bottom bar and Affichage): clouds, their grey veil and haze, and
// the rain or snow falling. Off, the mountains are seen as on a clear day, whatever the weather; remembered.
function setWeatherShown(on, withPrecip = true) {
  state.clouds = on; $('c-clouds').checked = on;
  $('wxToggle').setAttribute('aria-pressed', on); $('wxToggle').setAttribute('aria-label', on ? 'Météo réelle affichée : nuages, pluie et neige (toucher pour les masquer)' : 'Météo masquée : vue dégagée (toucher pour afficher la météo réelle)');
  if (withPrecip) { state.precip = on ? 'auto' : 'off'; markSeg('precip', state.precip); applyPrecip(); }
  if (state.weather) renderWeather(); else { cloudU.cover.value = 0; showCloudLayers(); }
  try { localStorage.setItem('midi3d-weather-shown', on ? '1' : '0'); } catch { }
}
$('wxToggle').addEventListener('click', () => { setWeatherShown(!state.clouds); toast(state.clouds ? 'Météo réelle affichée : nuages, pluie et neige du moment.' : 'Météo masquée : montagne vue comme par temps clair.'); });
try { if (localStorage.getItem('midi3d-weather-shown') === '0') setWeatherShown(false); } catch { }
// cloud layers cover the whole screen: none drawn in clear weather, fewer on lighter settings
function showCloudLayers() { const n = QUAL[state.quality].clouds, vol = vclouds.on && post.enabled; clouds.children.forEach((m, i) => { m.visible = !vol && cloudU.cover.value > 0.01 && i < n && !state.far; }); }
$('c-labels').addEventListener('change', e => { state.labels = e.target.checked; labelsEl.hidden = !e.target.checked; });
$('c-cable').addEventListener('change', e => { cable.visible = cabins.visible = e.target.checked; });
state.trees = true; $('c-trees').addEventListener('change', e => { state.trees = e.target.checked; });
$('c-buildings').addEventListener('change', e => { buildings.on = e.target.checked; });
// LiDAR point cloud: choice remembered; colours from the photo or by class (legend from the shader's own list)
$('ptLegend').innerHTML = POINT_CLASSES.map(([, name, hex]) => `<li><i style="background:${hex}"></i>${esc(name)}</li>`).join('');
function applyLidar(on) {
  lidar.on = on; $('c-lidar').checked = on; $('f-lidar').hidden = !on; if (!on) lidar.release();
  if (on) navigator.storage?.persist?.(); // ask the browser to keep what is downloaded (installed apps usually get it)
  try { localStorage.setItem('midi3d-lidar-v2', on ? '1' : '0'); } catch { }
}
$('c-lidar').addEventListener('change', e => applyLidar(e.target.checked));
// off unless chosen: the owner prefers the photo on the relief to raw points (a point cloud has no photo of its own)
let savedLidar = null; try { savedLidar = localStorage.getItem('midi3d-lidar-v2'); } catch { }
applyLidar(savedLidar === '1');
seg('ptcolor', 'ptcolor', v => { lidar.setColorMode(v === 'classes' ? 1 : 0); $('ptLegend').hidden = v !== 'classes'; });
const ptDate = d => new Date(d.replace(/Z$/, '')).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
function renderLidarInfo() {
  const s = lidar.stats, el = $('ptInfo'); if (!lidar.on) return;
  if (google.on) { el.textContent = 'Les points LiDAR restent dans la vue IGN.'; return; }
  if (s.why === 'far') { el.textContent = 'Rapproche-toi (moins de 4 km du point regardé) pour voir les points.'; return; }
  if (s.why === 'none') { el.textContent = "Pas de relevé LiDAR IGN publié ici (hors de France ou pas encore diffusé)."; return; }
  if (s.why === 'wait' && !s.shown) { el.textContent = navigator.onLine ? 'Recherche des relevés LiDAR ici…' : "Hors ligne : seuls les endroits déjà vus s'affichent."; return; }
  const when = s.dates?.length ? ` · relevé ${s.dates.length > 1 ? `de ${ptDate(s.dates[0])} à ${ptDate(s.dates[s.dates.length - 1])}` : `de ${ptDate(s.dates[0])}`}` : '';
  el.textContent = `${fmt(s.shown)} points affichés${when}${s.missing ? ` · ${s.missing} morceaux ${navigator.onLine ? 'en chargement' : 'non gardés (hors ligne)'}` : ''}`;
}
$('c-trails').addEventListener('change', e => { trails.on = e.target.checked; });
$('c-streams').addEventListener('change', e => { streams.on = e.target.checked; });
$('c-pistes').addEventListener('change', e => { pistes.on = e.target.checked; $('pisteInfo').hidden = !e.target.checked; });
$('c-freeze').addEventListener('change', e => { weather3d.showFreeze = e.target.checked; });
$('c-photos').addEventListener('change', e => { photos.on = e.target.checked; });
$('c-clpa').addEventListener('change', e => { engine.setOverlay('clpa', e.target.checked); $('clpaLegend').hidden = !e.target.checked; });
$('c-wind').addEventListener('change', e => { weather3d.showWind = e.target.checked; });
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

// ---------- back in time: aerial photos of another period on today's relief ----------
$('epoch').innerHTML = Object.entries(EPOCHS).map(([k, [, , label]]) => `<option value="${k}">${label}</option>`).join('');
$('epoch').addEventListener('change', e => {
  const k = e.target.value; engine.setEpoch(k); U.historic.value = k === 'current' ? 0 : 1;
  for (const id of ['c-snowtoday']) $(id).disabled = k !== 'current';
  $('epochBadge').hidden = k === 'current'; $('epochBadge').textContent = `Photos ${EPOCHS[k][2]} · revenir à aujourd'hui`;
  showEpochNote();
});
function showEpochNote() {
  const k = engine.epoch, el = $('epochNote');
  if (k === 'current') { el.textContent = 'Photos IGN les plus récentes (BD ORTHO, 20 cm).'; return; }
  const c = engine.busy ? null : engine.epochCover; // judged once the photos have arrived
  el.textContent = `Photos IGN ${EPOCHS[k][2]}${+k < 1970 ? ' (noir et blanc)' : ''}, posées sur le relief d'aujourd'hui (LiDAR 2022) : un glacier de l'époque, plus épais, apparaît à la hauteur actuelle de la glace. `
    + (c == null ? 'Chargement des photos de cette époque… ' : c > 0.97 ? 'Toute la vue a une photo de cette époque.' : c < 0.03 ? "Pas de photo de cette époque ici : c'est la photo actuelle qui s'affiche." : `Photo de cette époque sur ${Math.round(c * 100)} % de la vue ; ailleurs, la photo actuelle.`)
    + ' Neige du jour, glace et couleurs de saison coupées.';
}
showEpochNote();
$('epochBadge').addEventListener('click', () => { $('epoch').value = 'current'; $('epoch').dispatchEvent(new Event('change')); });

// ---------- view: IGN terrain or Google Photorealistic 3D Tiles, never both at once (see google3d.js) ----------
state.view = 'ign';
const GERR = {
  key: "Google refuse la clé pour la carte 3D. Dans la console Google : active « Maps JavaScript API », et dans les restrictions de la clé autorise cette API et le site https://qdesbuisson87-web.github.io/*. La facturation doit être configurée.",
  map: "Google n'a pas pu afficher sa carte 3D (peut-être pas disponible pour ton compte ou ta région). Retour à la vue IGN.",
  slow: "La carte 3D de Google ne s'affiche pas après 30 s (clé refusée sans message, « Maps JavaScript API » pas activée, ou connexion trop lente). Retour à la vue IGN.",
  network: 'Google ne répond pas (connexion). Retour à la vue IGN.'
};
// our camera for Google's map: centre on the point looked at, distance, heading (ours turns the other way) and tilt
// (0 = looking straight down for both)
function googleCam() {
  const c = controls.cur, [lng, lat] = worldToLonLat(c.t.x, c.t.z), deg = 180 / Math.PI;
  return { lat, lng, range: c.d, heading: ((360 - c.h * deg) % 360 + 360) % 360, tilt: Math.min(85, c.p * deg) };
}
// and back: the same place, seen the same way, in our view
function fromGoogleCam(g) {
  const [x, z] = lonLatToWorld(g.lng, g.lat), r = Math.PI / 180, h = -g.heading * r, p = g.tilt * r;
  const t = new THREE.Vector3(x, (groundAt(x, z) ?? controls.target.y / state.exag) * state.exag, z);
  engine.ensureRoots(x, z, 45000);
  startFly(t, t.clone().add(new THREE.Vector3(Math.sin(p) * Math.sin(h), Math.cos(p), Math.sin(p) * Math.cos(h)).multiplyScalar(g.range)), 10);
}
// what of ours goes onto Google's map: the summits and huts near the view (the nearest 60) and the itinerary
function googleExtras() {
  const T = controls.target;
  const marks = PLACES.filter(p => p.name && !p.area && (p.alt || p.hut) && !p.fall && !p.cam && !p.nivo && Math.hypot(p.x - T.x, p.z - T.z) < 20000)
    .sort((a, b) => Math.hypot(a.x - T.x, a.z - T.z) - Math.hypot(b.x - T.x, b.z - T.z)).slice(0, 60)
    .map(p => { const [lng, lat] = worldToLonLat(p.x, p.z); return { name: p.alt ? `${p.name} ${fmt(p.alt)} m` : p.name, lat, lng, small: !!p.hut }; });
  const S = route.samples, step = Math.max(1, Math.ceil(S.length / 600));
  const path = S.filter((_, i) => i % step === 0 || i === S.length - 1).map(s => { const [lng, lat] = worldToLonLat(s.x, s.z); return { lat, lng }; });
  return { marks, path };
}
function setView(v) {
  if (v === 'google' && !googleKey.get()) { $('gKeyBlock').hidden = false; $('gKey').focus(); $('gNote').textContent = ''; return; }
  if (v === 'google' && !navigator.onLine) { $('gNote').textContent = "La vue Google 3D demande une connexion : Google interdit de la garder hors ligne. La vue IGN marche hors ligne."; return; }
  if (v === 'google' && keyChanged(googleKey.get())) { $('gNote').textContent = 'Nouvelle clé : recharge la page pour que Google la prenne.'; toast('Recharge la page pour utiliser la nouvelle clé.', true); return; }
  const g = v === 'google';
  if (g === google.on) return;
  state.view = v; markSeg('view', v);
  document.body.classList.toggle('google', g); $('gKeyBlock').hidden = !g;
  if (g) {
    if (state.exag !== 1) { $('exag').value = 1; $('exag').dispatchEvent(new Event('input')); } // Google's relief is the true one
    const fail = (kind, msg) => {
      document.body.classList.remove('google'); state.view = 'ign'; markSeg('view', 'ign'); $('gKeyBlock').hidden = false;
      const t = GERR[kind] ?? GERR.map; $('gNote').textContent = t + (msg ? ` (${msg})` : ''); toast(t, true, 9000);
    };
    google.open(googleKey.get(), googleCam(), googleExtras(), fail).catch(e => fail(e.message === 'key' ? 'key' : 'network'));
  } else {
    const c = google.close(); if (c) fromGoogleCam(c);
  }
  // layers computed on the IGN terrain are not drawn over Google's tiles
  for (const id of ['c-slopes', 'c-bera', 'c-snowtoday', 'c-lidar', 'exag']) $(id).disabled = g;
  $('slopeLegend').hidden = g || !state.slopes; applyBeraMap();
  $('gNote').textContent = g ? 'Vue Google 3D (photos et relief Google, en ligne seulement). La carte des pentes, la neige du jour, les points LiDAR et le relief exagéré restent dans la vue IGN : touche « IGN (LiDAR) » pour les retrouver.' : '';
  try { localStorage.setItem('midi3d-view', v); } catch { }
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
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
// turn-around mode: one finger turns the view around the point in the middle of the screen
$('orbitBtn').addEventListener('click', () => {
  controls.oneFingerOrbit = !controls.oneFingerOrbit; $('orbitBtn').setAttribute('aria-pressed', controls.oneFingerOrbit);
  toast(controls.oneFingerOrbit ? "Tourner autour : un doigt glissé à gauche ou à droite tourne autour du centre de l'écran, en haut ou en bas incline. Retouche le bouton pour revenir au déplacement." : 'Un doigt déplace de nouveau la carte.', false, controls.oneFingerOrbit ? 6500 : 2500);
});
// "3D" button: tilt to a view facing the mountains, or back to a view from above (same pivot and distance)
$('tilt').addEventListener('click', () => {
  const off = camera.position.clone().sub(controls.target), s = new THREE.Spherical().setFromVector3(off);
  s.phi = s.phi < 0.9 ? 1.3 : 0.3; // ~75° from the vertical: nearly level; ~17°: almost straight down
  startFly(controls.target.clone(), controls.target.clone().add(new THREE.Vector3().setFromSpherical(s)), 900);
});
$('refresh').addEventListener('click', refreshLive);
// Automatic adjustment: the chosen quality sets the ceiling; when the measured frame rate stays under the
// quality's target, the resolution goes down first (down to half), then the terrain detail (down to 60 %).
// Both come back, detail first, after several seconds of comfortable frame rate.
const adapt = { res: 1, detail: 1, good: 0, since: 0, level: 0, noClouds: false, noPost: false };
function applyScale() {
  const Q = QUAL[state.quality]; engine.splitK = Q.k * adapt.detail; 
  lidar.setQuality(Q.pts * adapt.detail * adapt.detail, Q.ptPx); // fewer LiDAR points along with the terrain detail
  // pixel budget: a foldable's or a tablet's large screen at full density is several times a phone's pixels
  const css = Math.max(1, stage.clientWidth * stage.clientHeight), cap = Math.sqrt(Q.px / css);
  const pr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, Q.pr, cap) * adapt.res);
  // the heavy effects go first when the frame rate is short; sharpness (resolution) last
  vclouds.on = Q.vSteps > 0 && !adapt.noClouds; post.setOptions({ enabled: state.quality !== 'standard' && !adapt.noPost, samples: (window.devicePixelRatio || 1) < 2 ? 4 : 0 }); showCloudLayers();
  if (Math.abs(pr - renderer.getPixelRatio()) > 0.01) { renderer.setPixelRatio(pr); resize(); }
}
// Steps of the automatic adjustment, mildest first: the clouds in volume become flat layers, the distant detail
// drops, then the resolution a little, the final image pass, and only then the resolution further down.
const ADAPT_STEPS = [
  { },
  { noClouds: true },
  { noClouds: true, detail: 0.85 },
  { noClouds: true, detail: 0.7 },
  { noClouds: true, detail: 0.7, res: 0.85 },
  { noClouds: true, detail: 0.7, res: 0.85, noPost: true },
  { noClouds: true, detail: 0.6, res: 0.72, noPost: true },
  { noClouds: true, detail: 0.6, res: 0.6, noPost: true },
  { noClouds: true, detail: 0.6, res: 0.5, noPost: true }
];
// what the automatic adjustment has given up, in words (under the quality choice)
function showQualNote() {
  const s = ADAPT_STEPS[adapt.level], bits = [];
  if (s.noClouds && QUAL[state.quality].vSteps) bits.push('nuages plats');
  if (s.detail) bits.push('détail lointain réduit');
  if (s.res) bits.push(`résolution ${Math.round(s.res * 100)} %`);
  if (s.noPost && state.quality !== 'standard') bits.push('sans la passe finale (halo, contraste)');
  $('qualNote').textContent = (adapt.level ? `Réglage automatique pour rester fluide sur cet appareil : ${bits.join(', ')}. Il revient au mieux dès que l'image le permet.` : "Réglage automatique : rien n'est allégé en ce moment.")
    + ' Standard économise la batterie, Extrême demande un appareil puissant.';
}
function setAdaptLevel(l) {
  adapt.level = l; const s = ADAPT_STEPS[l];
  adapt.res = s.res ?? 1; adapt.detail = s.detail ?? 1; adapt.noClouds = !!s.noClouds; adapt.noPost = !!s.noPost;
}
function adaptTo(fps) {
  const Q = QUAL[state.quality], now = performance.now();
  if (!started || document.hidden || now - adapt.since < 3000) return; // let a change settle before judging it
  if (fps < Q.fps * 0.9) {
    adapt.good = 0;
    if (adapt.level >= ADAPT_STEPS.length - 1) return;
    setAdaptLevel(adapt.level + 1);
  } else if (fps >= Math.min(Q.fps + 12, 57) && adapt.level > 0) {
    if (++adapt.good < 4) return;
    adapt.good = 0; setAdaptLevel(adapt.level - 1);
  } else { adapt.good = 0; return; }
  adapt.since = now; applyScale();
}
function applyQuality(q) {
  const Q = QUAL[q]; engine.maxTiles = Q.tiles; engine.maxLoads = Q.loads;
  Object.assign(adapt, { good: 0, since: performance.now() }); setAdaptLevel(0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pr)); resize(); applyScale();
  // final pass from "Haute" up; the scene buffer multisampled where the renderer would have been (screens below 2×)
  post.setOptions({ enabled: q !== 'standard', samples: (window.devicePixelRatio || 1) < 2 ? 4 : 0 });
  vclouds.on = Q.vSteps > 0; vclouds.setQuality(Q.vSteps, q === 'extreme' ? 4 : 3);
  showCloudLayers(); applyPrecip(); shadows.setQuality(Q.shRes, Q.shSteps, Q.ao, Q.aoRes); forest.maxTrees = Q.trees; lakes.mirrorOn = q !== 'standard'; lakes.mirrorEvery = q === 'extreme' ? 2 : 3;
  try { localStorage.setItem('midi3d-quality', q); } catch { }
}
markSeg('quality', state.quality);


// ---------- "à ton altitude": fresh snow / rain forecast at a chosen height or point ----------
let altPoint = null;
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
  } catch (e) { out.innerHTML = `<p class="cline">Prévision indisponible (${esc(why(e))}).</p>`; }
}
$('altGo').addEventListener('click', () => {
  const a = Math.round(+$('altIn').value);
  if (!(a >= 500 && a <= 4810)) { $('altOut').innerHTML = '<p class="cline">Indique une altitude entre 500 et 4 810 m.</p>'; return; }
  // typed altitude: forecast on the Chamonix -> Aiguille du Midi axis, unless a point was picked on the map
  const lat = altPoint?.lat ?? SPOTS.top.lat, lon = altPoint?.lon ?? SPOTS.top.lon;
  altitudeReport(lat, lon, a, altPoint ? `Point choisi (${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E)` : `Secteur ${SPOTS.top.name}`);
});
$('altIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('altGo').click(); });
$('altPick').addEventListener('click', () => startPick("Touche le relief à l'endroit voulu : la prévision se fait à son altitude.", altAt));
function altAt(hit) {
  const [lon, lat] = worldToLonLat(hit.x, hit.z); altPoint = { lat, lon };
  $('altIn').value = Math.round(hit.h); openSheet('cond', true); $('altBlock').open = true;
  altitudeReport(lat, lon, hit.h, hit.name ? `${hit.name} (${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E)` : `Point choisi (${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E)`);
  $('altBlock').scrollIntoView({ block: 'start' });
}

// ---------- point conditions: tap anywhere on the relief ----------
let pin = null, pinSeq = 0;
// Sentinel-2 at the exact point (10 m pixel): snow index and scene class of the last clear pass
async function satSnowAt(lat, lon) {
  const S = engine.overlay.item; if (!S) return null; // the pass on screen (the latest clear one, or the film's date)
  const [fx, fy] = lonLatToTile(lon, lat, 14), x = Math.floor(fx), y = Math.floor(fy);
  const px = Math.min(255, Math.floor((fx - x) * 256)), py = Math.min(255, Math.floor((fy - y) * 256));
  const read = async kind => {
    const r = await cachedFetch(engine.overlayUrl(kind, 14, x, y)); if (!r.ok) return null; // queued, timed out, kept for offline
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
  const seq = ++pinSeq; showPointSheet(); dropPin(hit); keepInSight(hit);
  const [lon, lat] = worldToLonLat(hit.x, hit.z), s = engine.slopeAt(hit.x, hit.z);
  const where = hit.surface === 'google' ? 'altitude de la surface Google 3D (arbres, bâtiments et neige compris, ±quelques m)' : `relief ${SRC[s?.src] ?? 'IGN'}`;
  const meta = `<p class="cmeta">${lat.toFixed(5)}° N · ${lon.toFixed(5)}° E · ${where}</p>`
    + (s ? `<p class="cline"><b>${s.deg < 3 ? 'Terrain plat' : `Pente ${Math.round(s.deg)}°`}</b>${s.deg >= 3 ? ` orientée ${compass16(s.aspect)}` : ''} <span class="small">· mesurée sur ${s.step < 10 ? t1(s.step) : fmt(s.step)} m, terrain nu</span></p>` : '')
    + sunlitText(hit.x, hit.z) + riseSetText(hit.x, hit.z) + beraAtText(hit.h, s);
  $('ptTitle').textContent = `${fmt(hit.h)} m`;
  $('ptOut').innerHTML = meta + '<p class="cmeta">Récupération des conditions…</p>';
  const [f, sat] = await Promise.all([pointForecast(lat, lon, hit.h).catch(e => ({ error: why(e) })), satSnowAt(lat, lon).catch(() => null)]);
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
$('sheet-point').querySelector('.close').addEventListener('click', () => { $('sheet-point').hidden = true; pin = null; $('pin').hidden = true; syncSheetOpen(); });

// ---------- sun on a face: when the sun reaches this point on the day shown, with the relief's shadows ----------
// Every 10 minutes from 4 h to 22 h: the sun above the horizon, in front of the slope (its normal), and not hidden
// by the relief along its direction (marched up to 25 km over the loaded relief, earth curvature included).
function sunlitIntervals(x, z) {
  const h0 = groundAt(x, z); if (h0 == null) return null;
  const s = engine.slopeAt(x, z), [lon, lat] = worldToLonLat(x, z), r = Math.PI / 180;
  const sl = (s?.deg ?? 0) * r, asp = (s?.aspect ?? 0) * r, n = [Math.sin(asp) * Math.sin(sl), Math.cos(sl), -Math.cos(asp) * Math.sin(sl)];
  const day = lightingNow(); day.setHours(0, 0, 0, 0);
  const out = []; let cur = null;
  for (let m = 240; m <= 1320; m += 10) {
    const t = new Date(+day + m * 60e3), { az, el } = sunPosition(t, lat, lon);
    const d = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
    let lit = el > 0.004 && n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0.02;
    if (lit) for (let k = 12; k < 25000; k *= 1.1) {
      const g = groundAt(x + Math.sin(az) * k, z - Math.cos(az) * k); if (g == null) break;
      if (g - k * k / (2 * 6371000) * 0.87 > h0 + 1 + k * Math.tan(el)) { lit = false; break; }
    }
    if (lit && !cur) cur = { from: t }; if (!lit && cur) { cur.to = t; out.push(cur); cur = null; }
  }
  if (cur) { cur.to = new Date(+day + 1320 * 60e3); out.push(cur); }
  return out;
}
// sunrise and sunset there on the day shown, with the direction they come from (for photos), horizon flat
function riseSetText(x, z) {
  const [lon, lat] = worldToLonLat(x, z), day = lightingNow(), rise = sunrise(day, lat, lon), set = sunTimes(day, lat, lon).sunset;
  if (!rise || !set) return '';
  const dirOf = t => { const a = sunPosition(t, lat, lon).az * 180 / Math.PI; return `${compass16(a)}, ${Math.round(a)}°`; };
  return `<p class="cline small">Lever du soleil ${hhmm(rise)} (${dirOf(rise)}) · coucher ${hhmm(set)} (${dirOf(set)}) <span class="small">· sur un horizon plat ; les montagnes le cachent plus tôt ou plus tard (plages « au soleil » ci-dessus)</span></p>`;
}
function sunlitText(x, z) {
  const iv = sunlitIntervals(x, z); if (!iv) return '';
  const day = lightingNow().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  if (!iv.length) return `<p class="cline">Pas de soleil direct ici le ${day} (face à l'ombre ou cachée par le relief).</p>`;
  const tot = iv.reduce((a, i) => a + (i.to - i.from), 0) / 3600e3;
  return `<p class="cline">Au soleil le ${day} : <b>${iv.map(i => `${hhmm(i.from)} → ${hhmm(i.to)}`).join(', ')}</b> (${hm(tot)} en tout) <span class="small">· à 10 min près, ombres du relief comprises, nuages non comptés</span></p>`;
}

// ---------- line of sight between two points ----------
const los = { tap: null, a: null, b: null, line: null };
function losCompute() {
  const { a, b } = los; if (!a || !b) return;
  const ha = (groundAt(a.x, a.z) ?? a.h) + 1.7, hb = (groundAt(b.x, b.z) ?? b.h) + 1.7, L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(20, Math.ceil(L / 8));
  let block = null;
  for (let i = 1; i < n; i++) {
    const f = i / n, x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
    if (f * L < 15 || (1 - f) * L < 15) continue; // the first and last metres are the ground one stands on
    const g = groundAt(x, z); if (g == null) continue;
    const ray = ha + (hb - ha) * f - (f * L) * ((1 - f) * L) / (2 * 6371000) * 0.87; // curvature, with refraction
    if (g > ray + 0.5) { block = { x, z, h: g, d: f * L }; break; }
  }
  if (los.line) { scene.remove(los.line); los.line.geometry.dispose(); }
  const end = block ?? { x: b.x, z: b.z, h: hb - 1.7 };
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, ha * state.exag, a.z), new THREE.Vector3(end.x, (block ? end.h + 1 : hb) * state.exag, end.z)]);
  los.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: block ? 0xff4a3d : 0x3ddc84, depthTest: false })); los.line.renderOrder = 12; scene.add(los.line);
  $('losOut').innerHTML = block ? `<b style="color:#ff6a5d">Pas de vue</b> : le relief cache le point à ${fmt(block.d)} m du départ (altitude ${fmt(block.h)} m). Distance ${t1(L / 1000)} km.`
    : `<b style="color:#3ddc84">Vue dégagée</b> sur ${t1(L / 1000)} km (de ${fmt(ha - 1.7)} m à ${fmt(hb - 1.7)} m), à hauteur d'yeux.`;
}
// the point aimed at, then the answer: on the map (green or red line) and in a message, the details in "Rando"
function losAim() {
  startPick('Touche maintenant le point à viser (ou son nom).', hit => {
    los.b = { x: hit.x, z: hit.z, h: hit.h }; losCompute();
    toast($('losOut').textContent, false, 5000); $('d-los').open = true;
  });
}
$('losFromTap').addEventListener('click', () => startPick("Touche l'endroit d'où l'on regarde (ou son nom).", hit => { los.a = { x: hit.x, z: hit.z, h: hit.h }; losAim(); }));
$('losToTap').addEventListener('click', () => { if (!los.a) { $('losOut').textContent = "Choisis d'abord d'où l'on regarde."; return; } losAim(); });
$('losFromGps').addEventListener('click', () => {
  const p = gps.pos; if (!p) { if (!gps.on) { gpsCentered = true; gps.start(); } $('losOut').textContent = 'Recherche de ta position… touche à nouveau dans un instant.'; return; }
  los.a = { x: p.x, z: p.z, h: groundAt(p.x, p.z) ?? p.gpsAlt ?? 0 }; losAim();
});

// ---------- emergency: the position, to say or send ----------
const dms = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60; return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}" ${v >= 0 ? pos : neg}`; };
function sosText() {
  const p = gps.pos; if (!p) return null;
  const g = groundAt(p.x, p.z);
  return `Position ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} (${dms(p.lat, 'N', 'S')} ${dms(p.lon, 'E', 'O')})${g != null ? `, altitude ${Math.round(g)} m` : ''}, précision ${Math.round(p.acc)} m, à ${hhmm(p.time)}`;
}
function renderSos() {
  const t = sosText();
  $('sosInfo').textContent = t ? t + '. Le 112 marche sur tous les réseaux, même sans carte SIM.' : (gps.on ? 'Recherche de ta position GPS…' : "Le 112 marche sur tous les réseaux, même sans carte SIM ; il oriente vers le secours en montagne (PGHM, CRS). Touche « Copier ma position » pour l'obtenir.");
  $('sosSms').href = t ? `sms:?&body=${encodeURIComponent('Besoin d\'aide en montagne. ' + t + ' https://www.openstreetmap.org/?mlat=' + gps.pos.lat.toFixed(5) + '&mlon=' + gps.pos.lon.toFixed(5))}` : 'sms:';
}
$('sosCopy').addEventListener('click', async () => {
  if (!gps.pos) { if (!gps.on) { gpsCentered = true; gps.start(); } renderSos(); return; }
  try { await navigator.clipboard.writeText(sosText()); $('sosInfo').textContent = 'Position copiée : ' + sosText(); } catch { renderSos(); }
});
setInterval(() => { if (!$('sheet-route').hidden) renderSos(); }, 5000);

// ---------- sharing a view: a link that opens the app at the same place, same angle ----------
$('shareView').addEventListener('click', async () => {
  const T = controls.target, [lon, lat] = worldToLonLat(T.x, T.z), c = controls.cur;
  const url = `${location.origin}${location.pathname}?site=${SITE.id}&vue=${lon.toFixed(5)},${lat.toFixed(5)},${Math.round(T.y / state.exag)},${Math.round(c.d)},${(c.h * 180 / Math.PI).toFixed(1)},${(c.p * 180 / Math.PI).toFixed(1)}`;
  try { if (navigator.share) { await navigator.share({ title: `${SITE.name} 3D`, url }); $('shareNote').textContent = 'Lien partagé.'; return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); $('shareNote').textContent = 'Lien copié : ' + url; } catch { $('shareNote').textContent = url; }
});
// a shared link: the view it holds instead of the summit's default one
function sharedView() {
  const v = new URLSearchParams(location.search).get('vue')?.split(',').map(Number); if (!v || v.length < 6 || v.some(isNaN)) return false;
  const [lon, lat, alt, d, h, p] = v, [x, z] = lonLatToWorld(lon, lat), r = Math.PI / 180, t = new THREE.Vector3(x, alt * state.exag, z);
  const off = new THREE.Vector3(Math.sin(p * r) * Math.sin(h * r), Math.cos(p * r), Math.sin(p * r) * Math.cos(h * r)).multiplyScalar(d);
  engine.ensureRoots(x, z, 45000); startFly(t, t.clone().add(off), 2000); return true;
}

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
// tiles along an itinerary for the offline use of one outing: a corridor that narrows as the detail grows
// (4 km each side up to zoom 14, then 2 km, 1 km, 500 m, and 200 m at the finest photos, zoom 19)
function routeTiles() {
  const S = route.samples; if (S.length < 2) return [];
  const keys = new Set(), out = [], W = { 11: 4000, 12: 4000, 13: 4000, 14: 4000, 15: 2000, 16: 2000, 17: 1000, 18: 500, 19: 200 };
  for (let z = 11; z <= 19; z++) {
    let last = -1e9;
    for (const s of S) {
      if (s.d - last < Math.min(100, W[z] / 2) && s !== S[S.length - 1]) continue; last = s.d;
      const [lon, lat] = worldToLonLat(s.x, s.z), dLat = W[z] / 111000, dLon = W[z] / (111000 * Math.cos(lat * Math.PI / 180));
      const [x0, y0] = lonLatToTile(lon - dLon, lat + dLat, z), [x1, y1] = lonLatToTile(lon + dLon, lat - dLat, z);
      for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let x = Math.floor(x0); x <= Math.floor(x1); x++) { const k = `${z}/${x}/${y}`; if (!keys.has(k)) { keys.add(k); out.push([z, x, y]); } }
    }
  }
  return out;
}
$('routePack').addEventListener('click', async () => {
  const list = routeTiles(); if (!list.length) { $('routePackInfo').textContent = "Charge d'abord un itinéraire (rando, topo, GPX ou tracé)."; return; }
  // the paths, huts, streams and glaciers along the way too (their cells are kept in the same store)
  for (const s of route.samples.filter((_, i) => i % 50 === 0)) { trails.ensure(s.x, s.z); streams.ensure(s.x, s.z); refuges.ensure(s.x, s.z); glaciers.ensure(s.x, s.z); }
  await runPack(list, $('routePackInfo'), $('routePack'));
});
async function runPack(list = packTiles(packChoice), info = $('packInfo'), btn = $('packGo')) {
  if (!self.isSecureContext || !self.caches) { info.textContent = "Le hors ligne demande une adresse https (ou l'ordinateur lui-même, via lancer.bat)."; return; }
  if (packRun) { info.textContent = 'Un téléchargement est déjà en cours.'; return; }
  navigator.storage?.persist?.();
  const run = packRun = { stop: false, done: 0, fail: 0 };
  btn.disabled = true; $('packStop').hidden = false;
  let next = 0;
  const worker = async () => {
    while (!run.stop && next < list.length) {
      const [z, x, y] = list[next++];
      const urls = [photoUrl(z, x, y), z <= 13 ? terrariumUrl(z, x, y) : elevRequest(z, x, y).url(LIDAR_LAYER)];
      try { for (const u of urls) { const r = await cachedFetch(u); if (!r.ok && r.status !== 404) throw 0; await r.arrayBuffer(); } } catch { run.fail++; }
      run.done++;
      if (run.done % 10 === 0 || run.done === list.length) {
        $('packBar').style.width = (run.done / list.length * 100) + '%';
        info.textContent = `${run.done.toLocaleString('fr-FR')} / ${list.length.toLocaleString('fr-FR')} tuiles (environ ${mo(list.length * KB_PER_TILE)})${run.fail ? ` · ${run.fail} échecs (relancer pour les reprendre)` : ''}`;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  info.textContent = run.stop ? `Arrêté à ${run.done.toLocaleString('fr-FR')} tuiles. Relancer reprend là où ça s'est arrêté.` : `Terminé : ${list.length.toLocaleString('fr-FR')} tuiles disponibles hors ligne${run.fail ? ` (${run.fail} échecs, relancer pour les reprendre)` : ''}.`;
  packRun = null; btn.disabled = false; $('packStop').hidden = true; showStorage();
}
document.querySelectorAll('[data-pack]').forEach(b => b.addEventListener('click', () => { packChoice = b.dataset.pack; markSeg('pack', packChoice); showPack(); }));
markSeg('pack', packChoice); showPack(); showStorage();
$('packGo').addEventListener('click', () => runPack());
$('packStop').addEventListener('click', () => { if (packRun) packRun.stop = true; });
function showPtStore() { $('ptStore').textContent = `Points gardés sur l'appareil : ${mo(lidar.store.used / 1000)} sur ${mo(lidar.store.limit / 1000)} autorisés.`; }
document.querySelectorAll('[data-ptlimit]').forEach(b => b.addEventListener('click', async () => { markSeg('ptlimit', b.dataset.ptlimit); await lidar.store.setLimit(LIMITS[+b.dataset.ptlimit]); showPtStore(); showStorage(); }));
markSeg('ptlimit', String(Math.max(0, LIMITS.indexOf(lidar.store.limit)))); showPtStore();
$('ptClear').addEventListener('click', async () => { await lidar.clear(); showPtStore(); showStorage(); });
$('cacheClear').addEventListener('click', async () => {
  if ($('cacheClear').dataset.armed !== '1') { $('cacheClear').dataset.armed = '1'; $('cacheClear').textContent = 'Confirmer : tout effacer'; setTimeout(() => { $('cacheClear').dataset.armed = ''; $('cacheClear').textContent = 'Vider le stockage'; }, 4000); return; }
  await caches.delete(TILE_CACHE).catch(() => { }); resetTileCache(); await lidar.clear(); showPtStore();
  $('cacheClear').dataset.armed = ''; $('cacheClear').textContent = 'Vider le stockage'; showStorage();
});

// labels
const proj = new THREE.Vector3();
const labView = { cam: new THREE.Matrix4(), proj: new THREE.Matrix4(), w: 0, h: 0, pass: 0 };
let frameN = 0;
function updateLabels() {
  updateRouteMarks();
  if (pin) {
    proj.set(pin.x, pin.h * state.exag, pin.z).project(camera);
    const on = proj.z < 1 && Math.abs(proj.x) < 1.2 && Math.abs(proj.y) < 1.2;
    $('pin').hidden = !on;
    if (on) $('pin').style.transform = `translate(${(proj.x * 0.5 + 0.5) * stage.clientWidth}px, ${(-proj.y * 0.5 + 0.5) * stage.clientHeight}px)`;
  }
  if (!state.labels) return;
  const w = stage.clientWidth, h = stage.clientHeight, cam = camera.position;
  // the view still: the names stay where they are (hundreds of them, a real cost on phones); looked at again now and then
  const still0 = labView.cam.equals(camera.matrixWorld) && labView.proj.equals(camera.projectionMatrix) && labView.w === w && labView.h === h, still = still0 && frameN % 15 !== 0;
  labView.cam.copy(camera.matrixWorld); labView.proj.copy(camera.projectionMatrix); labView.w = w; labView.h = h;
  if (still) return;
  labView.pass++; // checks spread over the passes (not the frames: while still, only one frame in 15 runs this)
  PLACES.forEach((p, i) => {
    if ((labView.pass + i) % 20 === 0 && (p.area || ((p.hut || p.cam) && !p.alt))) { const g = groundAt(p.x, p.z); if (g != null) p.h = g + (p.area ? 80 : 0); }
    if (p.fall && !streams.on) { p.el.classList.add('hidden'); return; }
    const y = p.h * state.exag;
    proj.set(p.x, y, p.z).project(camera);
    const on = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
    if (on && (labView.pass + i) % (still0 ? 1 : 10) === 0) {
      const dx = p.x - cam.x, dy = y - cam.y, dz = p.z - cam.z, L = Math.hypot(dx, dy, dz);
      // water points, tricky passages and waterfalls only close by (like on a paper map), huts within 9 km
      const far = p.rinfo?.kind === 'eau' || p.rinfo?.kind === 'passage' || p.fall ? 3000 : p.small ? 9000 : p.area ? 14000 : 40000;
      // The answer hesitated on ridge edges and at the summit itself (the line of sight grazing the rock): names
      // blinked several times a second (measured: 399 changes in 25 s for the Aiguille du Midi). So: a margin
      // that differs to hide and to show again, the last 80 m before the name ignored (its own summit), a change
      // only once three checks in a row agree (about half a second).
      const was = !!p.hidden, margin = (was ? -4 : 12) + L * 0.004, fEnd = Math.min(0.94, 1 - 80 / L);
      let hid = L > far * (was ? 0.95 : 1.05) || L < 60;
      for (let s = 1; s < 48 && !hid; s++) { const f = s / 48 * fEnd, g = groundAt(cam.x + dx * f, cam.z + dz * f); if (g != null && g * state.exag > cam.y + dy * f + margin) hid = true; }
      if (hid !== was) { if ((p.flip = (p.flip || 0) + 1) >= 3) { p.hidden = hid; p.flip = 0; } } else p.flip = 0;
    }
    // always a true/false: toggle(name, undefined) flips the class instead, and every summit name (p.hut undefined)
    // blinked at the frame rate
    p.el.classList.toggle('hidden', !on || !!p.hidden || !!(p.hut && !trails.on) || !!(p.cam && !state.webcams));
    if (on) p.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px, ${(-proj.y * 0.5 + 0.5) * h}px)`;
  });
}

// ---------- loop ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return; // hidden (background tab, app starting): keep the last good size, never divide by zero
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); route?.setResolution(w, h); trails?.setResolution(w, h); track?.setResolution(w, h); streams?.setResolution(w, h); pistes?.setResolution(w, h);
  SU.proj.value = h * renderer.getPixelRatio() / (2 * Math.tan(camera.fov * Math.PI / 360));
}
// a new size (phone turned, foldable opened or closed, window resized): the pixel budget is shared out again
let rescale = null;
const onResize = () => { resize(); clearTimeout(rescale); rescale = setTimeout(applyScale, 250); };
addEventListener('resize', onResize);
// the stage can change size without a window resize (a hidden tab coming back, the phone's bars appearing)
new ResizeObserver(onResize).observe(stage);
applyQuality(state.quality);
// the frame clock; connected to the page so that time spent hidden does not come back as one huge step (not with
// ?debugloop, whose whole point is to keep drawing in a hidden tab)
const timer = new THREE.Timer(); if (!location.search.includes('debugloop')) timer.connect(document);
let fpsAcc = 0, fpsN = 0, adAcc = 0, adN = 0, started = false;
// ?debugloop keeps rendering in a hidden tab (for automated checks); normal use follows the display refresh
const nextFrame = location.search.includes("debugloop") ? cb => setTimeout(cb, 16) : cb => requestAnimationFrame(cb);
// Pace: at most 60 images/s (120 Hz screens would draw twice as often for nothing but heat and battery), and 30
// when nothing moves (no gesture, flight, loading or falling snow for a few seconds): the clouds and water still
// move, the phone keeps cool for when it is needed. Any touch brings the full pace back at once.
// The display's refresh is measured (frames skipped cost nothing, so the ticks keep its pace); one tick in
// "every" is drawn: 2 on a 120 Hz screen, 1 at 60 or 90 Hz (an uneven 11/22 ms pace would judder).
let lastActive = performance.now(), idle = false, tickMs = 16.7, lastTick = 0, ticks = 0;
const camWas = new THREE.Matrix4();
const wake = () => { lastActive = performance.now(); };
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) addEventListener(ev, wake, { passive: true });
function paceOk(now) {
  if (lastTick) { const d = now - lastTick; if (d < 60) tickMs += (d - tickMs) * 0.05; }
  lastTick = now;
  idle = now - lastActive > 3000 && !fly && !flyRoute && !sight.on && !snow.visible && !rain.visible && !engine.busy && !draw.busy;
  const every = Math.max(1, Math.floor(1000 / tickMs / (idle ? 30 : 60) + 0.25));
  if (++ticks < every) return false;
  ticks = 0; return true;
}
// one failing frame must never freeze the app: report it once and keep drawing
let frameError = null;
function frame() {
  if (google.on) { nextFrame(frame); return; } // Google's map draws itself: ours rests (battery)
  if (paceOk(performance.now())) {
    try { drawFrame(); } catch (e) { if (String(e) !== frameError) { frameError = String(e); console.error(e); } }
    if (!camWas.equals(camera.matrixWorld)) { camWas.copy(camera.matrixWorld); wake(); } // the view moving (inertia, easing) counts as activity
  }
  nextFrame(frame);
}
// the graphics memory lost (a phone short of memory, the app long in the background): say so, and start again
// once the browser gives it back (everything on the graphics chip must be rebuilt: reloading is the safe way)
renderer.domElement.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  const l = $('loader'); l.classList.remove('done'); l.querySelector('.msg').textContent = "Le téléphone a manqué de mémoire graphique : l'appli redémarre…";
});
renderer.domElement.addEventListener('webglcontextrestored', () => location.reload());
// ?prof: time spent per part of the frame (ms, summed), and draw calls, to find what costs (window.midi3d.prof)
const prof = location.search.includes('prof') ? { n: 0 } : null;
let profT = 0; const lap = k => { if (!prof) return; const n = performance.now(); prof[k] = (prof[k] || 0) + n - profT; profT = n; };
function drawFrame() {
  if (prof) { prof.n++; profT = performance.now(); renderer.info.autoReset = false; renderer.info.reset(); } // all the passes of the frame counted
  timer.update(); const dt = timer.getDelta(), t = timer.getElapsed();
  U.time.value = t;
  if (fly) {
    const f = Math.min(1, (performance.now() - fly.t0) / fly.dur), e = ease(f);
    controls.target.lerpVectors(fly.fT, fly.tT, e); camera.position.lerpVectors(fly.fP, fly.tP, e);
    camera.position.y += Math.sin(f * Math.PI) * fly.fP.distanceTo(fly.tP) * 0.1;
    if (f >= 1) fly = null;
  }
  if (sight.on) sightFrame(); else controls.update(Math.min(dt, 0.1)); // in the viewfinder the phone drives the camera
  const c = camera.position;
  const T = controls.target;
  // the sky darkens and turns bluer as one climbs: re-bake it when the altitude has changed noticeably
  if (frameN % 20 === 0 && Math.abs(c.y / state.exag - skyAlt) > 400) updateSky();
  if (frameN % 60 === 0) {
    engine.ensureRoots(T.x, T.z, 45000);
    glaciers.ensure(T.x, T.z);
    refuges.ensure(T.x, T.z);
    const far = Math.hypot(T.x, T.z) > 30000; // the weather stations only describe the massif
    if (far !== state.far) { state.far = far; updateCloudProfile(); updatePrecipForView(); }
  }
  if (pin?.search) pin.h = groundAt(pin.x, pin.z) ?? pin.h;
  const g = groundAt(c.x, c.z);
  if (g != null && c.y < g * state.exag + 4) c.y = g * state.exag + 4;
  const above = g != null ? c.y - g * state.exag : 1000, td = c.distanceTo(controls.target);
  camera.near = Math.min(Math.max(Math.min(above, td) * 0.15, 0.3), 200); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  sky.position.copy(c); clouds.position.set(c.x, 0, c.z); SU.camPos.value.copy(c);
  SU.boxSize.value = Math.min(Math.max(td * 0.9, 40), 9000);
  if (cabins.visible) { const a = cabinGeo.attributes.position.array, ph = (t * 0.02) % 2, f = ph < 1 ? ph : 2 - ph; a.set(cablePoint(0, f), 0); a.set(cablePoint(1, 1 - f), 3); cabinGeo.attributes.position.needsUpdate = true; }
  lap('debut');
  engine.update(camera);
  lap('relief');
  lidar.update(camera, controls.target, state.exag, false);
  const byPoints = (x, z) => lidar.covers(x, z);
  forest.update(camera, !state.trees, byPoints); lap('forets');
  lakes.update(camera, frameN, state.exag, false, controls.target); lap('lacs');
  buildings.update(camera, controls.target, frameN, false, byPoints); lap('batiments');
  nightLights.update(controls.target, frameN, U.night.value, state.exag, false); lap('nuit');
  // at night the red paths would outshine everything: dimmed (still there to follow)
  for (const mat of Object.values(trails.mats)) mat.opacity = 0.95 * (1 - 0.7 * U.night.value);
  gps.update(camera, groundAt, state.exag); if (gps.on && frameN % 60 === 0) renderGps();
  follow?.update(camera, groundAt, state.exag, stage.clientWidth, stage.clientHeight);
  // the numbers shown follow the relief as it arrives under the line (re-written only when they change)
  if (route.update(frameN, state.exag, engine.busy)) { const st = route.stats(); if ((st ? `${Math.round(st.dist)}|${Math.round(st.up)}|${st.complete}` : '') !== routeSig) renderRouteCard(); }
  track.update(frameN, state.exag); lap('itineraire');
  trails.update(camera, controls.target, frameN, state.exag, false); lap('sentiers');
  streams.update(camera, controls.target, frameN, state.exag, false, dt); lap('torrents');
  pistes.update(camera, state.exag, false); lap('pistes');
  weather3d.update(state.exag, state.far);
  photos.update(controls.target, frameN, state.exag, false);
  if (flyRoute) flyAlongRoute(dt);
  if (hoverNDC && frameN % 3 === 0) showPoint(pick(...hoverNDC));
  nightSky.update(camera, lightingNow(), ORIGIN.lat, ORIGIN.lon, skyU.stars.value, state.clouds ? overcast : 0, stage.clientWidth, stage.clientHeight, renderer.getPixelRatio());
  lap('divers'); updateLabels(); lap('etiquettes'); frameN++;
  if (frameN % 600 === 0 && state.hourOffset === 0) updateSky();
  if (frameN % 45 === 0) updatePrecipForView();
  // cast shadows only with the real sun on the IGN terrain (photos and Google tiles carry their own)
  // light maps of the relief (sky visibility always, cast shadows with the real sun); Google tiles carry their own
  if (started) shadows.update(controls.target, U.sunDir.value, state.exag, performance.now(), state.light === 'sun');
  else shadows.off();
  lap('ombres');
  post.render(scene, camera, t);
  lap('rendu'); if (prof) { prof.calls = renderer.info.render.calls; prof.tris = renderer.info.render.triangles; }
  // start when the IGN relief is there, or when the Google view was chosen during loading (IGN then paused)
  if (!started && (engine.roots.filter(r => r.state === 'ready').length >= engine.roots.length * 0.6 )) {
    started = true; $('loader').classList.add('done');
    // a followed position is the first thing to show; then a shared view; else the summit
    if (follow?.last) { followFlown = true; flyToLonLat(follow.last.lon, follow.last.lat); pin = null; } else if (!sharedView()) home();
    // the first opening on a device: how to move around, said once
    let seen = true; try { seen = localStorage.getItem('midi3d-hello') === '1'; localStorage.setItem('midi3d-hello', '1'); } catch { }
    if (!seen) setTimeout(() => toast(matchMedia('(pointer: coarse)').matches ? 'Un doigt déplace la carte, deux doigts zooment, tournent et inclinent. Touche le relief pour sa météo.' : 'Glisser : déplacer · molette : zoomer · clic droit : tourner et incliner. Clique le relief pour sa météo.', false, 8000), 3500);
    if (savedView === 'google' && googleKey.get()) setView('google'); // each opening of the page with the Google view = one map load billed by Google
  }
  fpsAcc += dt; fpsN++;
  // the automatic adjustment judges only the frames drawn at full pace (the 30 images/s at rest say nothing)
  if (idle) { adAcc = 0; adN = 0; } else { adAcc += dt; adN++; }
  if (adAcc > 1.5) { adaptTo(adN / adAcc); adAcc = 0; adN = 0; }
  if (fpsAcc > 0.5) {
    const auto = adapt.level > 0 ? ` · allégé ${adapt.level}/${ADAPT_STEPS.length - 1}` : '';
    $('rFps').textContent = `${Math.round(fpsN / fpsAcc)} i/s${idle ? ' (au repos)' : ''} · ${engine.tileCount ?? 0} tuiles${auto}`;
    if (!$('sheet-layers').hidden) showQualNote();
    const busy = engine.busy;
    $('status').hidden = busy === 0; $('statusN').textContent = busy;
    renderLidarInfo(); if (!$('sheet-layers').hidden) showPtStore();
    if (engine.epoch !== 'current') showEpochNote();
    fpsAcc = 0; fpsN = 0;
  }
}
// the Affichage choices are kept on the device: what was hidden stays hidden at the next opening
(() => {
  const KEY = 'midi3d-layers', boxes = [...document.querySelectorAll('#sheet-layers input[type=checkbox][id]')];
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(boxes.map(b => [b.id, b.checked])))); } catch { } };
  for (const b of boxes) {
    if (b.id in saved && saved[b.id] !== b.checked && !b.disabled) { b.checked = saved[b.id]; b.dispatchEvent(new Event('change')); }
    b.addEventListener('change', save);
  }
})();
// quick switch in the bottom bar: paths, huts, lifts and torrents together
function syncLinesBtn() { const on = $('c-trails').checked || $('c-streams').checked; $('linesBtn').setAttribute('aria-pressed', on); $('linesBtn').setAttribute('aria-label', on ? 'Sentiers et torrents affichés (toucher pour les masquer)' : 'Sentiers et torrents masqués (toucher pour les afficher)'); }
$('linesBtn').addEventListener('click', () => {
  const on = !($('c-trails').checked || $('c-streams').checked);
  for (const id of ['c-trails', 'c-streams']) if ($(id).checked !== on) { $(id).checked = on; $(id).dispatchEvent(new Event('change')); }
  syncLinesBtn(); toast(on ? 'Sentiers, refuges et torrents affichés.' : 'Sentiers, refuges et torrents masqués (plus fluide).');
});
for (const id of ['c-trails', 'c-streams']) $(id).addEventListener('change', syncLinesBtn);
syncLinesBtn();
window.midi3d = { engine, google, camera, controls, adapt, places: PLACES, planGo, trails, sky: nightSky, applyScale, forest, lakes, shadows, gps, route, sight, lidar, post, U, state, prof,
  set overcast(v) { overcast = v; U.haze.value = v; updateSky(); } }; // handy for debugging from the console
updateSky(); frame(); refreshLive();
// every 15 minutes while on screen, and at once when the app comes back after being away that long
setInterval(() => { if (document.visibilityState === 'visible') refreshLive(); }, 15 * 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.weather && Date.now() - state.weather.fetchedAt > 15 * 60e3) refreshLive(); });
addEventListener('online', () => { if (state.weather?.stale || state.s2?.stale) refreshLive(); }); // the network is back
setTimeout(() => $('loader').classList.add('done'), 15000);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
