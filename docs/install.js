// "Add to home screen" for the 888 pages.
// Usage: <script src="install.js" data-name="888 Orders" data-icon="icons/orders"></script>
// The manifest is built here so the installed app opens the exact link it was added from
// (the shop link carries its private token after the #).
(() => {
  const me = document.currentScript;
  const name = me?.dataset.name || '888 Grocery';
  const iconBase = new URL((me?.dataset.icon || 'icons/orders') + '-', me?.src || location.href).href;
  const swUrl = me?.dataset.sw ? new URL(me.dataset.sw, me.src).href : new URL('sw.js', me?.src || location.href).href;
  const brown = '#4a2e1c', cream = '#f8f3e8';

  const head = document.head;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs); head.appendChild(el); return el; };
  const manifest = {
    name, short_name: name, start_url: location.href, scope: new URL('./', location.href).href,
    display: 'standalone', orientation: 'portrait', background_color: cream, theme_color: brown,
    icons: [192, 512].map((s) => ({ src: `${iconBase}${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })),
  };
  add('link', { rel: 'manifest', href: URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' })) });
  add('link', { rel: 'apple-touch-icon', href: `${iconBase}180.png` });
  for (const [n, c] of [['theme-color', brown], ['apple-mobile-web-app-capable', 'yes'], ['mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-title', name], ['apple-mobile-web-app-status-bar-style', 'black-translucent']]) add('meta', { name: n, content: c });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register(swUrl).catch(() => {});

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferred = null;

  const css = `.a2hs{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:9999;display:flex;align-items:center;gap:8px;
    background:${brown};color:#fff;border:0;border-radius:999px;padding:11px 16px;font:600 15px/1.1 Inter,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer}
  .a2hs img{width:22px;height:22px;border-radius:5px}
  .a2hs-x{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}
  .a2hs-sheet{background:#fff;color:#2b1a10;width:min(520px,100%);border-radius:18px 18px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));font:15px/1.45 Inter,system-ui,sans-serif}
  .a2hs-sheet h3{margin:0 0 10px;font:700 18px/1.2 Archivo,Inter,sans-serif}
  .a2hs-sheet ol{margin:0 0 14px;padding-left:22px}.a2hs-sheet li{margin:6px 0}
  .a2hs-sheet button{width:100%;padding:12px;border:0;border-radius:12px;background:${brown};color:#fff;font:600 15px Inter,system-ui,sans-serif}`;
  const style = document.createElement('style'); style.textContent = css; head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'a2hs'; btn.type = 'button';
  btn.innerHTML = `<img src="${iconBase}192.png" alt="">Add to home screen`;

  const sheet = (steps) => {
    const x = document.createElement('div'); x.className = 'a2hs-x';
    x.innerHTML = `<div class="a2hs-sheet" role="dialog" aria-label="Add to home screen"><h3>Add ${name} to your home screen</h3><ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol><button type="button">OK</button></div>`;
    x.addEventListener('click', (e) => { if (e.target === x || e.target.tagName === 'BUTTON') x.remove(); });
    document.body.appendChild(x);
  };

  btn.addEventListener('click', async () => {
    if (deferred) { deferred.prompt(); const r = await deferred.userChoice.catch(() => null); if (r?.outcome === 'accepted') btn.remove(); deferred = null; return; }
    if (ios) return sheet(['Open this page in <b>Safari</b>.', 'Tap the <b>Share</b> button (square with an arrow).', 'Scroll down and tap <b>Add to Home Screen</b>.', `Tap <b>Add</b>. The ${name} icon appears on your home screen.`]);
    sheet(['Open the browser menu (<b>⋮</b> at the top right in Chrome).', 'Tap <b>Add to Home screen</b> or <b>Install app</b>.', `Tap <b>Install</b> or <b>Add</b>. The ${name} icon appears on your home screen.`]);
  });

  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
  addEventListener('appinstalled', () => btn.remove());
  const show = () => document.body.appendChild(btn);
  if (document.body) show(); else addEventListener('DOMContentLoaded', show);
})();
