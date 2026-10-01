// Map controls in the manner of Google Earth.
//  - 1 finger / left button: drag the ground (the point grabbed stays under the finger), glide after release;
//    dragging the sky turns and tilts instead;
//  - wheel / trackpad pinch / 2-finger pinch: zoom towards the point under the cursor or between the fingers;
//  - 2 fingers: pinch = zoom, twist = turn, both fingers up/down together = tilt; two-finger tap = zoom out;
//  - right or middle button, or Ctrl / Shift + left: turn (left-right) and tilt (up-down) around the view centre;
//  - double tap / double click: zoom in ×2.5 on that point;
//  - keyboard: arrows move, + / − zoom, Q / E turn, Page up / down tilt.
//
// The view is a state (look-at point on the ground, distance, heading, tilt). Gestures change a *goal* state
// and the camera follows it with a short exponential easing every frame: movement stays smooth whatever the
// rate of touch events or of frames, and a burst of wheel steps becomes one fluid zoom. Near the relief the
// camera never jumps up: it tilts up just enough to stay above the ground.
// Anything else that moves the camera (flights, the viewfinder, the relief slider) writes camera.position and
// target directly; the controls notice it and carry on from there.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const MAX_TILT = Math.PI * 0.485;          // angle from the vertical: 0 = straight down, ~87° = almost level
const EASE = { move: 30, zoom: 11, turn: 16 }; // 1/s: how fast the view catches up with the gesture
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

class View {
  constructor() { this.t = new THREE.Vector3(); this.d = 1000; this.h = 0; this.p = 0.8; }
  copy(v) { this.t.copy(v.t); this.d = v.d; this.h = v.h; this.p = v.p; return this; }
  eye(out = new THREE.Vector3()) { const s = Math.sin(this.p); return out.set(s * Math.sin(this.h), Math.cos(this.p), s * Math.cos(this.h)).multiplyScalar(this.d).add(this.t); }
  fromCamera(pos, t) {
    const o = pos.clone().sub(t); this.t.copy(t); this.d = Math.max(o.length(), 1e-3);
    this.p = Math.acos(THREE.MathUtils.clamp(o.y / this.d, -1, 1)); this.h = Math.atan2(o.x, o.z); return this;
  }
}

export class EarthControls extends THREE.EventDispatcher {
  // pick(ndcX, ndcY, camera) -> THREE.Vector3 on the surface under a screen point (scene units), or null
  // heightAt(x, z) -> ground height in scene units, or null where nothing is loaded
  constructor(camera, dom, pick, heightAt) {
    super();
    this.camera = camera; this.dom = dom; this.pick = pick; this.heightAt = heightAt;
    this.target = new THREE.Vector3(); this.enabled = true; this.autoRotate = false; this.autoRotateSpeed = 0.3;
    this.minDistance = 12; this.maxDistance = 120000;
    this.cur = new View(); this.goal = new View(); this.gcam = camera.clone();
    this.lastPos = new THREE.Vector3(NaN); this.lastT = new THREE.Vector3(NaN);
    this.pointers = new Map(); this.mode = null; this.vel = new THREE.Vector3(); this.trail = [];
    this.lastTap = 0; this.wheelAt = 0; this.wheelPoint = null; this.ray = new THREE.Raycaster(); this.keys = new Set();
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', e => this.down(e));
    dom.addEventListener('pointermove', e => this.move(e));
    dom.addEventListener('pointerup', e => this.up(e)); dom.addEventListener('pointercancel', e => this.up(e));
    dom.addEventListener('wheel', e => this.wheel(e), { passive: false });
    dom.addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('keydown', e => this.key(e, true)); addEventListener('keyup', e => this.key(e, false));
    addEventListener('blur', () => this.keys.clear());
  }

  // ----- helpers -----
  ndc(x, y) { const r = this.dom.getBoundingClientRect(); return new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1); }
  // the camera as the goal state places it: gestures are measured in the view they lead to, so they never fight
  // the easing (the point grabbed stays under the finger in the goal view; the screen catches up within ~50 ms)
  goalCamera() {
    const c = this.gcam, cam = this.camera;
    if (c.fov !== cam.fov || c.aspect !== cam.aspect || c.near !== cam.near) { c.fov = cam.fov; c.aspect = cam.aspect; c.near = cam.near; c.far = cam.far; c.updateProjectionMatrix(); }
    this.goal.eye(c.position); c.lookAt(this.goal.t); c.updateMatrixWorld(); return c;
  }
  surface(x, y) { const n = this.ndc(x, y); return this.pick(n.x, n.y, this.goalCamera()); }
  // where a screen point's ray meets the horizontal plane at height h, in the goal view
  onPlane(x, y, h) {
    this.ray.setFromCamera(this.ndc(x, y), this.goalCamera());
    const r = this.ray.ray; if (r.direction.y > -0.003) return null; // at or above the horizon: no ground there
    return r.intersectPlane(new THREE.Plane(UP, -h), new THREE.Vector3());
  }
  // a gesture starts: stop what was gliding, and put the look-at point on the ground under the middle of the
  // screen (it lies on the line of sight, so nothing moves on screen; turning and tilting then pivot on real ground)
  begin() {
    this.vel.set(0, 0, 0); this.trail = []; this.goal.copy(this.cur);
    const c = this.goalCamera(), hit = this.pick(0, 0, c);
    if (hit && hit.distanceTo(c.position) > 1) { this.cur.fromCamera(c.position, hit); this.goal.copy(this.cur); }
    this.dispatchEvent({ type: 'start' });
  }

  // ----- pointer -----
  down(e) {
    if (!this.enabled) return;
    try { this.dom.setPointerCapture(e.pointerId); } catch { } // keeps the drag when the finger leaves the canvas
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    this.begin();
    if (this.pointers.size === 1) {
      const now = performance.now(), dbl = now - this.lastTap < 320 && Math.hypot(e.clientX - this.tapX, e.clientY - this.tapY) < 30;
      this.lastTap = dbl ? 0 : now; this.tapX = e.clientX; this.tapY = e.clientY;
      if (dbl) { const p = this.surface(e.clientX, e.clientY); if (p) this.zoomTo(p, 1 / 2.5); this.mode = null; return; }
      this.anchor = (e.button === 0 && !(e.ctrlKey || e.shiftKey || e.metaKey)) ? this.surface(e.clientX, e.clientY) : null;
      this.mode = this.anchor ? 'pan' : 'orbit'; // right/middle button, a modifier key, or the sky: turn and tilt
      this.prev = { x: e.clientX, y: e.clientY };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.mode = 'two'; this.twoMode = null; this.twoMoved = false;
      this.anchor = this.surface(mx, my);
      this.two = { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx, my, my0: my, d0: Math.hypot(b.x - a.x, b.y - a.y), t0: performance.now() };
    }
  }
  move(e) {
    const ptr = this.pointers.get(e.pointerId); if (!ptr || !this.enabled) return;
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (this.mode === 'pan') {
      const q = this.onPlane(e.clientX, e.clientY, this.anchor.y); if (!q) return;
      const s = this.anchor.clone().sub(q); s.y = 0;
      // near the horizon a few pixels are kilometres: never jump more than half the viewing distance at once
      const lim = this.goal.d * 0.5; if (s.length() > lim) s.setLength(lim);
      this.goal.t.add(s);
      this.trail.push({ s, t: performance.now() }); if (this.trail.length > 8) this.trail.shift();
    } else if (this.mode === 'orbit') {
      const dx = e.clientX - this.prev.x, dy = e.clientY - this.prev.y; this.prev = { x: e.clientX, y: e.clientY };
      this.goal.h -= dx * 0.006; this.goal.p = THREE.MathUtils.clamp(this.goal.p - dy * 0.005, 0, MAX_TILT);
    } else if (this.mode === 'two' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x), t = this.two;
      // decided once per gesture: both fingers sliding up or down without pinching = tilt; anything else = move,
      // zoom and turn together, like a sheet of paper under two fingers
      if (!this.twoMode && (Math.abs(my - t.my0) > 10 || Math.abs(d - t.d0) > 10 || Math.abs(wrap(ang - t.ang)) > 0.08)) {
        this.twoMode = Math.abs(my - t.my0) > 2.5 * Math.abs(d - t.d0) && Math.abs(wrap(ang - t.ang)) < 0.12 ? 'tilt' : 'free';
        this.twoMoved = true;
      }
      if (this.twoMode === 'tilt') this.goal.p = THREE.MathUtils.clamp(this.goal.p - (my - t.my) * 0.006, 0, MAX_TILT);
      else if (this.twoMode === 'free' && this.anchor) {
        this.zoomTo(this.anchor, t.d / Math.max(d, 1));
        this.turnAround(this.anchor, wrap(ang - t.ang));
        const q = this.onPlane(mx, my, this.anchor.y);
        if (q) { const s = this.anchor.clone().sub(q); s.y = 0; const lim = this.goal.d * 0.5; if (s.length() > lim) s.setLength(lim); this.goal.t.add(s); }
      }
      Object.assign(t, { d, ang, mx, my });
    }
  }
  up(e) {
    const ptr = this.pointers.get(e.pointerId); this.pointers.delete(e.pointerId);
    if (this.mode === 'two' && this.pointers.size === 1) {
      // a quick two-finger tap that did not move: zoom out, as in map apps
      if (!this.twoMoved && performance.now() - this.two.t0 < 300) { const c = this.surface(this.two.mx, this.two.my); if (c) this.zoomTo(c, 2.5); }
      const [p] = [...this.pointers.values()]; // back to one finger: carry on dragging from there
      this.anchor = this.surface(p.x, p.y); this.mode = this.anchor ? 'pan' : null; this.prev = { x: p.x, y: p.y }; this.trail = [];
    } else if (!this.pointers.size) {
      if (this.mode === 'pan') {
        // glide: the speed of the last ~100 ms of the drag, if the finger was still moving when lifted
        const now = performance.now(), recent = this.trail.filter(k => now - k.t < 100);
        if (recent.length >= 2 && now - recent[recent.length - 1].t < 50) {
          const sum = recent.slice(1).reduce((acc, k) => acc.add(k.s), new THREE.Vector3()), span = (recent[recent.length - 1].t - recent[0].t) / 1000;
          if (span > 0.008) { this.vel.copy(sum.divideScalar(span)); const max = this.goal.d * 3; if (this.vel.length() > max) this.vel.setLength(max); }
        }
      }
      this.mode = null; void ptr;
    }
  }
  wheel(e) {
    if (!this.enabled) return; e.preventDefault();
    // a new wheel gesture only once the previous zoom has settled (on a slow frame rate two steps of the same
    // gesture can be far apart; restarting then would drop the zoom still on its way)
    const now = performance.now(), settled = Math.abs(Math.log(this.goal.d / this.cur.d)) < 0.01 && this.cur.t.distanceTo(this.goal.t) < this.cur.d * 0.002;
    const newGesture = now - this.wheelAt > 250 && settled;
    if (newGesture) this.begin();
    // the point under the cursor is found once per wheel gesture (and again if the cursor moves): every wheel
    // step zooms towards the very same spot, and the relief is not searched 100 times a second
    if (newGesture || !this.wheelPoint || Math.hypot(e.clientX - this.wheelXY[0], e.clientY - this.wheelXY[1]) > 6) {
      this.wheelPoint = this.surface(e.clientX, e.clientY); this.wheelXY = [e.clientX, e.clientY];
    }
    this.wheelAt = now;
    if (!this.wheelPoint) return;
    let dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const k = e.ctrlKey ? 0.012 : 0.0025; // ctrl + wheel = trackpad pinch: small deltas, more sensitive
    this.zoomTo(this.wheelPoint, Math.exp(THREE.MathUtils.clamp(dy * k, -0.7, 0.7)));
  }
  key(e, down) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', 'q', 'e', 'PageUp', 'PageDown'].includes(k)) return;
    e.preventDefault();
    if (down && !this.keys.size) this.begin();
    if (down) this.keys.add(k); else this.keys.delete(k);
  }

  // ----- moves on the goal state -----
  // zoom by factor f towards point p (f < 1 = closer): the camera and the look-at point slide along their lines to p
  zoomTo(p, f) {
    const g = this.goal; f = THREE.MathUtils.clamp(f, this.minDistance / g.d, this.maxDistance / g.d);
    g.t.sub(p).multiplyScalar(f).add(p); g.d *= f;
  }
  // turn by angle a around the vertical through p
  turnAround(p, a) {
    const g = this.goal, q = new THREE.Quaternion().setFromAxisAngle(UP, a);
    g.t.sub(p).applyQuaternion(q).add(p); g.h += a;
  }

  // ----- every frame -----
  update(dt = 1 / 60) {
    dt = Math.min(dt, 0.1);
    const cam = this.camera;
    // moved by someone else (a flight, the viewfinder, the relief slider): continue from there
    if (cam.position.distanceToSquared(this.lastPos) > 1e-6 || this.target.distanceToSquared(this.lastT) > 1e-6 || !(this.lastPos.x === this.lastPos.x)) {
      this.cur.fromCamera(cam.position, this.target); this.goal.copy(this.cur);
    }
    const g = this.goal, c = this.cur;
    // keyboard: speeds per second, relative to the view (moving covers 60 % of the distance per second)
    if (this.keys.size) {
      const fwd = new THREE.Vector3(-Math.sin(g.h), 0, -Math.cos(g.h)), right = new THREE.Vector3(Math.cos(g.h), 0, -Math.sin(g.h)), step = g.d * 0.6 * dt;
      const has = k => this.keys.has(k);
      if (has('ArrowUp')) g.t.addScaledVector(fwd, step); if (has('ArrowDown')) g.t.addScaledVector(fwd, -step);
      if (has('ArrowRight')) g.t.addScaledVector(right, step); if (has('ArrowLeft')) g.t.addScaledVector(right, -step);
      if (has('+') || has('=')) this.zoomTo(g.t.clone(), Math.exp(-1.2 * dt)); if (has('-')) this.zoomTo(g.t.clone(), Math.exp(1.2 * dt));
      if (has('q')) g.h -= 1.2 * dt; if (has('e')) g.h += 1.2 * dt;
      if (has('PageUp')) g.p = Math.min(MAX_TILT, g.p + 0.8 * dt); if (has('PageDown')) g.p = Math.max(0, g.p - 0.8 * dt);
    }
    // glide after a fling, slowing down over about a second
    if (this.mode !== 'pan' && this.vel.lengthSq() > 1e-6) {
      g.t.addScaledVector(this.vel, dt); this.vel.multiplyScalar(Math.exp(-dt * 3.2));
      if (this.vel.length() < g.d * 0.01) this.vel.set(0, 0, 0);
    }
    if (this.autoRotate) g.h -= this.autoRotateSpeed * dt * 0.1;
    // the view catches up with the goal (exponential easing, independent of the frame rate)
    const a = k => 1 - Math.exp(-k * dt);
    c.t.lerp(g.t, a(EASE.move));
    c.d = Math.exp(THREE.MathUtils.lerp(Math.log(c.d), Math.log(g.d), a(EASE.zoom)));
    c.h += wrap(g.h - c.h) * a(EASE.turn);
    c.p += (g.p - c.p) * a(EASE.turn);
    if (Math.abs(g.h) > 100) { const k = Math.round(g.h / (2 * Math.PI)) * 2 * Math.PI; g.h -= k; c.h -= k; }
    this.keepAboveGround();
    c.eye(cam.position); cam.lookAt(c.t); cam.updateMatrixWorld();
    this.target.copy(c.t); this.lastPos.copy(cam.position); this.lastT.copy(c.t);
  }
  // the camera stays a few metres above the relief: if it would go under, the view tilts towards the vertical
  // around the look-at point just enough (and the goal with it, so the gesture does not push against the ground)
  keepAboveGround() {
    if (!this.heightAt) return;
    const c = this.cur, g = this.goal, eye = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      c.eye(eye); const gr = this.heightAt(eye.x, eye.z); if (gr == null) return;
      const need = gr + Math.max(4, c.d * 0.01) - c.t.y; // camera height wanted above the look-at point
      if (c.d * Math.cos(c.p) >= need - 0.01) return;
      if (need >= c.d) { c.p = 0; c.d = Math.min(this.maxDistance, need); g.d = Math.max(g.d, c.d); }
      else c.p = Math.acos(need / c.d);
      g.p = Math.min(g.p, c.p);
    }
  }
}
