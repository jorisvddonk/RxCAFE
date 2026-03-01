const CACHE_NAME = 'rxcafe-v41';
const STATIC_ASSETS = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/js/theme.js',
  '/js/api.js',
  '/js/dom-utils.js',
  '/js/streaming.js',
  '/js/recording.js',
  '/js/messages.js',
  '/js/sessions.js',
  '/js/ui.js',
  '/widgets/styles.css',
  '/widgets/afe-select.js',
  '/widgets/afe-radio.js',
  '/widgets/afe-text.js',
  '/widgets/afe-number.js',
  '/widgets/afe-checkbox.js',
  '/widgets/afe-fieldset.js',
  '/widgets/afe-wizard.js',
  '/widgets/rx-message-text.js',
  '/widgets/rx-message-image.js',
  '/widgets/rx-message-audio.js',
  '/widgets/rx-message-web.js',
  '/widgets/rx-message-tool.js',
  '/widgets/rx-message-system.js',
  '/widgets/rx-message-visualization.js'
];

function fetchWithTimeout(request, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  return fetch(request, { signal: controller.signal })
    .finally(() => clearTimeout(id));
}

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

  // API and chat endpoints always go to network (no caching)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/chat/')) {
    event.respondWith(
      fetchWithTimeout(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Network error' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
  
  // Static assets: cache first, then network
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          return caches.open(CACHE_NAME).then((cache) => {
            return cache.put(event.request, responseClone).then(() => response);
          });
        }
        return response;
      });
    })
  );
});
