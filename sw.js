// Cofre dos Sonhos: recebe as notificações push e abre o app ao tocar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { titulo: 'Cofre dos Sonhos', texto: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Cofre dos Sonhos', {
    body: d.texto || '',
    icon: 'icone-192.png',
    badge: 'icone-badge.png',
    tag: d.tag || 'cofre',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const alvo = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const a of abas) { if (a.url.startsWith(self.registration.scope)) { await a.focus(); return; } }
    await self.clients.openWindow(alvo);
  })());
});
