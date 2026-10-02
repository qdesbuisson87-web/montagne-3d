import * as THREE from 'three';
import { EarthControls } from './controls.js?v=202610021708';
import { lonLatToWorld, worldToLonLat, lonLatToTile, ORIGIN } from './geo.js?v=202610021708';
import { SITE, SITE_LIST } from './sites.js?v=202610021708';
import { TerrainEngine, EPOCHS, GRID, photoUrl, terrariumUrl, elevRequest, LIDAR_LAYER } from './terrain.js?v=202610021708';
import { cachedFetch, TILE_CACHE, resetTileCache } from './net.js?v=202610021708';
import { GoogleTiles, googleKey, whyRefused } from './google3d.js?v=202610021708';
import { searchPlaces } from './search.js?v=202610021708';
import { TerrainShadows } from './shadows.js?v=202610021708';
import { PostFX } from './post.js?v=202610021708';
import { SkyBaker, SKY_LOOKUP_GLSL, skyColors } from './atmosphere.js?v=202610021708';
import { Forest } from './forest.js?v=202610021708';
import { Lakes } from './water.js?v=202610021708';
import { Glaciers } from './glaciers.js?v=202610021708';
import { NightLights } from './lights.js?v=202610021708';
import { Buildings } from './buildings.js?v=202610021708';
import { fetchBera, beraKey, RISK } from './bera.js?v=202610021708';
import { TrackRecorder, progressOn } from './track.js?v=202610021708';
import { GpsTracker } from './gps.js?v=202610021708';
import { RouteLayer, resamplePath, pathStats } from './route.js?v=202610021708';
import { walkingRoute } from './planner.js?v=202610021708';
import { buildHikes, loadHikes, hikePath, classify, CLASS_NAMES } from './hikes.js?v=202610021708';
import { loadC2C, prepare as prepareC2C, FILTERS as C2C_FILTERS, CONDITIONS as C2C_COND, ratingText, activityText, matches as c2cMatches, lineOf as c2cLine, snowText } from './c2c.js?v=202610021708';
import { TrailsLayer } from './trails.js?v=202610021708';
import { Weather3D } from './weather3d.js?v=202610021708';
import { Sight } from './sight.js?v=202610021708';
import { Photos360 } from './photos360.js?v=202610021708';
import { PointCloud, POINT_CLASSES, LIMITS } from './lidar.js?v=202610021708';
import { fetchWeather, findSentinel, sentinelYear, sunPosition, sunTimes, moonPosition, pointForecast, cloudProfile, SPOTS } from './live.js?v=202610021708';
import { VolumeClouds } from './clouds.js?v=202610021708';
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
  standard: { k: 1.6, pr: 1.25, tiles: 450, loads: 6, fps: 50, fx: 0.3, clouds: 2, gErr: 24, shRes: 512, shSteps: 80, ao: 8, trees: 12000, vSteps: 0, pts: 6e5, ptPx: 2.2 },
  haute: { k: 2.2, pr: 2, tiles: 800, loads: 8, fps: 55, fx: 0.6, clouds: 3, gErr: 12, shRes: 1024, shSteps: 112, ao: 10, trees: 40000, vSteps: 28, pts: 1.5e6, ptPx: 1.7 },
  extreme: { k: 3.2, pr: 3, tiles: 1300, loads: 12, fps: 30, fx: 1, clouds: 4, gErr: 6, shRes: 2048, shSteps: 160, ao: 16, trees: 120000, vSteps: 48, pts: 4e6, ptPx: 1.3 } // gErr: Google 3D screen error (px); sh*: shadow maps; ao: directions searched for the sky visibility; vSteps: steps through the clouds in volume (0 = flat layers); pts: LiDAR point budget, ptPx: their spacing on screen (CSS px)
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
  light: { value: 0 }, vivid: { value: 0.2 }, snowToday: { value: 1 }, visToday: { value: 0 }, slopes: { value: state.slopes ? 1 : 0 }, fogDensity: { value: 0.000016 }, haze: { value: 0 }, time: { value: 0 }
};
U.clTime = U.time; // the clouds' clock under its own name (several shaders already declare "time")
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
uniform sampler2D map, slopeMap, ndsiMap, cloudMap, visMap, forestMap, noiseTex; uniform vec4 ovRect;
uniform float historic, hasNdsi, hasCloud, hasVis, hasForest, tileSize, snowToday, visToday, slopes, vivid, time;
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
  float grainK = steep * smoothstep(25.0, 140.0, length(cameraPosition - vW));
  alb *= 1.0 + ((g1 - 0.49)*1.2 + (g2 - 0.49)*0.5) * 0.45 * grainK;
  // the same grain as a small relief (up to ~1.5 m) that the light catches: surface-gradient bump mapping
  // from screen-space derivatives, no extra geometry
  float bump = ((g1 - 0.49)*3.0 + (g2 - 0.49)*0.9) * grainK; // metres: large facets, a little finer roughness
  vec3 dpx = dFdx(vW), dpy = dFdy(vW), r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 nb = abs(det)*n - sign(det)*(dFdx(bump)*r1 + dFdy(bump)*r2);
  vec3 nl = dot(nb, nb) > 1e-20 ? normalize(nb) : n; // lit normal
  // today's snow: continuous snow index, refined at metre scale with the LiDAR slope and the photo
  float todaySnow = 0.0;
  if (snowToday > 0.5 && hasNdsi > 0.5 && historic < 0.5) {
    vec4 nd = cubic(ndsiMap, ou);
    float valid = smoothstep(0.6, 0.95, nd.a) * (1.0 - cloud);
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
  fragmentShader: `uniform vec3 sunDir, sunCol, ovGrey; uniform float overcast, stars, time; uniform sampler2D skyTex; varying vec3 vD;
    ${SKY_LOOKUP_GLSL}
    void main(){ vec3 d = normalize(vD);
      vec3 c = texture2D(skyTex, skyUv(d)).rgb;
      c = max(c, vec3(0.010, 0.014, 0.032));                                  // night: a deep blue, never pure black
      // stars once the sun is well below the horizon: one in ~300 sky cells, of varied brightness, twinkling
      if (stars > 0.0 && d.y > 0.0) {
        vec3 q = d * 380.0, cell = floor(q);
        float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453), b = fract(h * 91.7);
        float star = step(0.9967, h) * smoothstep(0.42, 0.1, length(fract(q) - 0.5)) * (0.35 + 0.65 * b * b);
        c += vec3(0.9, 0.95, 1.0) * star * stars * smoothstep(0.0, 0.15, d.y) * (0.8 + 0.2 * sin(time * 3.0 + h * 60.0)) * (1.0 - overcast);
      }
      float sg = dot(d, sunDir);                                              // the sun's disk, 0.53° across, tinted by the air
      // the sun's disk is written brighter than white: the final pass makes it glow (clipped to white without it)
      vec3 disk = min(sunCol, vec3(1.0)) * 3.0 * smoothstep(0.99994, 0.99998, sg) * step(-0.01, sunDir.y) * (1.0 - overcast);
      c = mix(c, ovGrey * (0.85 + 0.15 * clamp(d.y * 3.0, 0.0, 1.0)), overcast);
      gl_FragColor = vec4(min(c, 1.0) + disk, 1.0); }`
}));
sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);
const lakes = new Lakes({ scene, engine, uniforms: U, sceneGLSL: SCENE_GLSL, skyGLSL: SKY_LOOKUP_GLSL, skyTex: skyBaker.texture });
const buildings = new Buildings({ scene, uniforms: U, sceneGLSL: SCENE_GLSL });
const lidar = new PointCloud({ scene, uniforms: U, sceneGLSL: SCENE_GLSL, renderer });
const weather3d = new Weather3D({ scene, uniforms: U });
const photos = new Photos360({ scene, groundAt: (x, z) => engine.heightAt(x, z) });
// a Panoramax photo: preview in the point sheet, with its author, date and licence (required by CC BY-SA)
function showPhoto(p) {
  sheets.forEach(s => { $('sheet-' + s).hidden = true; $('tab-' + s).setAttribute('aria-pressed', 'false'); });
  $('sheet-point').hidden = false; pin = { x: p.x, z: p.z, h: p.h ?? 0 };
  $('ptTitle').textContent = p.pano ? 'Photo 360°' : 'Photo';
  const lic = /by-sa/i.test(p.license) ? 'CC BY-SA 4.0' : /by/i.test(p.license) ? 'CC BY' : p.license || 'licence non indiquée';
  $('ptOut').innerHTML = `${p.sd || p.thumb ? `<img class="photo" src="${esc(p.sd || p.thumb)}" alt="Photo prise ici${p.date ? ' le ' + dayName(p.date) : ''}" loading="lazy">` : ''}
    <p class="cmeta">${p.date ? p.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'date inconnue'} · © ${esc(p.author || 'contributeur Panoramax')} · ${esc(lic)}</p>
    <p class="cline"><a href="https://api.panoramax.xyz/#focus=pic&pic=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${p.pano ? 'Voir la photo à 360° et se promener' : 'Voir la photo'} sur Panoramax</a></p>`;
}
const trails = new TrailsLayer({ scene, groundAt: (x, z) => engine.heightAt(x, z), onHuts: huts => addHuts(huts) });
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
  el.addEventListener('click', () => flyToPlace(p));
  labelsEl.appendChild(el); p.el = el;
  const li = document.createElement('button'); li.type = 'button'; li.className = 'place';
  li.innerHTML = `<span>${esc(p.name)}</span><span class="pa">${p.alt ? fmt(p.alt) + ' m' : 'glacier'}</span>`;
  li.addEventListener('click', () => { flyToPlace(p); if (touch) closeSheets(); });
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
    el.addEventListener('click', () => flyToPlace(p));
    labelsEl.appendChild(el); p.el = el; PLACES.push(p);
  }
}

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
      b.addEventListener('click', () => { flyToLonLat(p.lon, p.lat); if (touch) closeSheets(); });
      $('results').appendChild(b);
    });
  } catch (err) { $('searchNote').textContent = `Recherche impossible : ${err.message}.`; }
});

// ---------- terrain queries ----------
const groundAt = (x, z) => engine.heightAt(x, z);
const google = new GoogleTiles({ scene, camera, renderer, origin: ORIGIN, geoidN: SITE.geoidN ?? 50 });
const rayG = new THREE.Raycaster();
// aerial perspective for the Google tiles (their materials take three.js fog), same horizon colour as the sky
const gFog = new THREE.FogExp2(0xc8d2dc, 2.3e-5);
// cam: the camera to cast from (the controls measure gestures in the view they are heading to)
function pick(ndcX, ndcY, cam = camera) {
  if (google.on) { // Google view: the surface actually on screen (buildings, trees and snow included)
    rayG.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
    const p = google.raycast(rayG); return p ? { x: p.x, z: p.z, h: p.y, surface: 'google' } : null;
  }
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
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY, performance.now()]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 8 && performance.now() - downAt[2] < 400) {
    const r = renderer.domElement.getBoundingClientRect();
    const photo = !route.drawing && photos.pick(e.clientX - r.left, e.clientY - r.top, camera, r.width, r.height);
    if (photo) { showPhoto(photo); return; }
    const hit = pick((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    if (!hit) return;
    showPoint(hit);
    if (plan.tap) { planTap(hit); return; } // choosing an itinerary's start or destination
    if (route.drawing) { route.add(hit.x, hit.z); renderRoute(); return; } // drawing an itinerary: each tap is a point
    if (!pickAt(hit)) pointReport(hit);
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
  gFog.color.setRGB(...hor); gFog.density = 2.3e-5 * (1 + overcast * 1.1);
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
  el.innerHTML = `<p class="cmeta">Météo-France (AROME/ARPEGE) · reçu ${W.fetchedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
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
async function loadBera() {
  const el = $('bera');
  if (!SITE.bra) { el.innerHTML = '<p class="cline small">Pas de bulletin Météo-France pour ce massif.</p>'; return; }
  if (!beraKey.get()) { el.innerHTML = ''; $('beraKeyBlock').hidden = false; return; }
  el.innerHTML = '<p class="cmeta">Récupération du bulletin…</p>';
  try { renderBera(await fetchBera(SITE.bra)); }
  catch (e) {
    const msg = { key: "Météo-France refuse la clé : vérifie que c'est bien une « API Key » (pas un jeton OAuth, qui expire en 1 h), copiée en entier, et que l'API « DonneesPubliquesBRA » est souscrite.", none: "Météo-France n'a pas de bulletin pour ce massif en ce moment (ils paraissent de novembre à mai) : la clé fonctionne.", network: 'Bulletin indisponible : pas de connexion et aucun bulletin gardé sur cet appareil.' }[e.kind] ?? 'Bulletin indisponible.';
    el.innerHTML = `<p class="cline">${msg}</p><p class="cline small">Réponse de Météo-France : ${esc(e.message)}</p><button type="button" class="mini wide" data-bera-key>Changer la clé Météo-France</button>`;
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
  h += `<p class="cnote">Bulletin d'estimation du risque d'avalanche de Météo-France, reproduit tel quel. Il ne remplace ni la lecture du bulletin complet${link ? ` (<a href="${link}" target="_blank" rel="noopener">voir sur Météo-France</a>)` : ''}, ni l'observation sur le terrain.</p><button type="button" class="mini wide" data-bera-key>Changer la clé Météo-France</button></div>`;
  $('bera').innerHTML = h;
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
  const e = film.list[i]; film.i = i; $('filmRange').value = i;
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
  } catch (err) { $('filmLoad').disabled = false; $('filmLoad').textContent = `Échec (${err.message}) — réessayer`; }
});
$('filmRange').addEventListener('input', e => showFilmFrame(+e.target.value));
$('filmPlay').addEventListener('click', () => {
  if (film.timer) { clearInterval(film.timer); film.timer = null; $('filmPlay').textContent = 'Lecture'; return; }
  $('filmPlay').textContent = 'Pause';
  film.timer = setInterval(() => showFilmFrame((film.i + 1) % film.list.length), 5000); // time for the satellite tiles to arrive
});
$('filmBack').addEventListener('click', () => {
  if (film?.timer) { clearInterval(film.timer); film.timer = null; $('filmPlay').textContent = 'Lecture'; }
  if (state.s2?.clear) engine.setOverlayItem(state.s2.clear);
  $('filmNote').textContent = state.s2?.clear ? `Retour à la dernière image nette (${dayName(state.s2.clear.date)}).` : '';
});

async function refreshLive() {
  loadBera();
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
const sheets = ['places', 'cond', 'route', 'layers'];
function openSheet(name) {
  $('sheet-point').hidden = true;
  sheets.forEach(s => { const on = s === name && $('sheet-' + s).hidden; $('sheet-' + s).hidden = !on; $('tab-' + s).setAttribute('aria-pressed', on); });
}
function closeSheets() { sheets.forEach(s => { $('sheet-' + s).hidden = true; $('tab-' + s).setAttribute('aria-pressed', 'false'); }); }
sheets.forEach(s => { $('tab-' + s).addEventListener('click', () => openSheet(s)); $('sheet-' + s).querySelector('.close').addEventListener('click', closeSheets); });

// ---------- "Sortie": my position, an itinerary (GPX or drawn), its profile and numbers, a flight along it ----------
const gps = new GpsTracker({ scene, onChange: renderGps });
const route = new RouteLayer({ scene, groundAt });
const track = new TrackRecorder({ scene, groundAt });
let gpsCentered = false, flyRoute = null;
const ago2 = d => { const s = (Date.now() - d) / 1000; return s < 60 ? `il y a ${Math.round(s)} s` : `il y a ${Math.round(s / 60)} min`; };
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
  if (typeof renderPlan === 'function' && $('plFrom')) renderPlan();
  tripFix();
}

// ---------- following an outing: recording, what remains, alerts ----------
const trip = { off: 0, offAlert: false, sunAlert: false, sun: null, sunDay: '' };
const hhmm = d => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const buzz = p => { try { navigator.vibrate?.(p); } catch { } };
function tripFix() {
  const p = gps.pos; if (!p) { renderTrip(); return; }
  track.addFix(p);
  const prog = route.samples.length > 1 ? progressOn(route.samples, p.x, p.z) : null;
  // off the itinerary: farther than 60 m beyond the GPS uncertainty on three fixes in a row
  if (prog && prog.off > 60 + p.acc) { if (++trip.off >= 3 && !trip.offAlert) { trip.offAlert = true; buzz([200, 100, 200]); } }
  else { trip.off = 0; trip.offAlert = false; }
  trip.prog = prog;
  // the day's sunset where one stands (computed once a day)
  const day = new Date().toDateString(); if (trip.sunDay !== day) { trip.sun = sunTimes(new Date(), p.lat, p.lon); trip.sunDay = day; }
  renderTrip();
}
function renderTrip() {
  const lines = [], st = track.stats(), prog = trip.prog, p = gps.pos;
  if (track.recording && st) lines.push(`<span class="rec">● Enregistrement</span> · ${t1(st.dist / 1000)} km · +${fmt(st.up)} m · ${hm(st.hours)}${st.speed != null ? ` · ${t1(st.speed)} km/h` : ''}`);
  if (prog && gps.on) {
    // own pace: the time taken so far against the standard time of the part walked (once it means something)
    let pace = 1;
    if (track.recording && st && prog.doneHours > 0.25 && st.hours > 0.25) pace = Math.min(2.5, Math.max(0.5, st.hours / prog.doneHours));
    const hoursLeft = prog.hours * pace, eta = new Date(Date.now() + hoursLeft * 3600e3);
    lines.push(prog.left < 30 ? "Arrivé au bout de l'itinéraire." : `Reste ${t1(prog.left / 1000)} km · +${fmt(prog.up)} m · −${fmt(prog.down)} m · ${hm(hoursLeft)}${pace !== 1 ? ' à ton rythme' : ''} → arrivée vers ${hhmm(eta)}`);
    if (trip.offAlert) lines.push(`<span class="bad">Tu t'écartes de l'itinéraire : à ${fmt(prog.off)} m de la ligne.</span>`);
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
  $('trkGo').textContent = track.recording ? "Arrêter l'enregistrement" : track.pts.length ? "Reprendre l'enregistrement" : "Démarrer l'enregistrement";
  if (st && !track.recording) $('trkInfo').textContent = `Trace gardée : ${t1(st.dist / 1000)} km, +${fmt(st.up)} m, ${fmt(st.count)} points. L'écran reste allumé pendant l'enregistrement : verrouillé, le téléphone met l'appli en pause et la trace s'interrompt.`;
}
$('trkGo').addEventListener('click', () => {
  if (track.recording) track.stop();
  else { track.start(); if (!gps.on) { gpsCentered = false; gps.start(); } }
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
function renderRoute() {
  route.drape(state.exag);
  const st = route.stats(), n = route.pts.length;
  $('drawGo').setAttribute('aria-pressed', route.drawing); $('drawGo').textContent = route.drawing ? 'Terminer le tracé' : 'Tracer / mesurer';
  for (const id of ['drawUndo', 'flyGo', 'gpxOut', 'routeClear']) $(id).disabled = n < (id === 'drawUndo' || id === 'routeClear' ? 1 : 2);
  if (!st) { $('routeOut').innerHTML = route.drawing ? `<p class="cline small">${n ? `${n} point${n > 1 ? 's' : ''} : touche le point suivant.` : 'Touche le relief pour poser le premier point.'}</p>` : ''; return; }
  $('routeOut').innerHTML = `${route.name ? `<p class="cline"><b>${esc(route.name)}</b></p>` : ''}
    <div class="kpis">
      <div><span>Distance</span><b>${(st.dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km</b></div>
      <div><span>Temps estimé</span><b>${hm(st.hours)}</b></div>
      <div><span>Dénivelé +</span><b>${fmt(st.up)} m</b></div>
      <div><span>Dénivelé −</span><b>${fmt(st.down)} m</b></div>
      <div><span>Point haut / bas</span><b>${fmt(st.max)} / ${fmt(st.min)} m</b></div>
      <div><span>Pente la plus raide</span><b>${Math.round(st.steepDeg)}°</b></div>
    </div>
    ${route.profileSVG()}
    <p class="cnote">Altitudes du relief LiDAR IGN sous le tracé${st.complete ? '' : ' (partiel : une partie du relief n\'est pas encore chargée)'}. Temps selon la norme DIN 33466 (randonneur moyen, sans pauses) ; pente maxi mesurée sur 30 m.</p>`;
}
$('drawGo').addEventListener('click', () => { route.drawing = !route.drawing; renderRoute(); if (route.drawing && touch) closeSheets(); });
$('drawUndo').addEventListener('click', () => { route.undo(); renderRoute(); });
$('routeClear').addEventListener('click', () => { route.clear(); route.drawing = false; renderRoute(); });
$('gpxIn').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
  try { route.importGPX(await f.text(), f.name); route.drawing = false; renderRoute(); frameRoute(); }
  catch (err) { $('routeOut').innerHTML = `<p class="cline">Import impossible : ${esc(err.message)}.</p>`; }
});
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
const plan = { from: null, to: null, tap: null }; // from null = my position
const llName = p => p.name ?? `${p.lat.toFixed(4)}° N, ${p.lon.toFixed(4)}° E`;
function planStart() { return plan.from ?? (gps.pos ? { lon: gps.pos.lon, lat: gps.pos.lat, name: 'ma position' } : null); }
function renderPlan() {
  $('plFrom').textContent = plan.from ? llName(plan.from) : gps.pos ? 'ma position' : 'ma position (localisation à activer, ou choisis un autre départ)';
  $('plTo').textContent = plan.to ? llName(plan.to) : 'à choisir';
}
$('plFromGps').addEventListener('click', () => { plan.from = null; if (!gps.on) { gpsCentered = true; gps.start(); } renderPlan(); });
$('plFromTap').addEventListener('click', () => { plan.tap = 'from'; $('plNote').textContent = 'Touche le relief à l\'endroit du départ.'; if (touch) closeSheets(); });
$('plToTap').addEventListener('click', () => { plan.tap = 'to'; $('plNote').textContent = 'Touche le relief à l\'endroit de l\'arrivée.'; if (touch) closeSheets(); });
$('plFromCenter').addEventListener('click', () => {
  const h = pick(0, 0); if (!h) return;
  const [lon, lat] = worldToLonLat(h.x, h.z); plan.from = { lon, lat, name: `centre de l'écran (${fmt(h.h)} m)` }; renderPlan();
});
// a tap on the relief while choosing a start or a destination (called from the tap handler)
function planTap(hit) {
  const [lon, lat] = worldToLonLat(hit.x, hit.z);
  plan[plan.tap] = { lon, lat, name: `point touché (${fmt(hit.h)} m)` }; plan.tap = null; $('plNote').textContent = '';
  renderPlan(); openSheet('route');
}
$('plSearch').addEventListener('submit', async e => {
  e.preventDefault(); const q = $('plQ').value.trim(); if (q.length < 2) return;
  $('plQ').blur(); $('plResults').innerHTML = ''; $('plNote').textContent = 'Recherche…';
  try {
    const s = planStart() ?? (() => { const [lon, lat] = worldToLonLat(controls.target.x, controls.target.z); return { lon, lat }; })();
    const list = await searchPlaces(q, s); $('plNote').textContent = list.length ? '' : `Aucun lieu trouvé pour « ${q} ».`;
    list.forEach(p => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'place';
      b.innerHTML = `<span>${esc(p.name)}</span><span class="pa">${esc(p.detail || p.src)}</span>`;
      b.addEventListener('click', () => { plan.to = { lon: p.lon, lat: p.lat, name: p.name }; $('plResults').innerHTML = ''; renderPlan(); });
      $('plResults').appendChild(b);
    });
  } catch (err) { $('plNote').textContent = `Recherche impossible : ${err.message}.`; }
});
function offPathNote(r, toName) {
  const bits = [];
  if (r.offStart > 60) bits.push(`le départ est à ${fmt(r.offStart)} m du sentier le plus proche`);
  if (r.offEnd > 60) bits.push(`les sentiers s'arrêtent à ${fmt(r.offEnd)} m ${toName ? `de ${toName}` : "de l'arrivée"} (au-delà, terrain hors sentier : non tracé)`);
  return bits.length ? bits.join(' ; ') + '.' : '';
}
async function planGo(from, to) {
  $('plNote').textContent = "Calcul de l'itinéraire par l'IGN…";
  try {
    const r = await walkingRoute(from, to);
    route.setPath(r.pts, `${from.name ?? 'Départ'} → ${to.name ?? 'Arrivée'}`); renderRoute(); frameRoute();
    $('plNote').textContent = ['Itinéraire IGN sur sentiers et chemins : vérifie l\'état (neige, fermetures, difficulté) avant de partir.', offPathNote(r, to.name)].filter(Boolean).join(' ');
  } catch (err) { $('plNote').textContent = `Itinéraire impossible : ${err.message}.`; }
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
    b.addEventListener('click', () => { route.setPath(o.r.pts, `${from.name ?? 'Départ'} → ${o.name}`); renderRoute(); frameRoute(); $('plNote').textContent = offPathNote(o.r, o.name); if (touch) closeSheets(); });
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
  const box = $('hkList'); box.innerHTML = '';
  for (const h of shown) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'place';
    b.innerHTML = `<span>${esc(h.name)}${h.alt ? ` · ${fmt(h.alt)} m` : ''}</span><span class="pa"><span class="cls ${h.cls}">${CLASS_NAMES[h.cls]}</span>${h.kind} · depuis ${h.start === 'parking' ? `un parking à ${fmt(h.startAlt ?? 0)} m` : esc(h.start)} · ${hm(h.hours)} · ${(h.dist / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km · +${fmt(h.up)} m · point haut ${fmt(h.max)} m${h.offEnd > 150 ? ` · les sentiers s'arrêtent à ${fmt(h.offEnd)} m du but, la fin est hors sentier` : ''}</span>`;
    b.addEventListener('click', () => {
      route.setPath(hikePath(h), `${h.name} depuis ${h.start}`); renderRoute(); frameRoute();
      $('plNote').textContent = h.cls === 'alpine' ? "Haute montagne : glacier ou rocher, crevasses et chutes de pierres possibles. Matériel d'alpinisme, expérience et encordement nécessaires ; guide conseillé. Le tracé s'arrête au bout des sentiers." : '';
      if (touch) closeSheets();
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
  catch (err) { $('hkInfo').textContent = `Construction impossible : ${err.message}. Réessaie avec du réseau.`; }
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
  if (line) { route.setPath(line, r.t); renderRoute(); frameRoute(); }
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
$('flyGo').addEventListener('click', () => { if (route.length > 0) { flyRoute = { d: 0, speed: Math.min(160, Math.max(25, route.length / 60)) }; fly = null; if (touch) closeSheets(); } });
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
$('wxToggle').addEventListener('click', () => setWeatherShown(!state.clouds));
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
$('c-freeze').addEventListener('change', e => { weather3d.showFreeze = e.target.checked; });
$('c-photos').addEventListener('change', e => { photos.on = e.target.checked; });
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
  for (const id of ['c-slopes', 'c-snowtoday', 'c-lidar', 'exag']) $(id).disabled = g;
  $('slopeLegend').hidden = g || !state.slopes;
  $('gNote').textContent = g ? 'Vue Google 3D (photos et relief Google, en ligne seulement). La carte des pentes, la neige du jour, les points LiDAR et le relief exagéré restent dans la vue IGN : touche « IGN (LiDAR) » pour les retrouver.' : '';
  try { localStorage.setItem('midi3d-view', v); } catch { }
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
// if the official logo (icons/google-maps-logo.svg, from Google's attribution assets) fails to load, at least name Google
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
const adapt = { res: 1, detail: 1, good: 0, since: 0 };
function applyScale() {
  const Q = QUAL[state.quality]; engine.splitK = Q.k * adapt.detail; google.setErrorTarget(Q.gErr / adapt.detail);
  lidar.setQuality(Q.pts * adapt.detail * adapt.detail, Q.ptPx); // fewer LiDAR points along with the terrain detail
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
  // final pass from "Haute" up; the scene buffer multisampled where the renderer would have been (screens below 2×)
  post.setOptions({ enabled: q !== 'standard', samples: (window.devicePixelRatio || 1) < 2 ? 4 : 0 });
  vclouds.on = Q.vSteps > 0; vclouds.setQuality(Q.vSteps, q === 'extreme' ? 4 : 3);
  showCloudLayers(); applyPrecip(); shadows.setQuality(Q.shRes, Q.shSteps, Q.ao); forest.maxTrees = Q.trees; lakes.mirrorOn = q !== 'standard'; lakes.mirrorEvery = q === 'extreme' ? 2 : 3;
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
  const S = engine.overlay.item; if (!S) return null; // the pass on screen (the latest clear one, or the film's date)
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
    if ((frameN + i) % 20 === 0 && (p.area || (p.hut && !p.alt))) { const g = groundAt(p.x, p.z); if (g != null) p.h = g + (p.area ? 80 : 0); }
    const y = p.h * state.exag;
    proj.set(p.x, y, p.z).project(camera);
    const on = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
    if (on && (frameN + i) % 10 === 0) {
      const dx = p.x - cam.x, dy = y - cam.y, dz = p.z - cam.z, L = Math.hypot(dx, dy, dz);
      let hid = L > (p.small ? 9000 : p.area ? 14000 : 40000) || L < 60;
      for (let s = 1; s < 48 && !hid; s++) { const f = s / 48 * 0.94, g = groundAt(cam.x + dx * f, cam.z + dz * f); if (g != null && g * state.exag > cam.y + dy * f + 12) hid = true; }
      p.hidden = hid;
    }
    p.el.classList.toggle('hidden', !on || !!p.hidden || (p.hut && !trails.on));
    if (on) p.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px, ${(-proj.y * 0.5 + 0.5) * h}px)`;
  });
}

// ---------- loop ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return; // hidden (background tab, app starting): keep the last good size, never divide by zero
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); route?.setResolution(w, h); trails?.setResolution(w, h); track?.setResolution(w, h);
  SU.proj.value = h * renderer.getPixelRatio() / (2 * Math.tan(camera.fov * Math.PI / 360));
}
addEventListener('resize', resize);
// the stage can change size without a window resize (a hidden tab coming back, the phone's bars appearing)
new ResizeObserver(() => resize()).observe(stage);
applyQuality(state.quality);
const clock = new THREE.Clock(); let fpsAcc = 0, fpsN = 0, adAcc = 0, adN = 0, started = false, gGround = null;
// ?debugloop keeps rendering in a hidden tab (for automated checks); normal use follows the display refresh
const nextFrame = location.search.includes("debugloop") ? cb => setTimeout(cb, 16) : cb => requestAnimationFrame(cb);
// one failing frame must never freeze the app: report it once and keep drawing
let frameError = null;
function frame() {
  try { drawFrame(); } catch (e) { if (String(e) !== frameError) { frameError = String(e); console.error(e); } }
  nextFrame(frame);
}
function drawFrame() {
  const dt = clock.getDelta(), t = clock.elapsedTime;
  U.time.value = t;
  if (fly) {
    const f = Math.min(1, (performance.now() - fly.t0) / fly.dur), e = ease(f);
    controls.target.lerpVectors(fly.fT, fly.tT, e); camera.position.lerpVectors(fly.fP, fly.tP, e);
    camera.position.y += Math.sin(f * Math.PI) * fly.fP.distanceTo(fly.tP) * 0.1;
    if (f >= 1) fly = null;
  }
  if (sight.on) sightFrame(); else controls.update(Math.min(dt, 0.1)); // in the viewfinder the phone drives the camera
  const c = camera.position;
  // ground under the camera (keeps it above the surface, sets the near plane): Google's own surface in that view,
  // probed a few times per second since a ray through the tiles costs more than a grid lookup
  const T = controls.target;
  if (google.on && frameN % 6 === 0) {
    const down = (x, z) => { rayG.set(new THREE.Vector3(x, 9000, z), new THREE.Vector3(0, -1, 0)); rayG.far = 20000; const y = google.raycast(rayG)?.y ?? null; rayG.far = Infinity; return y; };
    gGround = down(c.x, c.z);
  }
  // the sky darkens and turns bluer as one climbs: re-bake it when the altitude has changed noticeably
  if (frameN % 20 === 0 && Math.abs(c.y / state.exag - skyAlt) > 400) updateSky();
  if (frameN % 60 === 0) {
    engine.ensureRoots(T.x, T.z, 45000);
    if (!google.on) glaciers.ensure(T.x, T.z);
    const far = Math.hypot(T.x, T.z) > 30000; // the weather stations only describe the massif
    if (far !== state.far) { state.far = far; updateCloudProfile(); updatePrecipForView(); }
  }
  if (pin?.search) pin.h = (google.on ? null : groundAt(pin.x, pin.z)) ?? pin.h;
  const g = google.on ? (gGround ?? groundAt(c.x, c.z)) : groundAt(c.x, c.z);
  if (g != null && c.y < g * state.exag + 4) c.y = g * state.exag + 4;
  const above = g != null ? c.y - g * state.exag : 1000, td = c.distanceTo(controls.target);
  camera.near = Math.min(Math.max(Math.min(above, td) * 0.15, 0.3), 200); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  sky.position.copy(c); clouds.position.set(c.x, 0, c.z); SU.camPos.value.copy(c);
  SU.boxSize.value = Math.min(Math.max(td * 0.9, 40), 9000);
  if (cabins.visible) { const a = cabinGeo.attributes.position.array, ph = (t * 0.02) % 2, f = ph < 1 ? ph : 2 - ph; a.set(cablePoint(0, f), 0); a.set(cablePoint(1, 1 - f), 3); cabinGeo.attributes.position.needsUpdate = true; }
  if (google.on) google.update(); else engine.update(camera);
  lidar.update(camera, controls.target, state.exag, google.on);
  const byPoints = (x, z) => lidar.covers(x, z);
  forest.update(camera, google.on || !state.trees, byPoints);
  lakes.update(camera, frameN, state.exag, google.on, controls.target);
  buildings.update(camera, controls.target, frameN, google.on, byPoints);
  nightLights.update(controls.target, frameN, U.night.value, state.exag, google.on);
  // at night the red paths would outshine everything: dimmed (still there to follow)
  for (const mat of Object.values(trails.mats)) mat.opacity = 0.95 * (1 - 0.7 * U.night.value);
  gps.update(camera, groundAt, state.exag); if (gps.on && frameN % 60 === 0) renderGps();
  route.update(frameN, state.exag, engine.busy);
  track.update(frameN, state.exag);
  trails.update(camera, controls.target, frameN, state.exag, google.on);
  weather3d.update(state.exag, state.far);
  photos.update(controls.target, frameN, state.exag, google.on);
  if (flyRoute) flyAlongRoute(dt);
  if (hoverNDC && frameN % (google.on ? 10 : 3) === 0) showPoint(pick(...hoverNDC));
  updateLabels(); frameN++;
  if (frameN % 600 === 0 && state.hourOffset === 0) updateSky();
  if (frameN % 45 === 0) updatePrecipForView();
  // cast shadows only with the real sun on the IGN terrain (photos and Google tiles carry their own)
  // light maps of the relief (sky visibility always, cast shadows with the real sun); Google tiles carry their own
  if (!google.on && started) shadows.update(controls.target, U.sunDir.value, state.exag, performance.now(), state.light === 'sun');
  else shadows.off();
  post.render(scene, camera, t);
  // start when the IGN relief is there, or when the Google view was chosen during loading (IGN then paused)
  if (!started && (engine.roots.filter(r => r.state === 'ready').length >= engine.roots.length * 0.6 || (google.on && t > 3))) {
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
    renderLidarInfo(); if (!$('sheet-layers').hidden) showPtStore();
    if (engine.epoch !== 'current') showEpochNote();
    fpsAcc = 0; fpsN = 0;
  }
}
window.midi3d = { engine, google, camera, controls, adapt, applyScale, forest, lakes, shadows, gps, route, sight, lidar, post, U, state,
  set overcast(v) { overcast = v; U.haze.value = v; updateSky(); } }; // handy for debugging from the console
updateSky(); frame(); refreshLive();
setInterval(() => { if (document.visibilityState === 'visible') refreshLive(); }, 15 * 60e3);
setTimeout(() => $('loader').classList.add('done'), 15000);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
