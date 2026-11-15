// Tick: funciona offline e recebe notificações
const C = 'tick-v9';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-32.png'];
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => Promise.all([...SHELL, XLSX_URL].map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C && k !== 'tick-k').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.pathname.startsWith('/api/')) return; // servidor: sempre pela rede
  if (u.origin === location.origin) {
    // app: busca a versão nova quando há internet; sem internet usa a guardada
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(req, cp)); return res; })));
  }
});

async function chave() { try { const c = await caches.open('tick-k'); const r = await c.match('./__k'); return r ? await r.json() : null; } catch (e) { return null; } }
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msg = null;
    try { msg = e.data ? e.data.json() : null; } catch (err) { msg = e.data ? { title: 'Tick', body: e.data.text() } : null; }
    if (!msg || !msg.title) { // aviso sem conteúdo (aparelhos antigos): busca o texto no servidor
      msg = { title: 'Tick', body: 'Hora de bater o ponto' };
      const k = await chave();
      if (k && k.api) { try { const r = await fetch(k.api + '/tick/notif', { headers: { 'X-Key': k.k } }); if (r.ok) { const m = await r.json(); if (m && m.title) msg = m; } } catch (err) {} }
    }
    await self.registration.showNotification(msg.title, { body: msg.body || '', icon: 'icons/icon-192.png', badge: 'icons/favicon-32.png', tag: msg.tag || 'tick', renotify: true, data: { url: './' } });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => { for (const c of cs) { if ('focus' in c) return c.focus(); } return self.clients.openWindow('./'); }));
});
