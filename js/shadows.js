// Cast shadows of the relief for the "real sun" light: the mountains shade each other at the chosen hour.
// Two square cascades centred on the view (fine: a few km at metre scale; coarse: tens of km for the big
// shadows coming from far away). For each one:
//   1. a height map: the loaded terrain tiles drawn from above with an orthographic camera, heights packed
//      in 24 bits of an RGBA8 target (float targets are not available on every phone);
//   2. a shadow map: from every texel a ray is marched towards the sun through the height maps, keeping how
//      close it passes to the relief, which gives soft penumbras.
// Both are recomputed only when the sun, the view centre or the loaded tiles change, never every frame.
import * as THREE from 'three';

const PACK = `
vec4 packH(float h){ float v = clamp((h + 1000.0) / 8000.0, 0.0, 1.0) * 0.99999;
  vec3 e = fract(v * vec3(1.0, 255.0, 65025.0)); e -= e.yzz * vec3(1.0/255.0, 1.0/255.0, 0.0); return vec4(e, 1.0); }`;
const UNPACK = `
float unpackH(vec4 c){ return c.a < 0.5 ? -9999.0 : dot(c.rgb, vec3(1.0, 1.0/255.0, 1.0/65025.0)) * 8000.0 - 1000.0; }`;

// terrain heights in metres, not exaggerated (tile meshes store true heights in position.y)
const heightMat = new THREE.ShaderMaterial({
  vertexShader: `varying float vH; void main(){ vH = position.y; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying float vH; ${PACK} void main(){ gl_FragColor = packH(vH); }`
});

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
void main(){
  vec4 R = fine > 0.5 ? rF : rC;
  vec2 p = vec2(R.x + vUv.x * R.z, R.y - vUv.y * R.z);
  float h0 = hAt(p);
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
  dispose() { this.height.dispose(); this.shadow.dispose(); }
}

export class TerrainShadows {
  // uniforms: the terrain's shared uniform object, which already holds shF, shC, srF, srC and shOn
  // (materials copy the uniform references when tiles are built, so the keys must exist from the start)
  constructor(renderer, engine, uniforms, { fineSize = 6000, coarseSize = 48000, res = 1024 } = {}) {
    this.renderer = renderer; this.engine = engine; this.uniforms = uniforms;
    this.fine = new Cascade(fineSize, res); this.coarse = new Cascade(coarseSize, res);
    this.tmpScene = new THREE.Scene(); this.tmpScene.overrideMaterial = heightMat;
    this.quadScene = new THREE.Scene(); this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.pass = new THREE.ShaderMaterial({
      uniforms: { hF: { value: this.fine.height.texture }, hC: { value: this.coarse.height.texture }, rF: { value: this.fine.rect }, rC: { value: this.coarse.rect },
        sun: { value: new THREE.Vector3() }, exag: { value: 1 }, fine: { value: 0 }, steps: { value: 128 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: shadowFS, depthTest: false, depthWrite: false
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pass); quad.frustumCulled = false;
    this.quadScene.add(quad);
    this.bind();
    this.lastSun = new THREE.Vector3(); this.lastExag = 1; this.tilesAt = -1; this.lastRun = 0;
  }
  setQuality(res, steps) {
    if (res !== this.fine.res) {
      for (const k of ['fine', 'coarse']) { const c = this[k], n = new Cascade(c.size, res); c.dispose(); this[k] = n; }
      this.bind();
    }
    this.pass.uniforms.steps.value = steps; this.invalidate();
  }
  bind() {
    const p = this.pass.uniforms, u = this.uniforms;
    p.hF.value = this.fine.height.texture; p.hC.value = this.coarse.height.texture; p.rF.value = this.fine.rect; p.rC.value = this.coarse.rect;
    u.shF.value = this.fine.shadow.texture; u.shC.value = this.coarse.shadow.texture; u.srF.value = this.fine.rect; u.srC.value = this.coarse.rect;
  }
  // stop shading (other light, Google view); the maps are kept for a quick return
  off() { this.uniforms.shOn.value = 0; }
  invalidate() { this.fine.valid = this.coarse.valid = false; }

  // Called every frame while the real-sun light is on; does work only when something changed.
  update(center, sunDir, exag, now) {
    const moved = c => !c.center || Math.hypot(center.x - c.center[0], center.z - c.center[1]) > c.size * 0.18;
    const sunChanged = sunDir.angleTo(this.lastSun) > 0.0015 || exag !== this.lastExag;
    // new tiles arriving make the height maps better: refresh, but at most every 1.5 s
    const tiles = this.engine.tileCount ?? 0, tilesChanged = tiles !== this.tilesAt && now - this.lastRun > 1500;
    const redoCoarse = !this.coarse.valid || moved(this.coarse) || sunChanged || (tilesChanged && now - this.lastRun > 6000);
    const redoFine = redoCoarse || !this.fine.valid || moved(this.fine) || tilesChanged;
    if (!redoFine) return false;
    this.pass.uniforms.sun.value.copy(sunDir); this.pass.uniforms.exag.value = exag;
    if (redoCoarse) { if (moved(this.coarse) || !this.coarse.valid) this.coarse.place(center.x, center.z); this.renderHeights(this.coarse); this.renderShadow(this.coarse, 0); this.coarse.valid = true; }
    if (moved(this.fine) || !this.fine.valid) this.fine.place(center.x, center.z);
    this.renderHeights(this.fine); this.renderShadow(this.fine, 1); this.fine.valid = true;
    this.lastSun.copy(sunDir); this.lastExag = exag; this.tilesAt = tiles; this.lastRun = now;
    this.uniforms.shOn.value = 1;
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
  renderShadow(c, fine) {
    this.pass.uniforms.fine.value = fine;
    const rt = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(c.shadow); this.renderer.render(this.quadScene, this.quadCam); this.renderer.setRenderTarget(rt);
  }
}
