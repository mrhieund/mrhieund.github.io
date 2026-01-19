const CACHE_NAME = 'chinese-srs-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './index.js',
  './manifest.json'
];

// 1. Install Event: Cache files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Opened cache');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// 2. Fetch Event: Serve from Cache, fall back to Network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cache if found, otherwise fetch from network
      return response || fetch(event.request);
    })
  );
});

// 3. Activate Event: Clean up old caches (if version changes)
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
