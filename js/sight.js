// Viewfinder (like PeakFinder): the 3D view placed at the GPS position, at eye height, turned with the phone
// (compass + tilt sensors), so the names of the summits line up with the real ones. The compass of a phone is
// often a few degrees off: dragging sideways re-aligns it by hand, and the correction is kept.
import * as THREE from 'three';

const zee = new THREE.Vector3(0, 0, 1), euler = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const STORE = 'midi3d-sight-offset';

export class Sight {
  constructor() {
    this.on = false; this.orient = null; this.absolute = false; this.offset = 0;
    try { this.offset = +localStorage.getItem(STORE) || 0; } catch { }
    this.onOrient = e => {
      let alpha = e.alpha;
      if (e.webkitCompassHeading != null) { alpha = 360 - e.webkitCompassHeading; this.absolute = true; } // iOS: true compass
      else if (e.absolute || e.type === 'deviceorientationabsolute') this.absolute = true;
      if (alpha == null || e.beta == null) return;
      this.orient = { alpha, beta: e.beta, gamma: e.gamma ?? 0 };
    };
  }
  // must be called from a tap (iOS asks for permission then); resolves to an error message or null
  async start() {
    if (!('DeviceOrientationEvent' in window)) return "Cet appareil n'a pas de boussole accessible : le viseur marche sur un téléphone.";
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return "Accès à la boussole refusé : autorise « Mouvement et orientation » pour ce site."; }
      catch { return "Impossible de demander l'accès à la boussole."; }
    }
    this.orient = null; this.on = true;
    addEventListener('deviceorientationabsolute', this.onOrient); addEventListener('deviceorientation', this.onOrient);
    return null;
  }
  stop() { this.on = false; removeEventListener('deviceorientationabsolute', this.onOrient); removeEventListener('deviceorientation', this.onOrient); }
  nudge(deg) { this.offset = (this.offset + deg + 540) % 360 - 180; try { localStorage.setItem(STORE, this.offset); } catch { } }
  // camera at the eye, turned as the phone (scene: x east, y up, z south, so north is -z as three.js expects)
  apply(camera, eye) {
    camera.position.copy(eye);
    if (!this.orient) return false;
    const r = THREE.MathUtils.degToRad, o = this.orient, turn = r(window.screen.orientation?.angle ?? window.orientation ?? 0);
    euler.set(r(o.beta), r(o.alpha + this.offset), -r(o.gamma), 'YXZ');
    camera.quaternion.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -turn));
    return true;
  }
}
