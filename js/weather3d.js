// Weather drawn in the 3D scene, from the forecast of the massif (Open-Meteo):
// - the 0 °C isotherm: a pale blue plane at the freezing level, which cuts the mountains where it freezes;
// - the wind aloft: streaks drifting at the 700 hPa level (≈ 3 000 m), with the forecast speed and direction.
// Both only around the massif, where the forecast point is, and with the hour of the forecast shown.
import * as THREE from 'three';

const R = 22000; // metres around the massif's origin

export class Weather3D {
  constructor({ scene, uniforms }) {
    this.freeze = new THREE.Mesh(new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { time: uniforms.time },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec3 vL; void main(){ vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vL;
        void main(){
          float r = length(vL.xz) / ${R.toFixed(1)}, edge = 1.0 - smoothstep(0.75, 1.0, r);
          vec2 g = abs(fract(vL.xz / 500.0) - 0.5); float grid = 1.0 - smoothstep(0.0, 0.012, min(g.x, g.y)); // a light 500 m grid
          gl_FragColor = vec4(vec3(0.55, 0.8, 1.0), (0.12 + grid * 0.18) * edge);
        }`
    }));
    this.freeze.renderOrder = 7; this.freeze.visible = false; scene.add(this.freeze);

    const N = 6000, pos = new Float32Array(N * 6), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { const x = Math.random(), y = Math.random(), z = Math.random(); pos.set([x, y, z, x, y, z], i * 6); end[i * 2 + 1] = 1; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.windU = { time: uniforms.time, exag: uniforms.exag, wind: { value: new THREE.Vector2() }, alt: { value: 3000 } };
    this.wind = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: this.windU, transparent: true, depthWrite: false,
      vertexShader: `uniform float time, exag, alt; uniform vec2 wind; attribute float aEnd; varying float vA;
        void main(){
          // particles in a box of 2 R × 1 400 m × 2 R, wrapping around as they drift with the wind (m/s)
          vec3 p = position; p.xz = fract(p.xz + wind * time / ${(2 * R).toFixed(1)});
          float along = aEnd * clamp(length(wind) * 9.0, 20.0, 260.0);               // streak length grows with speed
          vec2 dir = length(wind) > 0.01 ? normalize(wind) : vec2(1.0, 0.0);
          vec3 w = vec3((p.x - 0.5) * ${(2 * R).toFixed(1)} - dir.x * along, (alt - 700.0 + p.y * 1400.0) * exag, (p.z - 0.5) * ${(2 * R).toFixed(1)} - dir.y * along);
          float r = length(w.xz) / ${R.toFixed(1)};
          vA = (1.0 - smoothstep(0.7, 1.0, r)) * (1.0 - aEnd) * (0.5 + 0.5 * sin(position.x * 91.0 + time * 0.7));
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.92, 0.96, 1.0, vA * 0.55); }`
    }));
    this.wind.frustumCulled = false; this.wind.renderOrder = 7; this.wind.visible = false; scene.add(this.wind);
    this.showFreeze = false; this.showWind = false; this.data = null;
  }
  // forecast values of the current hour: freezing level (m), wind aloft (km/h, direction it blows FROM, degrees)
  setData(d) { this.data = d; }
  update(exag, hidden) {
    const d = this.data;
    this.freeze.visible = this.showFreeze && !hidden && d?.freeze != null;
    if (this.freeze.visible) this.freeze.position.y = d.freeze * exag;
    this.wind.visible = this.showWind && !hidden && d?.windSpeed != null;
    if (this.wind.visible) {
      const ms = d.windSpeed / 3.6, a = d.windDir * Math.PI / 180; // wind blows TOWARDS the opposite of where it comes from
      this.windU.wind.value.set(-Math.sin(a) * ms, Math.cos(a) * ms); // x east, z south
      this.windU.alt.value = d.windAlt ?? 3000;
    }
  }
}
