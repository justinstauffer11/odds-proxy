// sw.js — EDGE service worker
//
// Caching strategy:
//   * App shell (HTML + fonts) — cache-first with network fallback
//   * API calls (odds, stats) — network-first with cache fallback (so you
//     get fresh data when online, and at least see something when offline)
//   * Everything else — pass through to network
//
// Bump CACHE_VERSION whenever you ship a meaningful HTML or asset change so
// users get the new version after closing/reopening the app once.

const CACHE_VERSION = 'edge-v13';

const SHELL_ASSETS = [
  '/',
  '/v37.html',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // Don't fail install if any single asset fails to cache
      return Promise.all(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err => console.log('SW cache miss for', url))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  // Clean up old caches
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_VERSION).map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip Chrome extension and dev tools requests
  if (url.protocol === 'chrome-extension:') return;

  // API calls (proxy endpoints) — network-first, cache fallback
  const isAPI = url.pathname.startsWith('/api/');
  if (isAPI) {
    event.respondWith(
      fetch(req).then(res => {
        // Only cache successful responses
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin navigations and shell assets — cache-first, network refresh
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        const fetchPromise = fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Cross-origin (Google Fonts etc.) — cache-first
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(req).then(cached =>
        cached || fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, clone));
          }
          return res;
        })
      )
    );
    return;
  }

  // Anything else — pass through
});
