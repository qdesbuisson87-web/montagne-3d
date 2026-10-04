// Google's photorealistic 3D, as a separate view: the 3D map of the Maps JavaScript API (Map3DElement), laid over
// the scene. Why not the tiles in our own scene any more: since Google's EEA terms (8 July 2025), the Map Tiles API
// no longer serves its photorealistic 3D tiles to projects billed in the European Economic Area, and the owner's is
// (refused on 04/10/2026). Google names this 3D map as the way left. It is Google's renderer: its own light and sky,
// its logo and data credits drawn by itself (as its terms require), and nothing of ours blended into its surface;
// our summits, huts and itinerary are put on it as Google's own markers and line. The camera is handed over both
// ways, so going from one view to the other keeps the place looked at. The key belongs to the owner: typed in the
// app, kept on the device only, sent only to Google.
const KEY_STORE = 'midi3d-google-key';
export const googleKey = {
  get() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
  set(k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { } }
};

// The API loads once per page, with one key: a key changed later needs the page reloaded (said in the app).
let api = null, apiKey = null, onAuthFail = null;
function loadApi(key) {
  if (api) return api;
  apiKey = key;
  api = new Promise((ok, ko) => {
    window.__midi3dMaps = ok;
    // Google calls this when it refuses the key (API not enabled, key not allowed for this site or this API…)
    window.gm_authFailure = () => { onAuthFail?.(); ko(new Error('key')); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=maps3d&language=fr&region=FR&loading=async&callback=__midi3dMaps`;
    s.async = true; s.onerror = () => { api = null; ko(new Error('network')); };
    document.head.appendChild(s);
  });
  return api;
}
export const keyChanged = key => apiKey != null && key !== apiKey;

export class GoogleMap3D {
  constructor(host) { this.host = host; this.map = null; this.shown = false; this.extras = []; }
  get on() { return this.shown; }
  // cam: { lat, lng, range, heading, tilt } (degrees, metres); marks: [{ name, lat, lng, small }]; path: [{ lat, lng }]
  async open(key, cam, { marks = [], path = [] }, onError) {
    this.onError = onError; onAuthFail = () => this.fail('key', '');
    const gen = this.gen = (this.gen || 0) + 1; // back to our view while loading: this opening is dropped
    await loadApi(key);
    const { Map3DElement, Marker3DElement, Polyline3DElement, MapMode, AltitudeMode } = await google.maps.importLibrary('maps3d');
    if (gen !== this.gen) return;
    if (!this.map) {
      this.map = new Map3DElement({ mode: MapMode.SATELLITE, defaultUIHidden: true });
      this.map.addEventListener('gmp-error', e => this.fail('map', e?.error?.message ?? ''));
      // a touch on Google's map: its place goes to the app (point sheet, drawing, choosing a point), as on ours
      this.map.addEventListener('gmp-click', e => { const p = e.position; if (p) this.onTap?.({ lat: p.lat, lng: p.lng }); });
      this.map.addEventListener('gmp-steadychange', e => { if (e.isSteady) { this.steady = true; clearTimeout(this.slowTimer); } });
      this.host.appendChild(this.map);
    }
    Object.assign(this.map, { center: { lat: cam.lat, lng: cam.lng, altitude: 0 }, range: cam.range, heading: cam.heading, tilt: cam.tilt });
    // our names, as Google's markers (the nearest, so that the map stays readable), and the itinerary
    for (const el of this.extras) el.remove(); this.extras = [];
    for (const m of marks) {
      const el = new Marker3DElement({ position: { lat: m.lat, lng: m.lng }, altitudeMode: AltitudeMode.CLAMP_TO_GROUND, label: m.name, extruded: !m.small, sizePreserved: true, collisionPriority: m.small ? 0 : 1 });
      this.map.appendChild(el); this.extras.push(el);
    }
    this.lib = { Polyline3DElement, Marker3DElement, AltitudeMode }; this.setPath(path); this.me?.remove(); this.me = null;
    this.host.hidden = false; this.shown = true;
    // nothing drawn after 30 s (refused without a word, or no connection): back to our view rather than a black screen
    clearTimeout(this.slowTimer);
    if (!this.steady) this.slowTimer = setTimeout(() => { if (!this.steady) this.fail('slow', ''); }, 30e3);
  }
  // the itinerary on Google's map (again when it changes: drawing, planner…); parts hidden by the relief stay seen
  setPath(path) {
    if (!this.map || !this.lib) return;
    this.line?.remove(); this.line = null;
    if (path.length < 2) return;
    const { Polyline3DElement, AltitudeMode } = this.lib;
    this.line = new Polyline3DElement({ path, altitudeMode: AltitudeMode.CLAMP_TO_GROUND, strokeColor: '#ff3b30', strokeWidth: 6, outerColor: '#3a0a08', outerWidth: 0.35, drawsOccludedSegments: true });
    this.map.appendChild(this.line);
  }
  // my GPS position on Google's map (null: none)
  setMe(pos) {
    if (!this.map || !this.lib) return;
    if (!pos) { this.me?.remove(); this.me = null; return; }
    if (!this.me) { this.me = new this.lib.Marker3DElement({ altitudeMode: this.lib.AltitudeMode.CLAMP_TO_GROUND, label: 'Ma position', sizePreserved: true, collisionPriority: 2 }); this.map.appendChild(this.me); }
    this.me.position = { lat: pos.lat, lng: pos.lng };
  }
  // our camera moves (a place searched, back to the summit, my position…) made by Google's camera
  flyTo(cam, ms) {
    if (!this.map || !this.shown) return;
    this.map.flyCameraTo({ endCamera: { center: { lat: cam.lat, lng: cam.lng, altitude: 0 }, range: cam.range, heading: cam.heading, tilt: cam.tilt }, durationMillis: Math.max(300, ms) });
  }
  // back to our view: the camera as Google has it now (null if the map never showed)
  close() {
    this.gen = (this.gen || 0) + 1; clearTimeout(this.slowTimer); this.host.hidden = true; this.shown = false;
    const m = this.map; if (!m?.center) return null;
    return { lat: m.center.lat, lng: m.center.lng, range: m.range ?? 3000, heading: m.heading ?? 0, tilt: m.tilt ?? 60 };
  }
  fail(kind, msg) { if (!this.shown) return; this.close(); this.onError?.(kind, msg); }
}
