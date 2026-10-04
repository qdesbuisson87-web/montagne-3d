// Street-level and 360° photos from Panoramax (the free, IGN-backed geographic photo commons), shown as dots on
// the relief around the view; touching one opens its preview with author, date and licence (mostly CC BY-SA),
// and a link to the Panoramax viewer. Photos come in sequences every few metres: one dot per ~150 m is kept.
import * as THREE from 'three';
import { lonLatToWorld, worldToLonLat } from './geo.js?v=202610042107';
import { cachedFetch } from './net.js?v=202610042107';

const CELL = 0.03, KEEP = 150;
const API = (w, s, e, n) => `https://api.panoramax.xyz/api/search?bbox=${w},${s},${e},${n}&limit=1000`;

export class Photos360 {
  constructor({ scene, groundAt }) {
    this.groundAt = groundAt; this.on = false; this.cells = new Set(); this.photos = []; this.kept = new Set(); this.dirty = true;
    const dot = document.createElement('canvas'); dot.width = dot.height = 64; const c = dot.getContext('2d');
    c.fillStyle = '#fff'; c.beginPath(); c.arc(32, 32, 30, 0, 7); c.fill(); c.fillStyle = '#e8590c'; c.beginPath(); c.arc(32, 32, 21, 0, 7); c.fill();
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 16, sizeAttenuation: false, map: new THREE.CanvasTexture(dot), transparent: true, alphaTest: 0.3, depthTest: true }));
    this.points.renderOrder = 8; this.points.frustumCulled = false; this.points.visible = false; scene.add(this.points);
  }
  ensure(x, z) {
    const [lon, lat] = worldToLonLat(x, z);
    for (let a = Math.floor((lat - 0.03) / CELL); a <= Math.floor((lat + 0.03) / CELL); a++) for (let b = Math.floor((lon - 0.04) / CELL); b <= Math.floor((lon + 0.04) / CELL); b++) {
      const key = `${a}/${b}`; if (this.cells.has(key)) continue; this.cells.add(key);
      cachedFetch(API(b * CELL, a * CELL, (b + 1) * CELL, (a + 1) * CELL)).then(r => r.ok ? r.json() : null).then(j => {
        if (!j) { this.cells.delete(key); return; }
        for (const f of j.features ?? []) {
          const [plon, plat] = f.geometry.coordinates, [px, pz] = lonLatToWorld(plon, plat), grid = `${Math.round(px / KEEP)}/${Math.round(pz / KEEP)}`;
          if (this.kept.has(grid)) continue; this.kept.add(grid);
          const p = f.properties, thumb = f.assets?.thumb?.href, sd = f.assets?.sd?.href;
          this.photos.push({ id: f.id, x: px, z: pz, date: p.datetime ? new Date(p.datetime) : null, license: p.license ?? '', author: f.providers?.[0]?.name ?? p['geovisio:producer'] ?? '', pano: (p['pers:interior_orientation']?.field_of_view ?? 0) >= 360, thumb, sd });
        }
        this.dirty = true;
      }).catch(() => this.cells.delete(key));
    }
  }
  update(target, frameN, exag, hidden) {
    this.points.visible = this.on && !hidden; if (!this.points.visible) return;
    if (frameN % 60 === 0) this.ensure(target.x, target.z);
    if (!this.dirty && frameN % 120 !== 0) return;
    const pos = [];
    for (const p of this.photos) { const g = this.groundAt(p.x, p.z); if (g != null) p.h = g; pos.push(p.x, ((p.h ?? 0) + 3) * exag, p.z); }
    this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); this.points.geometry.computeBoundingSphere();
    this.dirty = false; this.exag = exag;
  }
  // the photo whose dot is under a screen point (pixels), if any within 22 px
  pick(sx, sy, camera, w, h) {
    if (!this.points.visible) return null;
    let best = null, bd = 22; const v = new THREE.Vector3();
    for (const p of this.photos) {
      v.set(p.x, ((p.h ?? 0) + 3) * (this.exag ?? 1), p.z).project(camera); if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * w - sx, (-v.y * 0.5 + 0.5) * h - sy); if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
}
