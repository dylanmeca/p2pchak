const CACHE_NAME = 'p2pchak-cache-v1';
const OFFLINE_URL = '/offline.html';

// Lista de recursos a cachear en la instalación
const ASSETS = [
  '/',
  '/index.html',
  '/estilos.css',
  '/chat.js',
  '/favicon.png',
  '/favicon.ico',
  '/manifest.json',
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install: cachear los assets esenciales
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: eliminar caches antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); })
    ))
  );
  self.clients.claim();
});

// Fetch: estrategia:
// - navigation (document) -> network-first, fallback a cache -> offline
// - otros requests (css/js/images) -> cache-first, fallback a network
self.addEventListener('fetch', event => {
  const req = event.request;

  // Ignorar requests de terceros (schemes distintos)
  if (!req.url.startsWith(self.location.origin)) {
    return;
  }

  // Navegación (p. ej. abrir / o rutas)
  if (req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept') && req.headers.get('accept').includes('text/html'))) {
    event.respondWith(
      fetch(req).then(networkResponse => {
        // put into cache for future
        caches.open(CACHE_NAME).then(cache => cache.put(req, networkResponse.clone()));
        return networkResponse;
      }).catch(() => {
        // fallback to cache or offline page
        return caches.match(req).then(cached => cached || caches.match(OFFLINE_URL));
      })
    );
    return;
  }

  // Para assets estáticos: cache-first
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(networkResponse => {
        // cachear recursos de la misma procedencia
        if (req.method === 'GET' && req.url.startsWith(self.location.origin)) {
          caches.open(CACHE_NAME).then(cache => {
            try { cache.put(req, networkResponse.clone()); } catch (e) { /* ignore */ }
          });
        }
        return networkResponse;
      }).catch(() => {
        // nada en cache y fallo en red -> si es petición de imagen, se podría devolver un placeholder opcional
        return caches.match('/favicon.png');
      });
    })
  );
});
