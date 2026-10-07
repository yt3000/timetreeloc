/* Service Worker：只预缓存代码（HTML/CSS/JS/图标），让已安装的 PWA 完全离线可用。
   两条硬规则：
     1. 数据在 IndexedDB，与 SW 无关，绝不进 HTTP 缓存；
     2. 不自动 skipWaiting —— 正在录入时被刷新是体验灾难，改由界面提示用户点"重启"。 */
const CACHE = 'timetreeloc-v0.12';
const PRECACHE = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './src/domain.js', './src/db.js', './src/backup.js', './src/views.js', './src/main.js', './src/alarm.js',
  './src/gestures.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // 导航请求与静态资源：stale-while-revalidate（先给缓存，后台更新，离线也不白屏）
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => {
      if (res && res.ok) cache.put(e.request, res.clone());
      // 拿到新版本内容时通知页面，由界面提示用户手动重启
      if (hit && url.pathname.endsWith('.js')) notifyUpdate();
      return res;
    }).catch(() => null);
    return hit || (await net) || new Response('离线且该资源未缓存', { status: 503 });
  })());
});

async function notifyUpdate() {
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => c.postMessage({ type: 'update-available' }));
}
