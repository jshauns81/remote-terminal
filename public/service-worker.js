// Installability only, deliberately not a cache layer: server/index.js already
// sends "cache-control: no-store" on every response so frontend iterations
// (style.css/nexus.js change often) are never stale. Caching here would fight
// that. This SW exists purely so Chrome/Android will consider nexus
// installable (fetch handler present) and so a future offline-shell use case
// has a place to grow into -- for now every request just passes straight to
// the network, matching current no-store behavior exactly.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
