/* Ghetto Wayz service worker — caches the app shell for offline launch.
   Map tiles, routing and search are network-only (never cached as "live"). */
const CACHE = 'gw-shell-v8';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icons/icon.svg',
  './js/app.js', './js/config.js', './js/util.js', './js/map.js', './js/state.js',
  './js/providers/routing.js', './js/providers/geocoding.js', './js/providers/sampleData.js', './js/providers/realtime.js', './js/providers/streetlights.js', './js/providers/communityRouting.js',
  './js/backend/index.js', './js/backend/localDemo.js', './js/backend/seed.js', './js/backend/rules.js', './js/backend/social.js', './js/backend/supabase.js',
  './js/ui/sheet.js', './js/ui/modal.js', './js/ui/alerts.js', './js/ui/paths.js', './js/ui/account.js', './js/ui/admin.js', './js/ui/friends.js', './js/ui/streetlights.js', './icons/logo-96.png', './icons/wordmark.jpg'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return; // network for tiles/APIs/CDNs
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
