// Google Photorealistic 3D Tiles, as a separate view mode. Google's terms forbid blending its tiles with other
// map data such as the IGN terrain, so the IGN terrain is hidden while this mode is on; our own overlays
// (labels, weather, precipitation, point sheet) stay on top, and the Google logo and the tiles' attributions
// are shown as the terms require. The key belongs to the owner: typed in the app, kept on the device only.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/index.three.js';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/index.core-plugins.js';
import { GLTFExtensionsPlugin, TileCompressionPlugin, TilesFadePlugin, ReorientationPlugin } from '3d-tiles-renderer/index.three-plugins.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/gltf/';
const KEY_STORE = 'midi3d-google-key';
export const googleKey = {
  get() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
  set(k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { } }
};

// Why Google refused the key, in plain French. Called only after a refusal: a refused request is not billed,
// whereas checking before every start would cost one session each time.
const REASONS = {
  SERVICE_DISABLED: "la Map Tiles API n'est pas activée dans ton projet Google. Active-la sur console.cloud.google.com/apis/library/tile.googleapis.com, attends 2 à 5 minutes, puis réessaie.",
  API_KEY_INVALID: "cette clé n'existe pas (mal copiée ou supprimée).",
  API_KEY_HTTP_REFERRER_BLOCKED: "la clé n'autorise pas ce site. Dans ses restrictions « Sites Web », ajoute https://qdesbuisson87-web.github.io/*.",
  API_KEY_SERVICE_BLOCKED: "la clé est limitée à d'autres API. Dans ses restrictions d'API, coche Map Tiles API.",
  BILLING_DISABLED: "la facturation n'est pas activée sur ton projet Google.",
  RATE_LIMIT_EXCEEDED: "le quota du jour est atteint. Ça revient demain.",
  RESOURCE_EXHAUSTED: "le quota est atteint (plafond du jour de ton projet Google). Ça revient demain, ou relève le plafond dans la console Google (Map Tiles API, Quotas)."
};
export async function whyRefused(key) {
  try {
    const r = await fetch(`${ROOT}?key=${encodeURIComponent(key)}`);
    if (r.ok) return null;
    const j = await r.json().catch(() => null), reason = j?.error?.details?.find(d => d.reason)?.reason ?? j?.error?.status;
    return REASONS[reason] ?? `Google répond « ${j?.error?.message ?? r.status} ».`;
  } catch { return null; }
}

export class GoogleTiles {
  // origin: {lat, lon} of the scene origin; geoidN: geoid height there, so that y = altitude above sea level
  constructor({ scene, camera, renderer, origin, geoidN }) {
    this.scene = scene; this.camera = camera; this.renderer = renderer; this.origin = origin; this.geoidN = geoidN;
    this.tiles = null; this.shown = false; this.error = null; this.errorTarget = 12; this.parkTimer = null;
    // the plugin puts the origin at (0,0,0) with x west and z north; our scene has x east and z south
    this.holder = new THREE.Group(); this.holder.rotation.y = Math.PI;
    this.draco = new DRACOLoader().setDecoderPath(DRACO);
  }
  get on() { return this.shown; }

  // Google bills one session per root request (a session lasts 3 hours): going back to the IGN view parks the
  // tiles out of sight for a while instead of freeing them, so that coming back soon costs no new session and
  // shows at once. Parked longer than PARK, they are freed (graphics memory on a phone).
  start(key, onError) {
    const PARK_SESSION = 2.5 * 3600e3;
    if (this.tiles && this.key === key && Date.now() - this.since < PARK_SESSION) {
      clearTimeout(this.parkTimer); this.onError = onError;
      this.scene.add(this.holder); this.shown = true; return;
    }
    this.dispose(); this.error = null; this.key = key; this.since = Date.now(); this.onError = onError;
    const t = this.tiles = new TilesRenderer(ROOT);
    t.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
    t.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco }));
    t.registerPlugin(new TileCompressionPlugin()); // smaller GPU buffers: matters on phones
    t.registerPlugin(new TilesFadePlugin());       // tiles blend in instead of popping
    t.registerPlugin(new ReorientationPlugin({ lat: this.origin.lat * Math.PI / 180, lon: this.origin.lon * Math.PI / 180, height: this.geoidN, recenter: true }));
    t.errorTarget = this.errorTarget;
    t.setCamera(this.camera); t.setResolutionFromRenderer(this.camera, this.renderer);
    // the scene works in display (sRGB) values end to end, without colour management: show the photos as stored
    t.addEventListener('load-model', ({ scene }) => scene.traverse(o => {
      const m = o.material; if (m?.map) { m.map.colorSpace = THREE.NoColorSpace; m.map.needsUpdate = true; }
    }));
    t.addEventListener('load-error', e => {
      // only the root request matters (tile: null): it fails with 400/403 for a wrong key, a key restricted to
      // other sites, the Map Tiles API not enabled or billing not set up; a single tile failing is not fatal
      if (e.tile) return;
      const m = String(e.error?.message ?? e.error ?? '');
      this.error = /\b429\b/.test(m) ? 'quota' : /\b40[013]\b/.test(m) ? 'key' : 'network';
      this.onError?.(this.error, m);
    });
    this.holder.add(t.group); this.scene.add(this.holder); this.shown = true;
  }
  // back to the IGN view: out of sight, kept PARK minutes (see start)
  stop() {
    if (!this.shown) return;
    this.scene.remove(this.holder); this.shown = false;
    clearTimeout(this.parkTimer); this.parkTimer = setTimeout(() => { if (!this.shown) this.dispose(); }, 10 * 60e3);
  }
  dispose() {
    clearTimeout(this.parkTimer);
    if (!this.tiles) return;
    this.holder.remove(this.tiles.group); this.scene.remove(this.holder);
    this.tiles.dispose(); this.tiles = null; this.shown = false;
  }
  setErrorTarget(e) { this.errorTarget = e; if (this.tiles) this.tiles.errorTarget = e; }
  update() {
    const t = this.tiles; if (!t || !this.shown) return;
    this.camera.updateMatrixWorld();
    t.setResolutionFromRenderer(this.camera, this.renderer);
    t.update();
  }
  get loading() { const s = this.tiles?.stats; return s ? (s.downloading || 0) + (s.parsing || 0) : 0; }
  // data sources of the tiles on screen, most frequent first, as Google asks
  attributions() {
    const list = this.tiles?.getAttributions() ?? [], count = new Map();
    for (const a of list) if (a.type === 'string') for (const s of String(a.value).split(';')) { const k = s.trim(); if (k) count.set(k, (count.get(k) || 0) + 1); }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  }
  // first hit of a ray on the Google surface (x, y altitude, z in scene metres)
  raycast(raycaster) {
    if (!this.tiles || !this.shown) return null;
    raycaster.firstHitOnly = true;
    const hit = raycaster.intersectObject(this.tiles.group, true)[0];
    return hit ? hit.point : null;
  }
}
