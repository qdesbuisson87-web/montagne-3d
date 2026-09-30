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
  [u => u.startsWith('https://planetarycomputer.microsoft.com/'), new Lane(12, 24, 10)]
];
const laneFor = url => LANES.find(([m]) => m(url))?.[1];

// fetch with retries on refusals and network errors; throws TransientError when it gives up
export async function netFetch(url, attempts = 5) {
  const lane = laneFor(url);
  for (let a = 0; ; a++) {
    if (!navigator.onLine) throw new TransientError('hors ligne');
    if (lane) await lane.acquire();
    let r = null;
    try { r = await fetch(url, { mode: 'cors' }); } catch { r = null; } finally { lane?.release(); }
    if (r && !RETRY.has(r.status)) { lane?.ok(); return r; }
    if (r) lane?.refused(+r.headers.get('retry-after'));
    if (a + 1 >= attempts) throw new TransientError(r ? `${r.status}` : 'réseau');
    await sleep(Math.min(20000, 800 * 2 ** a * (0.75 + Math.random() * 0.5)));
  }
}

export async function cachedFetch(url, store = true) {
  const c = await tileCache();
  if (c) { const hit = await c.match(url).catch(() => null); if (hit) return hit; }
  const r = await netFetch(url);
  if (r.ok && c && store) c.put(url, r.clone()).catch(() => { });
  return r;
}
