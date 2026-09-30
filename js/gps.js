// "Tu es ici": the device's position followed live (Geolocation API, https only), drawn as a blue dot on the
// relief with the accuracy as a disc around it. The altitude shown is the relief's under the position (LiDAR),
// far more reliable than a phone's GPS altitude, which is given alongside for information.
import * as THREE from 'three';
import { lonLatToWorld } from './geo.js?v=202609301947';

export class GpsTracker {
  constructor({ scene, onChange }) {
    this.onChange = onChange; this.watch = null; this.pos = null; this.error = null;
    this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    // the dot is always drawn on top (small, and one must find oneself even behind a ridge)
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: 0x1e88ff, depthTest: false, transparent: true }));
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1.6, 20, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.dot.renderOrder = this.halo.renderOrder = 10; this.halo.renderOrder = 9;
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1e88ff, transparent: true, opacity: 0.18, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
    this.group.add(this.disc, this.halo, this.dot);
  }
  get on() { return this.watch != null; }
  start() {
    this.error = null;
    if (!('geolocation' in navigator)) { this.error = "Cet appareil ne donne pas sa position."; this.onChange?.(); return; }
    if (!self.isSecureContext) { this.error = "La position n'est disponible qu'en https (l'appli en ligne) ."; this.onChange?.(); return; }
    this.watch = navigator.geolocation.watchPosition(p => {
      const c = p.coords, [x, z] = lonLatToWorld(c.longitude, c.latitude);
      this.pos = { lon: c.longitude, lat: c.latitude, acc: c.accuracy, gpsAlt: c.altitude, heading: c.heading, speed: c.speed, time: new Date(p.timestamp), x, z };
      this.error = null; this.group.visible = true; this.onChange?.();
    }, e => {
      this.error = { 1: "Localisation refusée : autorise-la pour ce site dans les réglages du navigateur.", 2: "Position introuvable pour l'instant (pas de signal GPS ?).", 3: "La position met trop de temps à venir ; nouvel essai en cours." }[e.code] ?? e.message;
      this.onChange?.();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    this.onChange?.();
  }
  stop() { if (this.watch != null) navigator.geolocation.clearWatch(this.watch); this.watch = null; this.group.visible = false; this.onChange?.(); }
  // every frame: sit on the relief, keep the dot a readable size on screen
  update(camera, groundAt, exag) {
    if (!this.pos || !this.group.visible) return;
    const g = groundAt(this.pos.x, this.pos.z); if (g != null) this.pos.ground = g;
    const y = (this.pos.ground ?? this.pos.gpsAlt ?? 0) * exag;
    this.group.position.set(this.pos.x, y, this.pos.z);
    const d = camera.position.distanceTo(this.group.position), s = Math.max(1.5, d * 0.009);
    this.dot.scale.setScalar(s); this.halo.scale.setScalar(s);
    this.dot.position.y = this.halo.position.y = s;
    this.disc.scale.setScalar(Math.max(this.pos.acc, s)); this.disc.position.y = 0.5;
    this.dot.material.opacity = 0.75 + 0.25 * Math.sin(performance.now() / 300);
  }
}
