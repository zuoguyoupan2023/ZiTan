/* 字谈 离线缓存 Service Worker（页面联网时优先取最新，离线时用缓存） */
const CACHE = 'zitan-v3'; /* v3：新增 about.html 预缓存 */
/* 激活清理时的保留白名单：
 *   zitan-asr —— 旧版模型 Cache API 缓存。若设备上还留有旧方案写入的缓存，绝不能删，
 *                删了就得重新下载 228MB 模型。
 * 注：模型现已迁 IndexedDB（库 zitan-asr，分片存储），SW 激活清理不到 IDB；
 *     白名单保留仅为兼容旧缓存设备 + 防御将来恢复 SW。 */
const KEEP = [CACHE, 'zitan-asr'];
const ASSETS = [
  './index.html',
  './about.html',
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
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return KEEP.indexOf(k) === -1; }).map(function (k) { return caches.delete(k); })); })
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
