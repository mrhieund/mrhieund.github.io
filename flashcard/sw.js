const CACHE_NAME = 'chinese-srs-v3';

// Core Application Assets
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './index.js',
  './manifest.json'
];

// Local HSK JSON files (levels 1 to 6)
const HSK_LOCAL_ASSETS = [
  './1.min.json',
  './2.min.json',
  './3.min.json',
  './4.min.json',
  './5.min.json',
  './6.min.json'
];

// Remote HSK JSON CDN URLs (fallback/mirror)
const HSK_CDN_ASSETS = [
  'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/old/1.min.json',
  'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/old/2.min.json',
  'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/old/3.min.json',
  'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/old/4.min.json',
  'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/old/5.min.json',
  'https://cdn.jsdelivr.net/gh/drkameleon/complete-hsk-vocabulary@main/wordlists/exclusive/old/6.min.json'
];

// All initial assets to cache
const ASSETS_TO_CACHE = [
  ...CORE_ASSETS,
  ...HSK_LOCAL_ASSETS
];

// 1. Install Event: Pre-cache core files and HSK files safely
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] Pre-caching core application assets');
      await cache.addAll(CORE_ASSETS);

      // Pre-cache local HSK files (Promise.allSettled so missing optional files don't fail SW install)
      await Promise.allSettled(
        HSK_LOCAL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.log(`[SW] Local ${url} not found yet; will be cached on remote fetch.`);
          })
        )
      );

      // Also pre-cache remote CDN HSK files in the background if online
      await Promise.allSettled(
        HSK_CDN_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.log(`[SW] Could not pre-cache remote ${url}:`, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// 2. Fetch Event: Cache-first strategy with dynamic runtime caching for HSK JSONs
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then((networkResponse) => {
          // Dynamically cache any HSK JSON files or .min.json files when fetched
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (
              event.request.url.includes('.min.json') ||
              event.request.url.includes('hsk') ||
              event.request.destination === 'document' ||
              event.request.destination === 'script' ||
              event.request.destination === 'style'
            )
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // If offline and request is an HSK level, check if we have another cached mirror
          if (event.request.url.includes('.min.json')) {
            const match = event.request.url.match(/([1-6])\.min\.json/);
            if (match) {
              const lvl = match[1];
              return caches.match(`./${lvl}.min.json`);
            }
          }
        });
    })
  );
});

// 3. Activate Event: Clean up old caches and take immediate control
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
