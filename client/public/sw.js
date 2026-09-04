/* global self, caches, URL, Response, fetch */

// Bump this value for every web release that changes the Vite output. Keeping
// release caches separate prevents an older service worker from satisfying a
// new entry module with a stale hashed chunk after a deploy.
const CACHE_NAME = 'leaguevault-v4';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Third-party SDKs own their loading, caching, and failure behavior. In
  // particular, proxying Square through this worker can replace its script or
  // stylesheet with an app fallback response and corrupt provider startup.
  if (url.origin !== self.location.origin) return;

  const isJavaScriptRequest = event.request.destination === 'script'
    || (url.pathname.startsWith('/assets/') && /\.m?js$/i.test(url.pathname));

  const isJavaScriptResponse = (response) => {
    if (!response || !response.ok) return false;
    const contentType = response.headers.get('content-type') || '';
    // Only an explicit JavaScript MIME is safe to cache or return for a module
    // request. This prevents an HTML SPA fallback (including one with a bad or
    // missing content-type) from ever being substituted for a script.
    return /(?:java|ecma)script|module/i.test(contentType);
  };

  const unavailableJavaScriptResponse = () => new Response(
    'JavaScript asset unavailable. Please refresh the page.',
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    },
  );

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ success: false, error: { message: 'You are offline' } }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  if (isJavaScriptRequest) {
    event.respondWith(
      fetch(event.request).then((response) => {
        // Never cache or return an SPA index for a missing module. A 200 HTML
        // response is converted to a non-empty 503 so the browser rejects the
        // import and the release-scoped refresh guard can run.
        if (!isJavaScriptResponse(response)) {
          const contentType = response.headers.get('content-type') || '';
          if (response.status === 404 && !/^text\/html/i.test(contentType)) {
            return response;
          }
          return unavailableJavaScriptResponse();
        }
        const clone = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        return caches.match(event.request).then((cached) => {
          return isJavaScriptResponse(cached) ? cached : unavailableJavaScriptResponse();
        });
      })
    );
    return;
  }

  if (event.request.destination === 'image' ||
      event.request.destination === 'font' ||
      event.request.destination === 'style') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match('/');
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then((response) => {
      return response;
    }).catch(() => {
      return caches.match(event.request).then((cached) => {
        return cached || caches.match('/');
      });
    })
  );
});
