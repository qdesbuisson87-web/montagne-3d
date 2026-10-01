// Light maps of the relief, on two square cascades centred on the view (fine: a few km at metre scale; coarse:
// tens of km for what comes from far away). For each one:
//   1. a height map: the loaded terrain tiles drawn from above with an orthographic camera, heights packed
//      in 24 bits of an RGBA8 target (float targets are not available on every phone);
//   2. a sky-visibility map (ambient occlusion): from every texel the horizon is searched in 8–16 directions up
//      to 10 km, measured from the ground's own slope, so a plain slope stays fully lit and only hollows (gullies,
//      foot of cliffs, deep valleys) see less sky. Used in both lights;
//   3. a glacier mask: the BD TOPO glacier outlines (glaciers.js) painted from above, for the ice in the terrain;
//   4. for the "real sun" light, a shadow map: from every texel a ray is marched towards the sun through the
//      height maps, keeping how close it passes to the relief, which gives soft penumbras.
// Recomputed only when the view centre, the loaded tiles or the sun change, never every frame.
import * as THREE from 'three';

const PACK = `
vec4 packH(float h){ float v = clamp((h + 1000.0) / 8000.0, 0.0, 1.0) * 0.99999;
  vec3 e = fract(v * vec3(1.0, 255.0, 65025.0)); e -= e.yzz * vec3(1.0/255.0, 1.0/255.0, 0.0); return vec4(e, 1.0); }`;
const UNPACK = `
float unpackH(vec4 c){ return c.a < 0.5 ? -9999.0 : dot(c.rgb, vec3(1.0, 1.0/255.0, 1.0/65025.0)) * 8000.0 - 1000.0; }`;
// where two tiles meet, a one-texel gap of the height map can show the tile skirt below: a false trench that
// made the texels along it dark (shaded lines on the ground). The start height is the highest around.
const TOP = `
float hTop(vec2 p, float s){ return max(max(hAt(p), max(hAt(p + vec2(s, 0.0)), hAt(p - vec2(s, 0.0)))), max(hAt(p + vec2(0.0, s)), hAt(p - vec2(0.0, s)))); }`;

// terrain heights in metres, not exaggerated (tile meshes store true heights in position.y)
const heightMat = new THREE.ShaderMaterial({
  vertexShader: `varying float vH; void main(){ vH = position.y; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying float vH; ${PACK} void main(){ gl_FragColor = packH(vH); }`
});

// sky visibility: mean over directions of cos²(horizon angle above the local tangent plane) = the share of the
// cosine-weighted sky a receiver lying on that plane sees
const aoFS = `
uniform sampler2D hF, hC; uniform vec4 rF, rC;
uniform float exag, fine, dirs, steps;
varying vec2 vUv;
${UNPACK}
vec2 uvIn(vec4 r, vec2 p){ return vec2((p.x - r.x) / r.z, (r.y - p.y) / r.z); }
bool inside(vec2 u){ return u.x > 0.0 && u.y > 0.0 && u.x < 1.0 && u.y < 1.0; }
float hAt(vec2 p){
  vec2 u = uvIn(rF, p);
  if (fine > 0.5 && inside(u)) return unpackH(texture2D(hF, u));
  u = uvIn(rC, p);
  return inside(u) ? unpackH(texture2D(hC, u)) : -9999.0;
}
${TOP}
void main(){
  vec4 R = fine > 0.5 ? rF : rC;
  vec2 p = vec2(R.x + vUv.x * R.z, R.y - vUv.y * R.z);
  float h0 = hTop(p, R.w);
  if (h0 < -5000.0) { gl_FragColor = vec4(1.0); return; }
  // local slope over three texels each side: the tangent plane the horizon is measured from. Where tiles of
  // different detail meet, heights step by a metre or so: a short baseline turned that step into lines
  float e = R.w * 3.0, hx1 = hTop(p + vec2(e, 0.0), R.w), hx0 = hTop(p - vec2(e, 0.0), R.w), hz1 = hTop(p + vec2(0.0, e), R.w), hz0 = hTop(p - vec2(0.0, e), R.w);
  vec2 grad = (hx1 < -5000.0 || hx0 < -5000.0 || hz1 < -5000.0 || hz0 < -5000.0) ? vec2(0.0) : vec2(hx1 - hx0, hz1 - hz0) / (2.0 * e) * exag;
  // directions turned a little from texel to texel: the residual pattern is a fine noise the filtering hides
  float jit = fract(sin(dot(floor(vUv * 4096.0), vec2(12.9898, 78.233))) * 43758.5453);
  float vis = 0.0;
  for (int k = 0; k < 16; k++) {
    if (float(k) >= dirs) break;
    float a = (float(k) + jit) / dirs * 6.2831853; vec2 d = vec2(cos(a), sin(a));
    float tanPlane = dot(grad, d), best = tanPlane, t = R.w * 3.0;
    for (int i = 0; i < 32; i++) {
      if (float(i) >= steps || t > 10000.0) break;
      float g = hAt(p + d * t);
      if (g < -5000.0) break;
      best = max(best, (g - h0) * exag / t);
      t *= 1.3;
    }
    float rel = max(atan(best) - atan(tanPlane), 0.0);
    vis += cos(rel) * cos(rel);
  }
  gl_FragColor = vec4(vec3(vis / dirs), 1.0);
}`;

const shadowFS = `
uniform sampler2D hF, hC; uniform vec4 rF, rC; // rect: xmin, zmax, size, texel size (metres)
uniform vec3 sun; uniform float exag, fine, steps;
varying vec2 vUv;
${UNPACK}
vec2 uvIn(vec4 r, vec2 p){ return vec2((p.x - r.x) / r.z, (r.y - p.y) / r.z); }
bool inside(vec2 u){ return u.x > 0.0 && u.y > 0.0 && u.x < 1.0 && u.y < 1.0; }
float hAt(vec2 p){
  vec2 u = uvIn(rF, p);
  if (fine > 0.5 && inside(u)) return unpackH(texture2D(hF, u));
  u = uvIn(rC, p);
  return inside(u) ? unpackH(texture2D(hC, u)) : -9999.0;
}
${TOP}
void main(){
  vec4 R = fine > 0.5 ? rF : rC;
  vec2 p = vec2(R.x + vUv.x * R.z, R.y - vUv.y * R.z);
  float h0 = hTop(p, R.w);
  if (h0 < -5000.0) { gl_FragColor = vec4(1.0); return; }
  if (sun.y <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 d = normalize(sun.xz); float slope = sun.y / length(sun.xz);
  float lit = 1.0, t = R.w * 1.5, start = h0 * exag + R.w * 0.35 + 0.5;
  for (int i = 0; i < 160; i++) {
    if (float(i) >= steps) break;
    float ray = start + t * slope;
    if (ray > 4900.0 * exag) break;           // above the highest summit of the Alps: nothing left to hit
    float g = hAt(p + d * t);
    if (g < -5000.0) break;                   // out of the height maps
    // soft shadow: how deep the ray passes under/over the relief, relative to the distance (~1° penumbra)
    lit = min(lit, clamp((ray - g * exag) / (t * 0.018), 0.0, 1.0));
    if (lit <= 0.0) break;
    t += max(R.w * 0.8, t * 0.045);
  }
  gl_FragColor = vec4(vec3(lit), 1.0);
}`;

class Cascade {
  constructor(size, res) {
    this.size = size; this.res = res;
    const opts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, generateMipmaps: false, colorSpace: THREE.NoColorSpace };
    this.height = new THREE.WebGLRenderTarget(res, res, { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.shadow = new THREE.WebGLRenderTarget(res, res, { ...opts, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.ao = new THREE.WebGLRenderTarget(res, res, { ...opts, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.mask = new THREE.WebGLRenderTarget(res, res, { ...opts, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.rect = new THREE.Vector4(0, 0, size, size / res); // xmin, zmax, size, texel
    this.cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 1, 30000);
    this.cam.up.set(0, 0, -1); // screen up = north (-z): texture v grows northwards
    this.center = null; this.valid = false;
  }
  place(x, z) {
    // snap to whole texels so that re-centring does not make the shadow edges crawl
    const s = this.rect.w; x = Math.round(x / s) * s; z = Math.round(z / s) * s;
    this.center = [x, z]; this.rect.set(x - this.size / 2, z + this.size / 2, this.size, s);
    this.cam.position.set(x, 15000, z); this.cam.lookAt(x, 0, z); this.cam.updateMatrixWorld();
  }
  dispose() { this.height.dispose(); this.shadow.dispose(); this.ao.dispose(); this.mask.dispose(); }
}

export class TerrainShadows {
  // uniforms: the terrain's shared uniform object, which already holds shF, shC, srF, srC, shOn, aoF, aoC, aoOn, glF and glC.
  // glaciers: a Glaciers (its group of outlines and a version that changes when outlines arrive), or null
  // (materials copy the uniform references when tiles are built, so the keys must exist from the start)
  constructor(renderer, engine, uniforms, { fineSize = 6000, coarseSize = 48000, res = 1024, glaciers = null } = {}) {
    this.renderer = renderer; this.engine = engine; this.uniforms = uniforms; this.glaciers = glaciers; this.maskVersion = -1;
    this.maskScene = new THREE.Scene();
    this.fine = new Cascade(fineSize, res); this.coarse = new Cascade(coarseSize, res);
    this.tmpScene = new THREE.Scene(); this.tmpScene.overrideMaterial = heightMat;
    this.quadScene = new THREE.Scene(); this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.pass = new THREE.ShaderMaterial({
      uniforms: { hF: { value: this.fine.height.texture }, hC: { value: this.coarse.height.texture }, rF: { value: this.fine.rect }, rC: { value: this.coarse.rect },
        sun: { value: new THREE.Vector3() }, exag: { value: 1 }, fine: { value: 0 }, steps: { value: 128 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: shadowFS, depthTest: false, depthWrite: false
    });
    const pu = this.pass.uniforms;
    this.aoPass = new THREE.ShaderMaterial({
      uniforms: { hF: pu.hF, hC: pu.hC, rF: pu.rF, rC: pu.rC, exag: pu.exag, fine: { value: 0 }, dirs: { value: 12 }, steps: { value: 26 } },
      vertexShader: this.pass.vertexShader, fragmentShader: aoFS, depthTest: false, depthWrite: false
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pass); this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.bind();
    this.lastSun = new THREE.Vector3(); this.lastExag = 1; this.tilesAt = -1; this.lastRun = 0; this.sunValid = false;
  }
  setQuality(res, steps, aoDirs = 12) {
    if (res !== this.fine.res) {
      for (const k of ['fine', 'coarse']) { const c = this[k], n = new Cascade(c.size, res); c.dispose(); this[k] = n; }
      this.bind();
    }
    this.pass.uniforms.steps.value = steps; this.aoPass.uniforms.dirs.value = aoDirs; this.invalidate();
  }
  bind() {
    const p = this.pass.uniforms, u = this.uniforms;
    p.hF.value = this.fine.height.texture; p.hC.value = this.coarse.height.texture; p.rF.value = this.fine.rect; p.rC.value = this.coarse.rect;
    u.shF.value = this.fine.shadow.texture; u.shC.value = this.coarse.shadow.texture; u.srF.value = this.fine.rect; u.srC.value = this.coarse.rect;
    u.aoF.value = this.fine.ao.texture; u.aoC.value = this.coarse.ao.texture;
    u.glF.value = this.fine.mask.texture; u.glC.value = this.coarse.mask.texture; this.maskVersion = -1;
  }
  // stop everything (Google view); the maps are kept for a quick return
  off() { this.uniforms.shOn.value = 0; this.uniforms.aoOn.value = 0; }
  invalidate() { this.fine.valid = this.coarse.valid = false; }

  // Called every frame in the IGN view; does work only when something changed. sunOn: the "real sun" light,
  // which also needs the cast shadows (the sky visibility serves both lights).
  update(center, sunDir, exag, now, sunOn = true) {
    const moved = c => !c.center || Math.hypot(center.x - c.center[0], center.z - c.center[1]) > c.size * 0.18;
    // new tiles arriving make the height maps better: refresh, but at most every 1.5 s
    const tiles = this.engine.tileCount ?? 0, tilesChanged = tiles !== this.tilesAt && now - this.lastRun > 1500;
    const redoCoarse = !this.coarse.valid || moved(this.coarse) || exag !== this.lastExag || (tilesChanged && now - this.lastRun > 6000);
    const redoFine = redoCoarse || !this.fine.valid || moved(this.fine) || tilesChanged;
    const sunChanged = sunOn && (!this.sunValid || sunDir.angleTo(this.lastSun) > 0.0015);
    this.uniforms.aoOn.value = this.coarse.valid ? 1 : 0; this.uniforms.shOn.value = sunOn && this.sunValid ? 1 : 0;
    // new glacier outlines: repaint both masks (the cascades keep their squares)
    const gv = this.glaciers?.version ?? 0;
    if (gv !== this.maskVersion && this.coarse.valid && !redoFine) { this.renderMask(this.coarse); this.renderMask(this.fine); this.maskVersion = gv; }
    if (!redoFine && !sunChanged) return false;
    this.pass.uniforms.sun.value.copy(sunDir); this.pass.uniforms.exag.value = exag;
    if (redoCoarse) {
      if (moved(this.coarse) || !this.coarse.valid) this.coarse.place(center.x, center.z);
      this.renderHeights(this.coarse); this.renderPass(this.aoPass, this.coarse.ao, 0); this.renderMask(this.coarse); this.coarse.valid = true;
    }
    if (redoFine) {
      if (moved(this.fine) || !this.fine.valid) this.fine.place(center.x, center.z);
      this.renderHeights(this.fine); this.renderPass(this.aoPass, this.fine.ao, 1); this.renderMask(this.fine); this.fine.valid = true;
      if (gv !== this.maskVersion && !redoCoarse) this.renderMask(this.coarse);
      this.maskVersion = gv;
      this.tilesAt = tiles; this.lastRun = now;
    }
    if (sunOn) {
      if (redoCoarse || sunChanged) this.renderPass(this.pass, this.coarse.shadow, 0);
      this.renderPass(this.pass, this.fine.shadow, 1);
      this.lastSun.copy(sunDir); this.sunValid = true;
    } else this.sunValid = false; // the hour may change under the photo light: redo the shadows on return
    this.lastExag = exag;
    this.uniforms.aoOn.value = 1; this.uniforms.shOn.value = sunOn ? 1 : 0;
    return true;
  }

  // draw, for the cascade's square, the deepest loaded tiles no finer than about half a texel
  renderHeights(c) {
    const e = this.engine, r = c.rect, x0 = r.x, x1 = r.x + r.z, z1 = r.y, z0 = r.y - r.z, chosen = [];
    const walk = t => {
      if (t.state !== 'ready' || t.x1 < x0 || t.x0 > x1 || t.z1 < z0 || t.z0 > z1) return;
      const kids = t.children, finer = t.size / 64 > r.w * 0.5;
      if (finer && kids && kids.every(k => k.state === 'ready')) { kids.forEach(walk); return; }
      chosen.push(t.mesh);
    };
    e.roots.forEach(walk);
    const was = e.group.children.map(m => m.visible);
    e.group.children.forEach(m => { m.visible = false; }); chosen.forEach(m => { m.visible = true; });
    const parent = e.group.parent; this.tmpScene.add(e.group);
    const rt = this.renderer.getRenderTarget(), clear = this.renderer.getClearAlpha(), cc = this.renderer.getClearColor(new THREE.Color());
    this.renderer.setRenderTarget(c.height); this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
    this.renderer.render(this.tmpScene, c.cam);
    this.renderer.setRenderTarget(rt); this.renderer.setClearColor(cc, clear);
    parent.add(e.group); e.group.children.forEach((m, i) => { m.visible = was[i]; });
  }
  // glacier outlines seen from above, white on black
  renderMask(c) {
    const r = this.renderer, rt = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), g = this.glaciers?.group;
    r.setRenderTarget(c.mask); r.setClearColor(0x000000, 1); r.clear();
    if (g?.children.length) { this.maskScene.add(g); r.render(this.maskScene, c.cam); this.maskScene.remove(g); }
    r.setRenderTarget(rt); r.setClearColor(cc, ca);
  }
  renderPass(mat, target, fine) {
    mat.uniforms.fine.value = fine; this.quad.material = mat;
    const rt = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target); this.renderer.render(this.quadScene, this.quadCam); this.renderer.setRenderTarget(rt);
  }
}
