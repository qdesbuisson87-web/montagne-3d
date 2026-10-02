// Lakes from IGN BD TOPO (WFS "plan_d_eau": real outlines and names). Each lake is a flat surface laid at the
// water level measured by the LiDAR relief along its shore, with the sky reflected in it, animated ripples,
// the sun's glint and, for the nearest lake (Haute / Extrême quality), a true mirror of the mountains.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610030109';
import { cachedFetch } from './net.js?v=202610030109';

const CELL = 0.04; // degrees: lakes are fetched by cells of ≈ 3 × 4.5 km
const WFS = (s, w, n, e) => `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:plan_d_eau&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=500&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;

const VS = `
uniform mat4 textureMatrix; varying vec3 vW; varying vec4 vRefl;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vRefl = textureMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * viewMatrix * w; }`;

export class Lakes {
  constructor({ scene, engine, uniforms, sceneGLSL, skyGLSL, skyTex }) {
    this.scene = scene; this.engine = engine; this.group = new THREE.Group(); scene.add(this.group);
    this.cells = new Set(); this.lakes = new Map(); this.mirror = null; this.mirrorOn = true; this.mirrorEvery = 3;
    this.uniforms = { ...uniforms, skyTex: { value: skyTex }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() }, hasRefl: { value: 0 } };
    this.fs = `${sceneGLSL}${skyGLSL}
      uniform sampler2D skyTex, noiseTex, tDiffuse; uniform float time, hasRefl;
      varying vec3 vW; varying vec4 vRefl;
      float n(vec2 p){ return texture2D(noiseTex, p).r; }
      void main(){
        // ripples: two noise layers drifting in different directions, turned into a surface slope
        vec2 p1 = vW.xz / 180.0 + vec2(time * 0.0021, time * 0.0013), p2 = vW.xz / 55.0 - vec2(time * 0.0017, -time * 0.0026);
        float e = 0.004;
        vec2 g = vec2(n(p1 + vec2(e, 0.0)) - n(p1 - vec2(e, 0.0)), n(p1 + vec2(0.0, e)) - n(p1 - vec2(0.0, e))) * 1.0
               + vec2(n(p2 + vec2(e, 0.0)) - n(p2 - vec2(e, 0.0)), n(p2 + vec2(0.0, e)) - n(p2 - vec2(0.0, e))) * 0.6;
        vec3 N = normalize(vec3(-g.x * 2.2, 1.0, -g.y * 2.2));
        vec3 V = normalize(cameraPosition - vW), R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 refl = pow(texture2D(skyTex, skyUv(R)).rgb, vec3(2.2));
        if (hasRefl > 0.5) { vec4 q = vRefl; q.xy += N.xz * 0.9 * q.w * 0.02; refl = pow(texture2DProj(tDiffuse, q).rgb, vec3(2.2)); }
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        // alpine lake body: dark teal, lit by the sky
        vec3 body = vec3(0.012, 0.045, 0.05) * (0.6 + 0.6 * dot(pow(skyCol, vec3(2.2)), vec3(0.33)));
        vec3 col = mix(body, refl, clamp(fres * 1.1 + 0.08, 0.0, 1.0));
        float sh = (light > 0.5 && shOn > 0.5) ? sunShadow(vW) : 1.0;
        col += min(sunCol, vec3(2.0)) * pow(max(dot(R, sunDir), 0.0), 350.0) * 1.4 * sh * step(0.0, sunDir.y);
        gl_FragColor = vec4(pow(max(aerial(col, vW), 0.0), vec3(1.0/2.2)), 1.0);
      }`;
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VS, fragmentShader: this.fs, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  }

  // fetch the lakes of the cells around a point (once per cell; the answers are cached for offline use)
  async ensure(x, z, radius = 5000) {
    const [lon, lat] = worldToLonLat(x, z), dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * Math.PI / 180));
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++) for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue; this.cells.add(key);
      cachedFetch(WFS(a * CELL, b * CELL, (a + 1) * CELL, (b + 1) * CELL)).then(r => r.ok ? r.json() : null).then(j => {
        for (const f of j?.features ?? []) if (!this.lakes.has(f.properties.cleabs)) this.add(f);
      }).catch(() => this.cells.delete(key)); // try again later
    }
  }
  add(f) {
    // the "plan_d_eau" layer also holds glaciers and névés ("Glacier, névé"): they are ice on the relief, not lakes
    if (/glacier|névé|neve/i.test(f.properties.nature ?? '')) return;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = polys.map(p => p.map(ring => ring.map(([lon, lat]) => lonLatToWorld(lon, lat))));
    const pts = rings.flat(2), cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    this.lakes.set(f.properties.cleabs, { name: f.properties.toponyme, rings, cx, cz, radius: Math.max(...pts.map(p => Math.hypot(p[0] - cx, p[1] - cz))), level: null, locked: false, mesh: null });
  }
  // water level: a low quantile of the relief along the shore (the LiDAR ground over water is the water surface)
  level(l) {
    const shore = l.rings.flatMap(r => r[0]), step = Math.max(1, Math.floor(shore.length / 64)), hs = [];
    let coarse = false;
    for (let i = 0; i < shore.length; i += step) {
      const [x, z] = shore[i], t = this.engine.tileAt(x, z); if (!t) return null;
      if (t.z < 15) coarse = true; hs.push(t.heightAt(x, z));
    }
    hs.sort((a, b) => a - b);
    return { h: hs[Math.floor(hs.length * 0.2)], coarse };
  }
  build(l) {
    const pos = [], idx = [];
    for (const poly of l.rings) {
      const contour = poly[0].map(([x, z]) => new THREE.Vector2(x - l.cx, -(z - l.cz))), holes = poly.slice(1).map(r => r.map(([x, z]) => new THREE.Vector2(x - l.cx, -(z - l.cz))));
      const base = pos.length / 3, tri = THREE.ShapeUtils.triangulateShape(contour, holes);
      [...contour, ...holes.flat()].forEach(v => pos.push(v.x, v.y, 0));
      tri.forEach(t => idx.push(base + t[0], base + t[1], base + t[2]));
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material); m.rotation.x = -Math.PI / 2; m.position.set(l.cx, 0, l.cz); m.userData.lake = l;
    this.group.add(m); l.mesh = m;
  }

  update(camera, frameN, exag, hidden, target) {
    this.group.visible = !hidden; if (this.mirror) this.mirror.visible = false;
    if (hidden) return;
    if (frameN % 60 === 0) this.ensure(target.x, target.z);
    let nearest = null, best = Infinity;
    for (const l of this.lakes.values()) {
      const d = Math.hypot(l.cx - camera.position.x, l.cz - camera.position.z) - l.radius;
      if (d > 20000) { if (l.mesh) l.mesh.visible = false; continue; }
      if (!l.locked && frameN % 30 === 0) { const r = this.level(l); if (r) { l.level = r.h + 0.15; l.locked = !r.coarse; if (!l.mesh) this.build(l); } }
      if (!l.mesh) continue;
      l.mesh.visible = true; l.mesh.position.y = l.level * exag;
      if (d < best && l.radius > 40) { best = d; nearest = l; }
    }
    // a true mirror for the nearest lake worth it (closer than 4 km). It redraws the whole scene, so it is
    // refreshed only every `mirrorEvery` frames: the ripples hide the slight lag, the frame rate does not suffer
    if (this.mirrorOn && nearest && best < 4000) this.reflect(nearest, exag, frameN % this.mirrorEvery === 0);
    else this.uniforms.hasRefl.value = 0;
  }
  reflect(l, exag, refresh) {
    if (!this.mirror || this.mirror.userData.lake !== l) {
      if (this.mirror) { this.scene.remove(this.mirror); this.mirror.getRenderTarget().dispose(); this.mirror.geometry.dispose(); }
      const r = new Reflector(l.mesh.geometry.clone(), { textureWidth: 384, textureHeight: 384, clipBias: 0.5 });
      r.rotation.x = -Math.PI / 2; r.userData.lake = l;
      // the Reflector only renders the mirror image; our water material draws it, so the Reflector itself is invisible
      r.material.colorWrite = false; r.material.depthWrite = false; r.renderOrder = -2;
      this.scene.add(r); this.mirror = r;
      this.uniforms.tDiffuse.value = r.getRenderTarget().texture; this.uniforms.textureMatrix.value = r.material.uniforms.textureMatrix.value;
    }
    this.mirror.position.set(l.cx, l.level * exag, l.cz); this.mirror.visible = refresh; // invisible = no re-render
    this.uniforms.hasRefl.value = 1;
  }
}
