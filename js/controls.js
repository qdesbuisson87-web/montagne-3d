// Map controls in the manner of Google Earth: the ground is grabbed and follows the finger exactly.
//  - 1 finger / left button: drag the ground (it stays under the finger), with a glide after release;
//  - wheel / pinch: zoom towards the point under the cursor or between the fingers, speed ∝ distance;
//  - 2 fingers: pinch = zoom, twist = turn, both fingers up/down together = tilt;
//  - right button, or Ctrl / Shift + left: turn and tilt around the point under the cursor;
//  - double tap / double click: zoom in ×2.5 on that point.
// Same surface as OrbitControls for the rest of the app: `target`, `update()`, `enabled`, 'start' event.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0), MIN_TILT = 0.03, MAX_TILT = Math.PI * 0.49; // angle between view and vertical

export class EarthControls extends THREE.EventDispatcher {
  // groundAt(ndcX, ndcY) -> THREE.Vector3 on the relief under a screen point, or null
  constructor(camera, dom, groundAt) {
    super();
    this.camera = camera; this.dom = dom; this.groundAt = groundAt;
    this.target = new THREE.Vector3(); this.enabled = true; this.autoRotate = false; this.autoRotateSpeed = 0.3;
    this.minDistance = 15; this.maxDistance = 90000;
    this.pointers = new Map(); this.mode = null; this.vel = new THREE.Vector3(); this.zoomQueue = 0; this.zoomAt = null;
    this.lastTap = 0; this.ray = new THREE.Raycaster();
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', e => this.down(e));
    dom.addEventListener('pointermove', e => this.move(e));
    dom.addEventListener('pointerup', e => this.up(e)); dom.addEventListener('pointercancel', e => this.up(e));
    dom.addEventListener('wheel', e => this.wheel(e), { passive: false });
    dom.addEventListener('contextmenu', e => e.preventDefault());
  }
  ndc(x, y) { const r = this.dom.getBoundingClientRect(); return new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1); }
  // where a screen point's ray meets the horizontal plane at height y (the grabbed ground's height)
  onPlane(x, y, h) {
    this.camera.updateMatrixWorld(); // several pointer events can come between two frames: use the camera as it is now
    this.ray.setFromCamera(this.ndc(x, y), this.camera);
    const p = new THREE.Vector3(); return this.ray.ray.intersectPlane(new THREE.Plane(UP, -h), p) ? p : null;
  }
  grab(x, y) { const n = this.ndc(x, y); return this.groundAt(n.x, n.y) ?? this.onPlane(x, y, this.target.y); }
  start() { this.vel.set(0, 0, 0); this.zoomQueue = 0; this.dispatchEvent({ type: 'start' }); }

  down(e) {
    if (!this.enabled) return;
    try { this.dom.setPointerCapture(e.pointerId); } catch { } // keeps the drag when the finger leaves the canvas
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.start();
    if (this.pointers.size === 1) {
      const now = performance.now(), dbl = now - this.lastTap < 300 && Math.hypot(e.clientX - this.tapX, e.clientY - this.tapY) < 30;
      this.lastTap = now; this.tapX = e.clientX; this.tapY = e.clientY;
      if (dbl) { const p = this.grab(e.clientX, e.clientY); if (p) { this.zoomAt = p; this.zoomQueue += Math.log(1 / 2.5); } this.mode = null; return; }
      const orbit = e.button === 2 || e.ctrlKey || e.shiftKey || e.metaKey;
      this.mode = orbit ? 'orbit' : 'pan';
      this.anchor = this.grab(e.clientX, e.clientY);
      this.prev = { x: e.clientX, y: e.clientY, t: performance.now() };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.mode = 'two'; this.twoMode = null;
      this.anchor = this.grab(mx, my);
      this.two = { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx, my, y0: my, d0: Math.hypot(b.x - a.x, b.y - a.y) };
    }
  }
  move(e) {
    if (!this.pointers.has(e.pointerId) || !this.enabled) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.mode === 'pan' && this.anchor) {
      const p = this.onPlane(e.clientX, e.clientY, this.anchor.y); if (!p) return;
      const d = this.anchor.clone().sub(p); d.y = 0;
      this.shift(d);
      const now = performance.now(), dt = Math.max(1, now - this.prev.t) / 1000;
      this.vel.lerp(d.clone().divideScalar(dt), 0.5); this.prev = { x: e.clientX, y: e.clientY, t: now };
    } else if (this.mode === 'orbit' && this.anchor) {
      const dx = e.clientX - this.prev.x, dy = e.clientY - this.prev.y; this.prev = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.turn(this.anchor, -dx * 0.005); this.tilt(this.anchor, -dy * 0.004);
    } else if (this.mode === 'two' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x), t = this.two;
      // decide once: fingers moving up/down together without pinching = tilt; anything else = move, zoom, turn
      if (!this.twoMode && (Math.abs(my - t.y0) > 12 || Math.abs(d - t.d0) > 12)) this.twoMode = Math.abs(my - t.y0) > 2.5 * Math.abs(d - t.d0) ? 'tilt' : 'free';
      if (this.twoMode === 'tilt') this.tilt(this.anchor, -(my - t.my) * 0.005);
      else if (this.twoMode === 'free' && this.anchor) {
        this.zoom(this.anchor, t.d / Math.max(d, 1));
        this.turn(this.anchor, ang - t.ang);
        const p = this.onPlane(mx, my, this.anchor.y); if (p) { const s = this.anchor.clone().sub(p); s.y = 0; this.shift(s); }
      }
      Object.assign(t, { d, ang, mx, my });
    }
  }
  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1 && this.mode === 'two') { // back to one finger: carry on dragging from there
      const [p] = [...this.pointers.values()]; this.mode = 'pan'; this.anchor = this.grab(p.x, p.y); this.prev = { x: p.x, y: p.y, t: performance.now() };
    } else if (!this.pointers.size) {
      if (this.mode !== 'pan' || performance.now() - (this.prev?.t ?? 0) > 80) this.vel.set(0, 0, 0); // a pause before lifting: no glide
      this.mode = null;
    }
  }
  wheel(e) {
    if (!this.enabled) return; e.preventDefault();
    const p = this.grab(e.clientX, e.clientY); if (!p) return;
    this.dispatchEvent({ type: 'start' }); this.vel.set(0, 0, 0);
    const lines = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.zoomAt = p; this.zoomQueue += Math.max(-0.9, Math.min(0.9, lines * 0.0022)); // eased over the next frames
  }

  // ----- moves -----
  shift(d) { this.camera.position.add(d); this.target.add(d); this.camera.updateMatrixWorld(); }
  zoom(p, f) {
    const c = this.camera.position, dist = c.distanceTo(p);
    f = THREE.MathUtils.clamp(f, this.minDistance / dist, this.maxDistance / dist);
    c.sub(p).multiplyScalar(f).add(p); this.target.sub(p).multiplyScalar(f).add(p); this.camera.updateMatrixWorld();
  }
  turn(p, a) { const q = new THREE.Quaternion().setFromAxisAngle(UP, a); for (const v of [this.camera.position, this.target]) v.sub(p).applyQuaternion(q).add(p); this.camera.lookAt(this.target); this.camera.updateMatrixWorld(); }
  tilt(p, a) {
    const dir = this.target.clone().sub(this.camera.position).normalize(), cur = Math.acos(THREE.MathUtils.clamp(-dir.y, -1, 1)); // 0 = looking straight down
    a = THREE.MathUtils.clamp(cur + a, MIN_TILT, MAX_TILT) - cur; if (!a) return;
    const axis = new THREE.Vector3().crossVectors(dir, UP).normalize(); if (!axis.lengthSq()) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, -a);
    for (const v of [this.camera.position, this.target]) v.sub(p).applyQuaternion(q).add(p);
    this.camera.lookAt(this.target); this.camera.updateMatrixWorld();
  }
  // every frame: glide after a fling, eased wheel zoom, slow automatic turn
  update(dt = 1 / 60) {
    if (this.mode !== 'pan' && this.vel.lengthSq() > 1e-4) { this.shift(this.vel.clone().multiplyScalar(dt)); this.vel.multiplyScalar(Math.pow(0.04, dt)); }
    if (Math.abs(this.zoomQueue) > 1e-4 && this.zoomAt) { const s = this.zoomQueue * Math.min(1, dt * 12); this.zoomQueue -= s; this.zoom(this.zoomAt, Math.exp(s)); }
    if (this.autoRotate) this.turn(this.target, -this.autoRotateSpeed * dt * 0.1);
    this.camera.lookAt(this.target);
  }
}
