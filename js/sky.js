// The real night sky over the massif: the 5 044 stars seen by eye (to magnitude 6, with their colour), the Milky
// Way, and the planets Mercury to Saturn where they are on the date shown, with their names. Plus, for photographers,
// the course of the Sun and of the Moon across the sky that day, with the hours.
// Stars and Milky Way: d3-celestial (Olaf Frohn, BSD licence), data/sky.json, loaded at the first night only.
// Planets: JPL "Approximate positions of the planets" (Standish, 1800–2050 elements), checked against JPL Horizons
// on 03/10/2026: within 0.01° (Mercury, Venus, Mars) to 0.08° (Saturn).
// The sky is drawn on a sphere around the camera, rotated from equatorial coordinates to the place's horizon by the
// local sidereal time (precession since 2000 neglected: about 0.3°).
import * as THREE from 'three';
import { sunPosition, moonPosition } from './live.js?v=202610042100';

const R = 180000, RAD = Math.PI / 180;
const days2000 = date => date / 864e5 - 10957.5; // days since J2000 (as in live.js)
// colour of a star from its B−V index (blue-white to orange-red), display values
function bvColor(bv) {
  const t = Math.min(1, Math.max(0, (bv + 0.3) / 2.0));
  const stops = [[0, [0.62, 0.72, 1.0]], [0.18, [0.8, 0.86, 1.0]], [0.35, [1.0, 0.98, 0.95]], [0.55, [1.0, 0.88, 0.7]], [0.8, [1.0, 0.75, 0.48]], [1, [1.0, 0.6, 0.38]]];
  let i = 1; while (i < stops.length - 1 && t > stops[i][0]) i++;
  const [t0, a] = stops[i - 1], [t1, b] = stops[i], f = (t - t0) / (t1 - t0);
  return a.map((v, k) => v + (b[k] - v) * f);
}
// heliocentric ecliptic position (AU) from the JPL elements at T (centuries from J2000)
const PLANETS = {
  Mercure: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081], 0.9],
  Vénus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418], -4],
  Terre: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343], 0.5],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106], -2.2],
  Saturne: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794], 0.7]
};
function helio(name, T) {
  const [e0, r] = PLANETS[name], [a, e, I, L, wb, Om] = e0.map((v, i) => v + r[i] * T);
  const w = (wb - Om) * RAD, O = Om * RAD, inc = I * RAD, M = (((L - wb + 180) % 360 + 360) % 360 - 180) * RAD;
  let E = M + e * Math.sin(M); for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(inc), si = Math.sin(inc);
  return [(cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp, (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp, sw * si * xp + cw * si * yp];
}
// equatorial unit vector (J2000) of a planet seen from the Earth
function planetDir(name, date) {
  const T = days2000(date) / 36525, p = helio(name, T), e = helio('Terre', T), eps = 23.43928 * RAD;
  const x = p[0] - e[0], y = p[1] - e[1], z = p[2] - e[2];
  return new THREE.Vector3(x, y * Math.cos(eps) - z * Math.sin(eps), y * Math.sin(eps) + z * Math.cos(eps)).normalize();
}
const eqDir = (raDeg, decDeg) => { const a = raDeg * RAD, d = decDeg * RAD; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; };

export class NightSky {
  constructor({ scene, labels }) {
    this.scene = scene; this.labelsEl = labels; this.data = null; this.loading = false;
    this.group = new THREE.Group(); this.group.matrixAutoUpdate = false; this.group.visible = false; scene.add(this.group);
    this.u = { night: { value: 0 }, px: { value: 1 } };
    this.planets = []; this.paths = new THREE.Group(); this.paths.visible = false; scene.add(this.paths); this.pathLabels = [];
    this.m = new THREE.Matrix4(); this.showPaths = false;
  }
  async load() {
    if (this.data || this.loading) return; this.loading = true;
    try { const r = await fetch('data/sky.json'); if (r.ok) this.data = await r.json(); } catch { }
    // built whole or not at all: a failure leaves the sky without stars, never the frame broken
    this.loading = false; if (this.data) try { this.build(); this.built = true; } catch (e) { console.warn('ciel de nuit :', e); }
  }
  build() {
    // stars: points at their direction, size and brightness from the magnitude, colour from B−V
    const S = this.data.stars, pos = new Float32Array(S.length * 3), col = new Float32Array(S.length * 3), mag = new Float32Array(S.length);
    S.forEach(([ra, dec, m, bv], i) => { pos.set(eqDir(ra, dec).map(v => v * R), i * 3); col.set(bvColor(bv), i * 3); mag[i] = m; });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    const stars = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `uniform float night, px; attribute vec3 color; attribute float mag; varying vec3 vC; varying float vA;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0); vec3 d = normalize(w.xyz - cameraPosition);
          // fainter towards the horizon (thicker air), gone below it
          float ext = smoothstep(-0.02, 0.12, d.y);
          float b = pow(10.0, -0.4 * (mag - 1.0));                 // brightness relative to a magnitude-1 star
          vA = night * ext * clamp(0.2 + b * 1.2, 0.0, 1.0);    // the faintest still seen (as by eye, far from towns)
          vC = color; gl_PointSize = clamp(px * (2.8 - mag * 0.26), px * 1.3, px * 4.5);
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float r = dot(c, c) * 4.0; if (r > 1.0) discard; gl_FragColor = vec4(vC * vA * (1.0 - r * r), 1.0); }`
    }));
    stars.frustumCulled = false; stars.renderOrder = -0.5; this.group.add(stars);
    // the Milky Way: its outlines (five brightness levels) painted on an equirectangular map of the sky, then blurred.
    // An outline crossing longitude ±180° is unwrapped and painted three times (−360°, 0, +360°): drawn as is, it
    // drew a straight edge across the whole sky. The blur is done here (3 box passes ≈ Gaussian, ~4°): the canvas
    // "filter" is ignored by Safari.
    const W = 512, Hh = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh; const c = cv.getContext('2d');
    for (const { level, rings } of this.data.milkyway) {
      c.fillStyle = `rgba(255,255,255,${0.12 + level * 0.03})`; c.beginPath();
      for (const r of rings) {
        let prev = null; const pts = r.map(([lon, lat]) => { if (prev != null) lon += Math.round((prev - lon) / 360) * 360; prev = lon; return [lon, lat]; });
        for (const off of [-360, 0, 360]) pts.forEach(([lon, lat], i) => { const x = (lon + off + 180) / 360 * W, y = (90 - lat) / 180 * Hh; i ? c.lineTo(x, y) : c.moveTo(x, y); });
      }
      c.fill('evenodd');
    }
    const img = c.getImageData(0, 0, W, Hh), px = img.data, v = new Float32Array(W * Hh), t = new Float32Array(W * Hh);
    for (let k = 0; k < W * Hh; k++) v[k] = px[k * 4 + 3] / 255 * (px[k * 4] / 255);
    const BR = 3; // box radius in pixels (0.7° each): horizontal wraps around the sky, vertical clamps at the poles
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -BR; d <= BR; d++) s += v[y * W + ((x + d + W) % W)]; t[y * W + x] = s / (2 * BR + 1); }
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -BR; d <= BR; d++) s += t[Math.min(Hh - 1, Math.max(0, y + d)) * W + x]; v[y * W + x] = s / (2 * BR + 1); }
    }
    // five levels at their alphas pile up to ≈ 0.7 in the core: brought to 1 there, the faint arms in proportion
    for (let k = 0; k < W * Hh; k++) { const g = Math.round(Math.min(1, v[k] / 0.7) * 255); px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = g; px[k * 4 + 3] = 255; }
    c.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.NoColorSpace; tex.wrapS = THREE.RepeatWrapping;
    const mw = new THREE.Mesh(new THREE.SphereGeometry(R * 1.02, 64, 32), new THREE.ShaderMaterial({
      uniforms: { ...this.u, map: { value: tex } }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vE, vW; void main(){ vE = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D map; uniform float night; varying vec3 vE, vW;
        void main(){ vec3 e = normalize(vE); float ra = atan(e.y, e.x), dec = asin(e.z);
          float v = texture2D(map, vec2(ra / 6.2831853 + 0.5, 0.5 - dec / 3.14159265)).r;
          float up = smoothstep(0.0, 0.25, normalize(vW - cameraPosition).y);
          gl_FragColor = vec4(vec3(0.75, 0.8, 1.0) * v * 0.16 * night * up, 1.0); }`
    }));
    mw.frustumCulled = false; mw.renderOrder = -0.6; this.group.add(mw);
    // planets: brighter points with their names
    for (const [name, [, , mag]] of Object.entries(PLANETS)) {
      if (name === 'Terre') continue;
      const el = document.createElement('div'); el.className = 'label small planet hidden'; el.innerHTML = `<span class="t"><span class="n">${name}</span></span>`;
      this.labelsEl.appendChild(el); this.planets.push({ name, mag, el, dir: new THREE.Vector3() });
    }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.planets.length * 3), 3));
    pg.setAttribute('mag', new THREE.BufferAttribute(Float32Array.from(this.planets.map(p => p.mag)), 1));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.planets.length * 3).fill(1), 3));
    this.planetPoints = new THREE.Points(pg, stars.material); this.planetPoints.frustumCulled = false; this.scene.add(this.planetPoints);
    this.at = 0;
  }
  // the date shown, the place (degrees), how dark it is (0 day … 1 night), how cloudy (0–1)
  update(camera, date, lat, lon, night, overcast, w, h, pixelRatio) {
    const vis = night > 0.01 && overcast < 0.97;
    if (vis && !this.data) this.load();
    this.u.night.value = night * (1 - overcast); this.u.px.value = 1.6 * Math.min(2, pixelRatio);
    const ready = !!this.built && vis;
    this.group.visible = ready; if (this.planetPoints) this.planetPoints.visible = ready;
    if (ready) {
      // equatorial -> the place's horizon (scene: x east, y up, z south), by the local sidereal time
      const theta = ((18.697374558 + 24.06570982441908 * days2000(date)) % 24 * 15 + lon) * RAD, phi = lat * RAD;
      const ct = Math.cos(theta), st = Math.sin(theta), cp = Math.cos(phi), sp = Math.sin(phi);
      // rows: east = e'.y, up = cosφ e'.x + sinφ e'.z, south = sinφ e'.x − cosφ e'.z, with e' = Rz(−θ) e
      this.m.set(-st, ct, 0, 0, cp * ct, cp * st, sp, 0, sp * ct, sp * st, -cp, 0, 0, 0, 0, 1);
      this.m.setPosition(camera.position); this.group.matrix.copy(this.m); this.group.matrixWorldNeedsUpdate = true;
      const a = this.planetPoints.geometry.attributes.position;
      this.planets.forEach((p, i) => { p.dir.copy(planetDir(p.name, date)).applyMatrix4(new THREE.Matrix4().extractRotation(this.m)); a.setXYZ(i, ...p.dir.clone().multiplyScalar(R * 0.99).add(camera.position).toArray()); });
      a.needsUpdate = true;
    }
    // planet names (only those above the horizon and on screen)
    for (const p of this.planets) {
      let on = ready && p.dir.y > 0.02;
      if (on) { const v = p.dir.clone().multiplyScalar(R * 0.99).add(camera.position).project(camera); on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05; if (on) p.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`; }
      p.el.classList.toggle('hidden', !on);
    }
    this.updatePaths(camera, date, lat, lon, w, h);
  }
  // the course of the Sun and of the Moon on the date shown, every 10 minutes, with the whole hours named
  updatePaths(camera, date, lat, lon, w, h) {
    this.paths.visible = this.showPaths;
    if (!this.showPaths) { this.pathLabels.forEach(l => l.el.classList.add('hidden')); return; }
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    if (this.pathDay !== +day || this.pathLat !== lat) {
      this.pathDay = +day; this.pathLat = lat;
      this.paths.children.forEach(o => o.geometry.dispose()); this.paths.clear(); this.pathLabels.forEach(l => l.el.remove()); this.pathLabels = [];
      const dir = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      for (const [body, color, fn] of [['Soleil', 0xffc53d, t => sunPosition(t, lat, lon)], ['Lune', 0xc9d6ff, t => moonPosition(t, lat, lon)]]) {
        const pts = [];
        for (let m = 0; m <= 1440; m += 10) {
          const t = new Date(+day + m * 60e3), p = fn(t); if (p.el < -0.01) { if (pts.length) pts.push(null); continue; }
          pts.push(dir(p.az, p.el));
          if (m % 60 === 0) {
            const el = document.createElement('div'); el.className = `label small sunpath ${body === 'Lune' ? 'moon' : ''} hidden`;
            el.innerHTML = `<span class="t"><span class="n">${body === 'Lune' ? '☾ ' : ''}${String(t.getHours()).padStart(2, '0')} h</span></span>`;
            this.labelsEl.appendChild(el); this.pathLabels.push({ el, d: dir(p.az, p.el) });
          }
        }
        // one line per stretch above the horizon
        let run = [];
        const flush = () => { if (run.length > 1) { const g = new THREE.BufferGeometry().setFromPoints(run.map(v => v.clone().multiplyScalar(R * 0.98))); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })); l.frustumCulled = false; l.renderOrder = 9; this.paths.add(l); } run = []; };
        for (const p of pts) { if (p) run.push(p); else flush(); } flush();
      }
    }
    this.paths.position.copy(camera.position);
    for (const l of this.pathLabels) {
      const v = l.d.clone().multiplyScalar(R * 0.98).add(camera.position).project(camera), on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      l.el.classList.toggle('hidden', !on); if (on) l.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
    }
  }
}
