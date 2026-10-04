// Live position sharing, without a server of our own: positions are published on a secret channel of ntfy.sh
// (free public message service, open to browsers; anonymous use: 250 messages a day per connection, each kept
// 12 hours), and whoever opens the link (?suivre=<channel>) reads them back and sees the walker on the 3D map.
// The channel name is 24 random characters: only those who have the link can find it. Nothing else is sent than
// what the person following needs: position, accuracy, altitude, time, first name, battery when the phone tells.
import * as THREE from 'three';
import { lonLatToWorld } from './geo.js?v=202610041920';
import { timedFetch } from './net.js?v=202610041920';

const HOST = 'https://ntfy.sh', STORE = 'midi3d-share', DAY_CAP = 230; // below the service's 250, keeping a margin
const EVERY = 120e3, EVERY_STILL = 300e3, MOVED = 50; // ms between sends (moving / standing still), metres that count as moving

const newChannel = () => 'm3d-' + [...crypto.getRandomValues(new Uint8Array(18))].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const metres = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371000; };

// ----- sharing my position -----
export class LiveShare {
  constructor(onChange) {
    this.onChange = onChange; this.state = null;
    try { this.state = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { }
    if (this.state && Date.now() > this.state.until) this.state = null; // a share is never left running for days
  }
  get on() { return !!this.state; }
  link(base) { return `${base}&suivre=${this.state.channel}`; }
  save() { try { if (this.state) localStorage.setItem(STORE, JSON.stringify(this.state)); else localStorage.removeItem(STORE); } catch { } }
  start(name) {
    this.state = { channel: newChannel(), name: name || 'Randonneur', since: Date.now(), until: Date.now() + 14 * 3600e3, sent: 0, day: new Date().toDateString(), last: null, error: null };
    this.save(); this.onChange?.();
  }
  async stop() {
    const s = this.state; if (!s) return;
    this.state = null; this.save(); this.onChange?.();
    await this.publish(s, { stop: true, t: Date.now(), name: s.name }).catch(() => { }); // tells the follower it ended
  }
  async publish(s, msg) {
    const r = await timedFetch(`${HOST}/${s.channel}`, { method: 'POST', body: JSON.stringify(msg) }, 15000);
    if (!r.ok) throw new Error(r.status === 429 ? 'limite du service atteinte pour aujourd\'hui' : `service ${r.status}`);
  }
  // a GPS fix: sent if it is time (every 2 min when moving, 5 min standing still), within the day's allowance
  async fix(p) {
    const s = this.state; if (!s || !p || this.busy) return;
    if (Date.now() > s.until) { this.stop(); return; }
    const today = new Date().toDateString(); if (s.day !== today) { s.day = today; s.sent = 0; }
    const moved = !s.last || metres(s.last, p) > MOVED, due = !s.last || Date.now() - s.last.t >= (moved ? EVERY : EVERY_STILL);
    if (!due || s.sent >= DAY_CAP) return;
    this.busy = true;
    const batt = await navigator.getBattery?.().then(b => Math.round(b.level * 100)).catch(() => null) ?? null;
    const msg = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), acc: Math.round(p.acc), alt: p.ground != null ? Math.round(p.ground) : p.gpsAlt != null ? Math.round(p.gpsAlt) : null, t: +p.time, name: s.name, batt };
    try { await this.publish(s, msg); s.sent++; s.last = { lat: p.lat, lon: p.lon, t: Date.now() }; s.error = null; }
    catch (e) { s.error = e.message; }
    this.busy = false; this.save(); this.onChange?.();
  }
}

// ----- following someone's position (link ?suivre=<channel>) -----
export class LiveFollow {
  constructor({ scene, channel, onChange }) {
    this.channel = channel; this.onChange = onChange; this.points = []; this.ended = false; this.error = null; this.seen = new Set();
    this.group = new THREE.Group(); scene.add(this.group);
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: 0xff8a1e, depthTest: false, transparent: true }));
    this.ring = new THREE.Mesh(new THREE.SphereGeometry(1.6, 20, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.dot.renderOrder = 10; this.ring.renderOrder = 9; this.group.add(this.ring, this.dot); this.group.visible = false;
    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff8a1e, depthTest: false, transparent: true, opacity: 0.85 }));
    this.trail.renderOrder = 8; this.trail.frustumCulled = false; scene.add(this.trail);
    this.label = Object.assign(document.createElement('div'), { className: 'label follow' }); this.label.innerHTML = '<span class="t"><span class="n"></span><span class="h"></span></span>';
    document.getElementById('labels').appendChild(this.label);
    this.poll(); this.timer = setInterval(() => this.poll(), 30e3);
  }
  get last() { return this.points[this.points.length - 1] ?? null; }
  async poll() {
    try {
      const r = await timedFetch(`${HOST}/${this.channel}/json?poll=1&since=12h`, {}, 20000);
      if (!r.ok) throw new Error(`service ${r.status}`);
      for (const line of (await r.text()).split('\n')) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event !== 'message' || this.seen.has(ev.id)) continue; this.seen.add(ev.id);
        let m; try { m = JSON.parse(ev.message); } catch { continue; }
        if (m.stop) { this.ended = true; this.name = m.name; continue; }
        if (typeof m.lat !== 'number' || typeof m.lon !== 'number') continue;
        const [x, z] = lonLatToWorld(m.lon, m.lat);
        this.points.push({ ...m, x, z }); this.name = m.name; this.ended = false;
      }
      this.points.sort((a, b) => a.t - b.t); this.error = null; this.dirty = true;
    } catch (e) { this.error = e.message; }
    this.onChange?.();
  }
  update(camera, groundAt, exag, w, h) {
    const p = this.last; this.group.visible = !!p;
    if (!p) { this.label.classList.add('hidden'); return; }
    const g = groundAt(p.x, p.z), y = (g ?? p.alt ?? 0) * exag;
    this.group.position.set(p.x, y, p.z);
    const s = Math.max(1.5, camera.position.distanceTo(this.group.position) * 0.009);
    this.dot.scale.setScalar(s); this.ring.scale.setScalar(s); this.dot.position.y = this.ring.position.y = s;
    if (this.dirty || this.exag !== exag) {
      const pos = []; for (const q of this.points) pos.push(q.x, ((groundAt(q.x, q.z) ?? q.alt ?? 0) + 3) * exag, q.z);
      this.trail.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); this.trail.geometry.computeBoundingSphere();
      this.dirty = false; this.exag = exag;
    }
    const v = new THREE.Vector3(p.x, y + s * 2, p.z).project(camera), on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    this.label.classList.toggle('hidden', !on);
    if (on) {
      this.label.querySelector('.n').textContent = this.name || 'Position partagée';
      this.label.querySelector('.h').textContent = new Date(p.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      this.label.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
    }
  }
}
