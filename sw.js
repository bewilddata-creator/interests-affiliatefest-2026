/* Caches the app so it opens with no signal. Bump CACHE when files change. */
var CACHE = 'booth-leads-v2';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Same-origin GETs: answer from cache straight away, refresh the cache in the background.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  var key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
