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

// The app's own files are checked with the server on every load (a quick
// "not modified" when nothing changed) rather than reused from the browser's
// own cache, which GitHub Pages allows for up to 10 minutes. Otherwise, right
// after a deploy, a new index.html could run with an older sync.js. A page
// load (navigation) can't be re-sent with options, so it's fetched by its URL;
// "manual" hands any redirect back to the browser to follow.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method === 'GET' && new URL(req.url).origin === self.location.origin){
    event.respondWith(req.mode === 'navigate'
      ? fetch(req.url, { cache: 'no-cache', redirect: 'manual', credentials: 'same-origin' })
      : fetch(req, { cache: 'no-cache' }));
    return;
  }
  event.respondWith(fetch(req));
});
