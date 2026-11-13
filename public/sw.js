// 앱 설치용 최소 서비스 워커 (오프라인 캐시 없음, 실시간 채팅이라 항상 네트워크 사용)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const c = list.find((w) => w.url.includes('/admin'));
    return c ? c.focus() : self.clients.openWindow('/admin');
  }));
});
