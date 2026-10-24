/* GettoWayz service worker.
   - App shell (same origin): network first, cache as the offline fallback.
   - Map libraries & fonts from CDNs (versioned URLs): cache first, so the app opens with no signal.
   - OpenFreeMap map data: network first; if the network fails (or takes > 4 s) and the tile is in a saved
     offline pack (cache "gw-offline-map-v1", filled by js/offline.js), the saved copy is used.
   Routing, search, Supabase and traffic are never cached. */
const CACHE = 'gw-shell-v26';
const LIBS = 'gw-libs-v1';
const MAPDATA = 'gw-offline-map-v1';
const KEEP = [CACHE, LIBS, MAPDATA];
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icons/icon.svg',
  './js/app.js', './js/config.js', './js/util.js', './js/map.js', './js/basemap.js', './js/state.js',
  './js/providers/routing.js', './js/providers/geocoding.js', './js/providers/nearby.js', './js/providers/overpass.js', './js/providers/places.js', './js/ui/explore.js', './js/providers/sampleData.js', './js/providers/realtime.js', './js/providers/streetlights.js', './js/providers/litStreets.js', './js/providers/traffic.js', './js/ui/traffic.js', './js/providers/communityRouting.js',
  './js/backend/index.js', './js/backend/localDemo.js', './js/backend/seed.js', './js/backend/rules.js', './js/backend/pointsPolicy.js', './js/backend/demoPoints.js', './js/backend/social.js', './js/backend/supabase.js',
  './js/ui/sheet.js', './js/ui/modal.js', './js/ui/alerts.js', './js/ui/paths.js', './js/ui/account.js', './js/ui/admin.js', './js/ui/friends.js', './js/ui/streetlights.js', './js/ui/points.js', './js/ui/tabs.js', './js/ui/avatar.js', './js/ui/activity.js', './js/ui/safety.js', './js/ui/tripCard.js', './js/backend/badges.js', './js/offline.js', './js/ui/offline.js', './js/prefs.js', './icons/logo-96.png', './icons/wordmark.jpg'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// Same rule as tileKey() in js/offline.js: drop OpenFreeMap's weekly data version from tile URLs.
const tileKey = (u) => u.replace(/^(https:\/\/tiles\.openfreemap\.org\/planet)\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '$1/_/$2');
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapData(req) {
  const cache = await caches.open(MAPDATA);
  const key = tileKey(req.url);
  const saved = await cache.match(key);
  const net = fetch(req).then((res) => {
    if (saved && res.ok) cache.put(key, res.clone()).catch(() => {}); // keep saved areas fresh while online
    return res;
  });
  if (!saved) return net;                       // not in a pack: plain network, as before
  return Promise.race([net.catch(() => saved), timeout(4000).then(() => saved)]);
}
async function lib(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.host === 'tiles.openfreemap.org') { e.respondWith(mapData(e.request)); return; }
  if (LIB_HOSTS.includes(url.host)) { e.respondWith(lib(e.request)); return; }
  if (url.origin !== self.location.origin) return; // APIs (routing, search, Supabase, traffic): network only
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) { // lamp / lit-street snapshots: network first, keep a copy
    e.respondWith(fetch(e.request).then((res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
    return;
  }
  // Network first (revalidated, so a normal refresh always gets the latest deploy); the cache is only the offline fallback.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok && SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
