const CACHE = 'scan-sheet-v2';
const ASSETS = [
  './',                // important pour GitHub Pages
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './assets/logo-pelichet.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Pré-cache tolérant aux 404
      for (const url of ASSETS) {
        try { await cache.add(new Request(url, { cache: 'reload' })); }
        catch (err) { console.warn('[SW] skip cache', url, err); }
      }
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Stratégie cache-first pour les assets locaux
  if (req.method === 'GET' && new URL(req.url).origin === location.origin) {
    e.respondWith(
      caches.match(req).then(res => res || fetch(req))
    );
  }
});
