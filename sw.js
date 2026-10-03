// Offline support: always try the network first so updates show up right
// away, and fall back to the last copy when offline.

const CACHE = 'photoworks-web-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/main.js', 'js/settings.js', 'js/presets.js', 'js/pipeline.js', 'js/resize.js', 'js/effects.js',
  'js/dpi.js', 'js/exif.js', 'js/overlay.js', 'js/filename.js', 'js/exporter.js', 'js/pool.js',
  'js/worker.js', 'js/fonts.js',
  'img/icon.svg', 'img/icon-32.png', 'img/icon-180.png', 'img/icon-192.png', 'img/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});
