// App shell offline cache. Map tiles are cached by the app itself (Cache Storage 'midi3d-tiles-*', see js/net.js);
// weather and satellite answers are kept by the app itself (localStorage) to be shown, dated, when offline.
const CACHE = 'midi3d-v54';
// the Google 3D module (3d-tiles-renderer) is cached on first use by the network-first rule below
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/terrain.js', 'js/net.js', 'js/live.js', 'js/geo.js', 'js/sites.js', 'js/google3d.js', 'js/search.js', 'js/shadows.js', 'js/atmosphere.js', 'js/forest.js', 'js/water.js', 'js/buildings.js', 'js/bera.js', 'js/gps.js', 'js/route.js', 'js/trails.js', 'js/weather3d.js', 'js/sight.js', 'js/photos360.js', 'js/controls.js', 'js/planner.js', 'js/hikes.js', 'js/lidar.js', 'js/post.js', 'js/clouds.js', 'js/glaciers.js', 'js/lights.js', 'js/c2c.js', 'js/foresttypes.js', 'js/track.js', 'js/refuges.js', 'js/streams.js', 'js/pistes.js', 'js/custom.js', 'js/share.js', 'js/routebook.js', 'js/sky.js', 'js/liftplan.js', 'js/guide.js', 'js/planned.js', 'js/mydata.js', 'js/nearby.js', 'js/loops.js', 'data/sky.json', 'data/nivo.json', 'data/webcams-midi.json', 'data/webcams-buet.json', 'data/webcams-sassiere.json', 'data/hikes-ecrins.json', 'data/c2c-ecrins.json', 'data/pistes-ecrins.json', 'data/webcams-ecrins.json', 'data/hikes-vanoise.json', 'data/c2c-vanoise.json', 'data/pistes-vanoise.json', 'data/webcams-vanoise.json', 'data/hikes-belledonne.json', 'data/c2c-belledonne.json', 'data/pistes-belledonne.json', 'data/webcams-belledonne.json', 'data/c2c-midi.json', 'data/c2c-buet.json', 'data/c2c-sassiere.json', 'js/lidar-worker.js', 'data/hikes-midi.json', 'data/hikes-sassiere.json', 'data/hikes-buet.json', 'data/pistes-midi.json', 'data/pistes-buet.json', 'data/pistes-sassiere.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/google-maps-logo.svg',
  'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js', 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.core.js',
  // LiDAR decoder (loaded by lidar-worker.js)
  'https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/worker/laz-perf.js', 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/worker/laz-perf.wasm'];
const FONTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
// each file on its own: with addAll, one file failing (a CDN hiccup) lost the whole offline shell; a file missed
// here is still kept the first time the app asks for it (network-first rule below)
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => { })))).then(() => self.skipWaiting())); });
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
