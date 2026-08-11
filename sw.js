/* 字谈 离线缓存 Service Worker（页面联网时优先取最新，离线时用缓存） */
const CACHE = 'zitan-v2';
const ASSETS = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  /* 页面：联网时走网络（保证改动立即生效），失败再回退缓存 */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (res) {
        const clone = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
        return res;
      }).catch(function () { return caches.match(e.request); })
    );
    return;
  }

  /* 其他资源：缓存优先 */
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        const clone = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
        return res;
      });
    })
  );
});
