// "Tu es ici": the device's position followed live (Geolocation API, https only), drawn as a blue dot on the
// relief with the accuracy as a disc around it. The altitude shown is the relief's under the position (LiDAR),
// far more reliable than a phone's GPS altitude, which is given alongside for information.
import * as THREE from 'three';
import { lonLatToWorld } from './geo.js?v=202610101101';

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
  // Started from a touch (phones ask for the permission only then). A first, rough position comes at once from the
  // network (Wi-Fi, mobile cells, last known fix): the satellites can take a minute indoors or in a valley, and
  // a button that seems to do nothing for that long looks broken. The precise GPS then replaces it.
  start() {
    this.error = null; this.errorCode = 0;
    if (!('geolocation' in navigator)) { this.error = "Cet appareil ou ce navigateur ne donne pas sa position."; this.errorCode = -1; this.onChange?.(); return; }
    if (!self.isSecureContext) { this.error = "La position n'est disponible qu'en https (l'appli en ligne)."; this.errorCode = -1; this.onChange?.(); return; }
    const fix = (p, rough) => {
      const c = p.coords, [x, z] = lonLatToWorld(c.longitude, c.latitude);
      if (rough && this.pos && !this.pos.rough) return; // the precise fix came first
      this.pos = { lon: c.longitude, lat: c.latitude, acc: c.accuracy, gpsAlt: c.altitude, heading: c.heading, speed: c.speed, time: new Date(p.timestamp), x, z, rough };
      this.error = null; this.errorCode = 0; this.group.visible = true; this.onChange?.();
    };
    const fail = e => {
      this.errorCode = e.code;
      this.error = { 1: 'Localisation refusée.', 2: "Position introuvable pour l'instant (localisation du téléphone coupée, ou pas de signal).", 3: 'La position met du temps à venir : nouvel essai en cours (dehors, le GPS la trouve plus vite).' }[e.code] ?? e.message;
      this.onChange?.();
    };
    if (!this.pos) navigator.geolocation.getCurrentPosition(p => this.watch != null && fix(p, true), () => { }, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 });
    this.watch = navigator.geolocation.watchPosition(p => fix(p, false), fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    this.onChange?.();
  }
  stop() { if (this.watch != null) navigator.geolocation.clearWatch(this.watch); this.watch = null; this.pos = null; this.group.visible = false; this.onChange?.(); }
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
