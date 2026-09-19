// Service worker — offline fallback for S.V. Mermug vessel tracker.
//
// Strategy:
//   Static shell assets → cache-first (versioned cache; update on new deploy)
//   Telemetry / data JSON → network-first, fall back to cache so the last
//     known state is shown when the device is offline
//   CDN resources → stale-while-revalidate

const SHELL_CACHE   = 'mermug-shell-v4';
const DATA_CACHE    = 'mermug-data-v1';

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
  '/data/vessel/info.yaml',
  '/data/vessel/logo.png',
  '/data/tide_stations.json',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
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

  // Telemetry / data JSON — network-first with data-cache fallback
  if (url.pathname.startsWith('/data/telemetry/')) {
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

  // Shell assets — cache-first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request, { cacheName });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

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

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      caches.open(cacheName).then((cache) => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => null);
  return cached ?? (await fetchPromise) ?? new Response('Offline', { status: 503 });
}
