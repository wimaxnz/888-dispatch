// Local stand-in for the live server, for trying the pages on this computer.
// Same engine, views and Shopify mapping; data lives in memory.
// Run: node test/mock-server.mjs  then open
//   http://localhost:8788/shop.html#t=localtest-talisay-000000&api=http://localhost:8788
//   http://localhost:8788/admin.html#api=http://localhost:8788   (any admin key)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../src/engine.js';
import { config } from '../src/config.js';
import { buildCatalog } from '../src/catalog.js';
import { fromShopify, PAYOUT } from '../src/shopify.js';
import { shopView, adminView } from '../src/views.js';

const catalog = buildCatalog();
const V = (t) => [...catalog.byVariant.values()].find((v) => v.title === t).variantId;
const cfg = structuredClone(config);
const d = new Dispatcher({ packages: [...catalog.packs.values()], config: cfg, shops: [
  { id: 'hub', name: '888 Hub', city: 'Manila', island: 'Luzon', lat: 14.5995, lng: 120.9842, hub: true, stock: {} },
  { id: 'talisay', name: 'Talisay Family Store', city: 'Talisay City', island: 'Cebu', lat: 10.2447, lng: 123.8494, stock: {} },
] });
const extra = { manual: [], payments: [], payout: { ...PAYOUT } };
const TOKENS = { 'localtest-talisay-000000': 'talisay' };
const order = (n, lines, city = 'Talisay City') => {
  const r = fromShopify({ id: n, name: `#${n}`, note: n === 1001 ? 'Happy birthday Nanay!' : '', shipping_address: { name: 'Rosa Dela Cruz', phone: '0917 555 0142', address1: 'Purok 3', address2: 'Brgy. Lawaan II', city, province: 'Cebu', country_code: 'PH' },
    billing_address: { country: 'New Zealand' }, line_items: lines.map(([t, q]) => ({ variant_id: Number(V(t)), title: t, quantity: q, price: String(catalog.byVariant.get(V(t)).price) })) }, catalog, extra.payout);
  d.packages.set(r.package.id, r.package); d.placeOrder({ ...r.order, paidAt: Date.now() });
};
// Talisay has everything for order 1001 except the Nescafé; full stock for 1002.
const shop = d.shops.get('talisay');
for (const i of catalog.stockItems) shop.stock[i.sku] = 6;
shop.stock[[...catalog.packs.values()][0].items.find((i) => i.name.includes('Nescaf')).sku] = 0;
order(1001, [['Tipid Starter Pack', 1]]);
order(1002, [['Spam Luncheon Meat Classic 340g', 2], ['Ulam Essentials', 1]]);
extra.manual.push({ id: 'M-1003', ref: '1003', reason: 'Address is outside the Philippines', recipient: { name: 'Jun Santos', city: 'Auckland' }, items: [{ qty: 1, title: 'Tipid Starter Pack' }], status: 'todo' });

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-admin-key' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if (req.method === 'GET' && /\.(html|css|png)$/.test(url.pathname)) {
    const f = url.pathname.slice(1); const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
    try { const data = readFileSync(new URL(`../${f.endsWith('.png') ? 'shop-logo.png' : 'web/' + f}`, import.meta.url)); res.writeHead(200, { 'content-type': type }); return res.end(data); } catch { return send(res, 404, { error: 'nf' }); }
  }
  let body = {}; if (req.method === 'POST') { let s = ''; for await (const c of req) s += c; body = JSON.parse(s || '{}'); }
  const now = Date.now(); d.tick(now);
  if (url.pathname === '/shop') {
    const id = TOKENS[body.t ?? url.searchParams.get('t')];
    if (!id) return send(res, 403, { error: 'This shop link is not valid. Ask 888 for a new one.' });
    if (req.method === 'GET') return send(res, 200, shopView(d, id, catalog, now));
    const s = d.shops.get(id); let r = { ok: true };
    switch (body.act) {
      case 'accept': r = d.accept(body.offerId, now, { commitToSource: !!body.commit }); break;
      case 'decline': r = d.decline(body.offerId, now, body.reason); break;
      case 'sourced': r = d.confirmSourced(body.orderId, id, now); break;
      case 'cantsource': r = d.cantSource(body.orderId, id, now); break;
      case 'ship': r = d.ship(body.orderId, id, body.tracking, now); break;
      case 'delivered': r = d.deliver(body.orderId, now); break;
      case 'stock': s.stock[body.sku] = Math.max(Number(body.qty) || 0, s.reserved[body.sku] ?? 0); break;
      case 'online': s.active = !!body.active; break;
    }
    return send(res, 200, { result: r, view: shopView(d, id, catalog, now) });
  }
  if (url.pathname === '/admin') {
    if (!req.headers['x-admin-key']) return send(res, 403, { error: 'Wrong admin key' });
    if (req.method === 'GET') return url.searchParams.get('events')
      ? send(res, 200, { events: d.events.filter((e) => e.order === url.searchParams.get('events')).map((e) => ({ at: new Date(e.at).toISOString(), type: e.type, data: e })) })
      : send(res, 200, adminView(d, extra, now));
    let r = { ok: true }; const s = d.shops.get(body.shopId), o = d.orders.get(body.orderId);
    switch (body.act) {
      case 'addShop': { const id = 'shop-' + Math.random().toString(36).slice(2, 8); d.shops.set(id, { id, name: body.name, city: body.city, island: 'Cebu', lat: 10.31, lng: 123.89, stock: {}, reserved: {}, active: true, strikes: 0 }); const tok = 'localtest-' + id + '-0000000000'; TOKENS[tok] = id; r = { ok: true, shopId: id, link: tok }; break; }
      case 'newLink': { const tok = 'localtest-' + body.shopId + '-1111111111'; TOKENS[tok] = body.shopId; r = { ok: true, link: tok }; break; }
      case 'pauseShop': s.active = false; break;
      case 'reinstate': s.active = true; s.strikes = 0; break;
      case 'clearStrikes': s.strikes = 0; break;
      case 'tohub': if (o.status === 'assigned') d.release(o); d.toHub(o, now, 'sent by admin', true); break;
      case 'hubship': r = d.ship(o.id, 'hub', 'HUB', now); break;
      case 'deliver': r = d.deliver(o.id, now); break;
      case 'pay': { const l = [...d.orders.values()].filter((x) => x.payout?.shop === body.shopId && x.payout.status === 'payable'); const amount = l.reduce((t, x) => t + x.payout.amount, 0); l.forEach((x) => { x.payout.status = 'paid'; }); extra.payments.push({ at: now, shop: body.shopId, orders: l.length, amount }); r = { ok: true, amount }; break; }
      case 'manualDone': extra.manual = extra.manual.map((m) => m.id === body.id ? { ...m, status: 'done' } : m); break;
      case 'rule': { const k = body.path.split('.'), last = k.pop(); k.reduce((x, y) => x[y], d.cfg)[last] = Number(body.value); break; }
      case 'payoutRule': extra.payout = { share: body.share, packingFee: body.packingFee }; break;
    }
    return send(res, 200, { result: r, view: adminView(d, extra, now) });
  }
  if (url.pathname === '/demo-order') { order(2000 + Math.floor(Math.random() * 999), [['Ulam Essentials', 1]]); return send(res, 200, { ok: true }); }
  send(res, 404, { error: 'Not found' });
}).listen(8788, () => console.log('mock on http://localhost:8788'));
