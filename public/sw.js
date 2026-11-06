// AHKE Stock service worker.
// Network-first for the app shell: online you always get the latest version;
// offline (stockroom, no signal) the last cached copy is served. Stock data
// itself lives in localStorage and syncs through /api, which is never cached.
const CACHE = 'ahke-stock-v2';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL).catch(() => {}))   // a signed-out install still succeeds
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/login')) return;   // always live

  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then(res => {
        // Only cache real pages: never a redirect to the login page or an error.
        if (res.ok && !res.redirected && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('./') : undefined)))
  );
});
