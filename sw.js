// App shell offline cache. Map tiles are cached by the app itself (Cache Storage 'midi3d-tiles-*', see js/net.js);
// weather and satellite data always come from the network.
const CACHE = 'midi3d-v13';
// the Google 3D module (3d-tiles-renderer) is cached on first use by the network-first rule below
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/terrain.js', 'js/net.js', 'js/live.js', 'js/geo.js', 'js/sites.js', 'js/google3d.js', 'js/search.js', 'js/shadows.js', 'js/atmosphere.js', 'js/forest.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/google-maps-logo.svg',
  'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js', 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.core.js', 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/controls/OrbitControls.js'];
const FONTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
// drop old shell versions only: the tile cache holds the offline packs and must survive app updates
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^midi3d-v\d+$/.test(k) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (FONTS.has(u.hostname)) { // fonts never change: cache first, so the app keeps its look offline
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; })));
    return;
  }
  if (u.origin !== location.origin && u.hostname !== 'cdn.jsdelivr.net') return;
  // network first so updates show up, cache as fallback when offline. 'no-cache' makes the browser revalidate
  // instead of reusing its HTTP cache (GitHub Pages allows 10 min), so a new version arrives on the next opening
  const fresh = u.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(fetch(fresh).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: u.origin === location.origin }).then(hit => hit || Response.error())));
});
