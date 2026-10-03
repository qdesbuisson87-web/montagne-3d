// Network access for map data.
// 1. Cache Storage first: every tile fetched is kept on disk, so revisits and offline packs load without network.
// 2. Then the network, through a polite queue per service. IGN's Géoplateforme answers 429 as soon as a client
//    goes over its request budget (about 40 elevation requests in a burst); a refused request used to be taken
//    for "no data" and the tile fell back for good to coarser relief. Now the queue slows down (AIMD, like TCP),
//    waits, and retries. Only real answers ("no data here") lead to a fallback.
export const TILE_CACHE = 'midi3d-tiles-v1';
let cacheP = null;
const tileCache = () => (cacheP ??= (self.caches && self.isSecureContext ? caches.open(TILE_CACHE).catch(() => null) : Promise.resolve(null)));
export const resetTileCache = () => { cacheP = null; };

// Thrown when a request could not get an answer now (offline, rate-limited, server down): try again later,
// never replace the data by a fallback because of it.
export class TransientError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// A request that never answers (weak signal in the mountains: the phone keeps the connection open for minutes)
// would hold its place in the queue for ever, and a few of them froze the loading of the relief: given up after
// `ms` (until the answer starts to arrive), then treated as a network failure.
export function timedFetch(url, init = {}, ms = 30000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}
const RETRY = new Set([408, 425, 429, 500, 502, 503, 504]);

class Lane {
  constructor(rate, max, conc) { this.rate = rate; this.min = 1; this.max = max; this.conc = conc; this.active = 0; this.next = 0; this.pausedUntil = 0; this.waiters = []; }
  async acquire() {
    // one slot at a time, spaced by 1/rate, never more than `conc` in flight
    for (;;) {
      const now = performance.now(), wait = Math.max(this.next, this.pausedUntil) - now;
      if (this.active < this.conc && wait <= 0) { this.active++; this.next = now + 1000 / this.rate; return; }
      if (this.active >= this.conc) await new Promise(r => this.waiters.push(r)); else await sleep(wait);
    }
  }
  release() { this.active--; this.waiters.shift()?.(); }
  ok() { this.rate = Math.min(this.max, this.rate + 0.2); }
  refused(retryAfter) {
    this.rate = Math.max(this.min, this.rate / 2);
    this.pausedUntil = Math.max(this.pausedUntil, performance.now() + (retryAfter > 0 ? retryAfter * 1000 : 1500));
  }
}
// rates in requests per second (start, ceiling), then how many may be in flight at once
const LANES = [
  [u => u.startsWith('https://data.geopf.fr/wms-r/'), new Lane(12, 25, 6)],
  [u => u.startsWith('https://data.geopf.fr/wmts'), new Lane(30, 60, 10)],
  [u => u.startsWith('https://data.geopf.fr/wms-v/'), new Lane(10, 20, 6)], // forest map (BD Forêt)
  [u => u.startsWith('https://mapsref.brgm.fr/'), new Lane(6, 12, 4)], // avalanche map (Géorisques)
  [u => u.startsWith('https://planetarycomputer.microsoft.com/'), new Lane(12, 24, 10)],
  // LiDAR point clouds (IGN download service): its answers announce a budget of about 10 requests per second
  [u => u.startsWith('https://data.geopf.fr/telechargement/'), new Lane(5, 8, 4)],
  // BD TOPO by WFS (paths, streams, lakes, glaciers, buildings, lights…): a view that moves asks for dozens of
  // cells at once, and half of them were refused (measured: 51 refusals in 101 requests) before this lane
  [u => u.startsWith('https://data.geopf.fr/wfs/'), new Lane(4, 12, 4)],
  // walking itineraries: their own lane, so that a stretch being drawn never waits behind map cells
  [u => u.startsWith('https://data.geopf.fr/navigation/'), new Lane(4, 8, 2)],
  // the rest of the Géoplateforme (altitudes, place search)
  [u => u.startsWith('https://data.geopf.fr/'), new Lane(5, 10, 4)]
];
const laneFor = url => LANES.find(([m]) => m(url))?.[1];

// fetch with retries on refusals and network errors; throws TransientError when it gives up
export async function netFetch(url, attempts = 5, init = {}) {
  const lane = laneFor(url);
  for (let a = 0; ; a++) {
    if (!navigator.onLine) throw new TransientError('hors ligne');
    if (lane) await lane.acquire();
    let r = null;
    try { r = await timedFetch(url, { mode: 'cors', ...init }); } catch { r = null; } finally { lane?.release(); }
    if (r && !RETRY.has(r.status)) { lane?.ok(); return r; }
    if (r) lane?.refused(+r.headers.get('retry-after'));
    if (a + 1 >= attempts) throw new TransientError(r ? `${r.status}` : 'réseau');
    await sleep(Math.min(20000, 800 * 2 ** a * (0.75 + Math.random() * 0.5)));
  }
}

// The same answer can come from several servers (mirrors): try them in turn, each with a time limit, and keep
// the first good answer under `key` in the tile cache (so it is found again offline, whichever server gave it).
export async function mirroredFetch(key, urls, timeoutMs = 20000) {
  const c = await tileCache();
  if (c) { const hit = await c.match(key).catch(() => null); if (hit) return hit; }
  for (const url of urls) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { mode: 'cors', signal: ctl.signal });
      if (r.ok) { if (c) c.put(key, r.clone()).catch(() => { }); return r; }
    } catch { } finally { clearTimeout(timer); }
  }
  throw new TransientError('aucun serveur ne répond');
}

export async function cachedFetch(url, store = true) {
  const c = await tileCache();
  if (c) { const hit = await c.match(url).catch(() => null); if (hit) return hit; }
  const r = await netFetch(url);
  if (r.ok && c && store) c.put(url, r.clone()).catch(() => { });
  return r;
}
