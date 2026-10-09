// What each person makes in the app is theirs and stays on their device: their own places (summits, cols, huts…),
// their outings done (history), their massifs, itineraries and settings. Nothing of it is sent anywhere or shown to
// anyone else: the app has no server of its own, every device is its own app. To move to another phone, a backup
// file can be saved and read back.
//  - places: localStorage (small); outings with their GPS lines: IndexedDB (room for years of outings).

// ----- my places -----
const PLACES_STORE = 'midi3d-my-places';
// kinds of place, with the mark shown on the map
export const PLACE_KINDS = {
  sommet: ['Sommet', '▲'], col: ['Col', '⩘'], refuge: ['Refuge, cabane', '⌂'], lac: ['Lac', '≈'], vue: ['Point de vue', '◉'],
  eau: ['Source, eau', '💧'], bivouac: ['Bivouac', '⛺'], parking: ['Parking', 'P'], danger: ['Passage délicat', '⚠'], autre: ['Autre', '●']
};
export const loadMyPlaces = () => { try { return JSON.parse(localStorage.getItem(PLACES_STORE) || '[]'); } catch { return []; } };
export const saveMyPlaces = list => { try { localStorage.setItem(PLACES_STORE, JSON.stringify(list)); return true; } catch { return false; } };

// ----- outings done (history), in IndexedDB -----
const DB = 'midi3d', OUT = 'outings';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(OUT)) r.result.createObjectStore(OUT, { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => { dbp = null; ko(r.error); };
  });
  return dbp;
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((ok, ko) => { const t = d.transaction(OUT, mode), s = t.objectStore(OUT), r = fn(s); t.oncomplete = () => ok(r?.result); t.onerror = () => ko(t.error); }); };
export const listOutings = async () => ((await tx('readonly', s => s.getAll())) ?? []).sort((a, b) => b.date - a.date);
export const putOuting = o => tx('readwrite', s => s.put(o));
export const deleteOuting = id => tx('readwrite', s => s.delete(id));

// a line kept with an outing: at most MAX points (evenly thinned), [lon, lat, time or null] rounded to ~10 cm
const MAX = 3000;
export function thin(pts) {
  const step = Math.max(1, Math.ceil(pts.length / MAX));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => [+p.lon.toFixed(6), +p.lat.toFixed(6), p.t ?? null]);
}
// totals by year: { 2026: { n, dist, up, hours } }
export function totals(list) {
  const out = {};
  for (const o of list) {
    const y = new Date(o.date).getFullYear(), t = out[y] ??= { n: 0, dist: 0, up: 0, hours: 0 };
    t.n++; t.dist += o.stats?.dist ?? 0; t.up += o.stats?.up ?? 0; t.hours += o.stats?.hours ?? 0;
  }
  return out;
}

// ----- backup: everything of mine in one file, and back -----
// keys left out: the API keys and the reminder and sharing channels (secrets, typed again on the new phone), and
// what belongs to this very device (LiDAR store index, compass and camera calibration)
const SECRET = /^midi3d-(google-key|mf-key|ntfy-topic|share|lidar-index|sight-offset|cam-fov)$/;
export async function backup() {
  const local = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('midi3d-') && !SECRET.test(k)) local[k] = localStorage.getItem(k); }
  return { app: 'Montagne 3D', version: 1, saved: new Date().toISOString(), local, outings: await listOutings().catch(() => []) };
}
// reads a backup back: what is in the file replaces the same entries here, the rest is kept
export async function restore(data) {
  if (data?.app !== 'Montagne 3D' || typeof data.local !== 'object') throw new Error("ce fichier n'est pas une sauvegarde de Montagne 3D");
  let n = 0;
  for (const [k, v] of Object.entries(data.local)) if (k.startsWith('midi3d-') && !SECRET.test(k) && typeof v === 'string') { localStorage.setItem(k, v); n++; }
  for (const o of data.outings ?? []) if (o?.id) { await putOuting(o); n++; }
  return n;
}
