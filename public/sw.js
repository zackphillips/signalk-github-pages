// Service worker — offline fallback for the vessel tracker.
//
// Strategy:
//   Static shell assets → stale-while-revalidate, in a cache named for the
//     release, so a frontend published by a plugin upgrade actually arrives
//   Telemetry / vessel data → network-first, fall back to cache so the last
//     known state is shown when the device is offline
//   CDN resources → stale-while-revalidate
//
// The cache name carries SITE_VERSION, which the plugin substitutes with its
// own version on the way into the repository. This matters more than it looks
// like it should: the shell used to be cache-first in a cache called
// "mermug-shell-v4", a constant nobody bumped. A phone that had ever loaded
// the site kept serving that HTML and JS forever while the telemetry beside it
// went on updating — old code, new data, and a dashboard reading "Data
// unavailable" against a snapshot it had just downloaded successfully.

const SITE_VERSION  = '0.0.0-dev';
const SHELL_CACHE   = `tracker-shell-${SITE_VERSION}`;
const DATA_CACHE    = 'tracker-data-v1';

// The shell: everything that changes only with a release. Nothing under
// /data/ belongs here — info.yaml is rewritten whenever the boat's config
// changes, and a cached copy of it is a stale vessel name and stale privacy
// zones on every device that has visited before.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/docs.html',
  '/manifest.json',
  '/assets/styles.css',
  '/assets/utils.js',
  '/assets/constants.js',
  '/assets/tabs.js',
  '/assets/app.js',
  '/assets/docs.js',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Individually, so one 404 (a page this release dropped) cannot fail the
      // whole install and leave the device on the previous worker.
      Promise.all(SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => {}))),
    ),
  );
  self.skipWaiting();
});

// ── Activate: remove stale caches ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests and a small CDN allowlist.
  if (request.method !== 'GET') return;

  // CDN (Leaflet, Chart.js, js-yaml) — stale-while-revalidate
  if (url.hostname.endsWith('jsdelivr.net') || url.hostname.endsWith('unpkg.com')) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  // Only intercept same-origin requests from here on.
  if (url.origin !== self.location.origin) return;

  // Anything the plugin publishes as data — telemetry, the vessel config, the
  // polar table — is network-first with a cache fallback: current when there
  // is a signal, and the last known state when there is not.
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(networkFirstWithCache(request, DATA_CACHE));
    return;
  }

  // Ship's docs (Markdown + index) — network-first so an edit published from
  // the GitHub UI shows up immediately, but cached so the SOPs stay readable
  // offshore with no signal. docs.js pre-fetches every document to fill this.
  if (url.pathname.startsWith('/docs/')) {
    event.respondWith(networkFirstWithCache(request, DATA_CACHE));
    return;
  }

  // Shell assets — served from cache for speed, refreshed in the background.
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName });
    if (cached) return cached;
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Answer from cache at once, and replace that entry with whatever the network
 * says. The page in front of the user is one release behind at worst, and only
 * until the next load — where cache-first was one release behind forever.
 *
 * The cache lookup ignores the query string so `app.js?v=5` is answered by the
 * precached `app.js`, and the revalidated copy is stored under both.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cached =
    (await caches.match(request, { cacheName })) ??
    (await caches.match(request, { cacheName, ignoreSearch: true }));
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        caches.open(cacheName).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  return (await fetchPromise) ?? new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
}
