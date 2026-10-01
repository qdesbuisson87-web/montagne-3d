// Final image: the scene is drawn into a half-float buffer (values above white are kept: sunlit snow, the sun's
// disk, glints on water), then one pass turns it into the picture on screen:
//  - highlights rolled off smoothly instead of clipping (bright snow keeps its relief), hue preserved;
//  - a soft glow around what is brighter than white (dual-filter blur: 4 levels down, 4 up, cheap on phones);
//  - a gentle S-curve of contrast and a light vignette, like a photograph;
//  - dithering, so the sky's gradients never show bands;
//  - the clouds in volume (clouds.js), marched against this buffer's depth and laid over the scene here.
// Every material of the scene already writes display (gamma) values; this pass decodes them, works in linear
// light and encodes again, so nothing else in the app had to change. Off in "Standard" quality.
import * as THREE from 'three';

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// bright pass + first downsample (5 taps), in linear light
const BRIGHT = `
uniform sampler2D src; uniform vec2 texel; uniform float threshold; varying vec2 vUv;
vec3 lin(vec2 uv){ return pow(max(texture2D(src, uv).rgb, 0.0), vec3(2.2)); }
vec3 bright(vec3 c){ float m = max(c.r, max(c.g, c.b)); float k = max(m - threshold, 0.0); k = k * k / (k + 0.25); return c * (k / max(m, 1e-4)); }
void main(){
  vec3 c = bright(lin(vUv)) * 4.0 + bright(lin(vUv + texel * vec2(-1, -1))) + bright(lin(vUv + texel * vec2(1, -1))) + bright(lin(vUv + texel * vec2(-1, 1))) + bright(lin(vUv + texel * vec2(1, 1)));
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;
const DOWN = `
uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
void main(){
  vec3 c = texture2D(src, vUv).rgb * 4.0 + texture2D(src, vUv + texel * vec2(-1, -1)).rgb + texture2D(src, vUv + texel * vec2(1, -1)).rgb
         + texture2D(src, vUv + texel * vec2(-1, 1)).rgb + texture2D(src, vUv + texel * vec2(1, 1)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;
const UP = `
uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
void main(){
  vec2 o = texel;
  vec3 c = texture2D(src, vUv + vec2(-2.0 * o.x, 0.0)).rgb + texture2D(src, vUv + vec2(2.0 * o.x, 0.0)).rgb
         + texture2D(src, vUv + vec2(0.0, -2.0 * o.y)).rgb + texture2D(src, vUv + vec2(0.0, 2.0 * o.y)).rgb
         + (texture2D(src, vUv + vec2(-o.x, o.y)).rgb + texture2D(src, vUv + vec2(o.x, o.y)).rgb
          + texture2D(src, vUv + vec2(-o.x, -o.y)).rgb + texture2D(src, vUv + vec2(o.x, -o.y)).rgb) * 2.0;
  gl_FragColor = vec4(c / 12.0, 1.0);
}`;
const FINAL = `
uniform sampler2D scene, bloom, clouds; uniform float bloomK, vignette, contrast, exposure, time, cloudsOn;
varying vec2 vUv;
void main(){
  vec3 c = pow(max(texture2D(scene, vUv).rgb, 0.0), vec3(2.2)) * exposure;
  if (cloudsOn > 0.5) {
    // the clouds come at half resolution: four taps one pixel apart smooth their sampling pattern out
    vec2 px = 1.0 / vec2(textureSize(clouds, 0)) * 0.5;
    vec4 cl = (texture2D(clouds, vUv + vec2(-px.x, -px.y)) + texture2D(clouds, vUv + vec2(px.x, -px.y)) + texture2D(clouds, vUv + vec2(-px.x, px.y)) + texture2D(clouds, vUv + vec2(px.x, px.y))) * 0.25;
    c = c * cl.a + cl.rgb * exposure;
  }
  c += texture2D(bloom, vUv).rgb * bloomK;
  // highlights: linear up to the knee, then rolled off towards white along the brightest channel (hue kept);
  // very bright light also loses saturation, as film and eyes do
  const float KNEE = 0.72;
  float m = max(c.r, max(c.g, c.b));
  if (m > KNEE) {
    float r = KNEE + (1.0 - KNEE) * (1.0 - exp(-(m - KNEE) / (1.0 - KNEE)));
    c *= r / m;
    c = mix(c, vec3(r), smoothstep(KNEE, 1.6, m) * 0.35);
  }
  vec3 g = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  g = mix(g, g * g * (3.0 - 2.0 * g), contrast);                       // gentle S-curve
  vec2 q = vUv - 0.5; g *= 1.0 - vignette * dot(q, q) * 1.6;            // light vignette
  g += (fract(sin(dot(gl_FragCoord.xy + fract(time) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0; // dither
  gl_FragColor = vec4(g, 1.0);
}`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer; this.enabled = false; this.samples = 0;
    const ok = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    this.supported = ok;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.quad.frustumCulled = false; this.scene.add(this.quad);
    const mat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.bright = mat(BRIGHT, { src: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 0.95 } });
    this.down = mat(DOWN, { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.up = mat(UP, { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.up.blending = THREE.AdditiveBlending; this.up.transparent = true;
    this.final = mat(FINAL, { scene: { value: null }, bloom: { value: null }, clouds: { value: null }, cloudsOn: { value: 0 }, bloomK: { value: 0.35 }, vignette: { value: 0.16 }, contrast: { value: 0.1 }, exposure: { value: 1 }, time: { value: 0 } });
    this.clouds = null; // a VolumeClouds, drawn when it has something to draw
    this.rt = null; this.levels = []; this.w = 0; this.h = 0;
  }
  // samples: multisampling of the scene buffer (0 on dense screens, where it costs much and shows little)
  setOptions({ enabled, samples = 0 }) {
    const on = !!enabled && this.supported;
    if (on !== this.enabled || samples !== this.samples) { this.enabled = on; this.samples = samples; this.dispose(); }
  }
  ensure() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2()), w = size.x, h = size.y;
    if (this.rt && w === this.w && h === this.h) return;
    this.dispose(); this.w = w; this.h = h;
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rt = new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: true, samples: this.samples });
    this.rt.depthTexture = new THREE.DepthTexture(w, h); // read by the clouds, to stop at the relief
    let lw = w, lh = h;
    for (let i = 0; i < 5; i++) { lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); this.levels.push(new THREE.WebGLRenderTarget(lw, lh, opts)); }
  }
  dispose() { this.rt?.depthTexture?.dispose(); this.rt?.dispose(); this.levels.forEach(l => l.dispose()); this.rt = null; this.levels = []; this.w = this.h = 0; }
  pass(mat, target, src, texelOf = src) {
    this.quad.material = mat; mat.uniforms.src && (mat.uniforms.src.value = src.texture);
    if (mat.uniforms.texel) mat.uniforms.texel.value.set(1 / texelOf.width, 1 / texelOf.height);
    this.renderer.setRenderTarget(target); this.renderer.render(this.scene, this.cam);
  }

  render(scene, camera, time = 0) {
    const r = this.renderer;
    if (!this.enabled) { r.setRenderTarget(null); r.render(scene, camera); return; }
    this.ensure();
    r.setRenderTarget(this.rt); r.render(scene, camera);
    // glow: bright pass into 1/2, down to 1/32, then back up to 1/2 adding each level
    const L = this.levels;
    this.pass(this.bright, L[0], this.rt);
    for (let i = 1; i < L.length; i++) this.pass(this.down, L[i], L[i - 1]);
    for (let i = L.length - 1; i > 0; i--) { r.autoClear = false; this.pass(this.up, L[i - 1], L[i]); r.autoClear = true; }
    const u = this.final.uniforms, cl = this.clouds?.active;
    u.cloudsOn.value = cl ? 1 : 0; if (cl) u.clouds.value = this.clouds.render(camera, this.rt.depthTexture, this.w, this.h);
    this.quad.material = this.final;
    u.scene.value = this.rt.texture; u.bloom.value = L[0].texture; u.time.value = time;
    r.setRenderTarget(null); r.render(this.scene, this.cam);
  }
}
