// LiturgyForge service worker.
// Intentionally does NOT cache anything — every request just passes through
// to the network. This is here only to satisfy PWA "installability" checks
// (Chrome's install icon in the address bar) without risking the site
// showing a stale cached version after a deploy.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
