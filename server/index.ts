// 888 dispatch server (Supabase Edge Function "api"). Deployed with imports pinned to a commit of this repo.
//   POST /api/shopify          Shopify "order payment" webhook (signed)
//   POST /api/tick             every minute from pg_cron (x-cron-key)
//   GET/POST /api/shop         partner shop screen (secret link token)
//   GET/POST /api/admin        owner screen (x-admin-key)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { Dispatcher } from './engine.js';
import { config as DEFAULT_CONFIG } from './config.js';
import { snapshot, restore, prune } from './store.js';
import { fromShopify, verifyShopify, PAYOUT } from './shopify.js';
import { buildCatalog } from './catalog.js';
import { locate } from './places.js';
import { shopView, adminView } from './views.js';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const catalog = buildCatalog();
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

async function secret(name: string): Promise<string | null> {
  const { data } = await db.from('app_secrets').select('value').eq('name', name).maybeSingle();
  return data?.value ?? null;
}
const same = (a: string | null, b: string | null) => {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0;
};
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const newToken = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');

function freshState() {
  const d = new Dispatcher({
    packages: [...catalog.packs.values()], config: structuredClone(DEFAULT_CONFIG),
    shops: [{ id: 'hub', name: '888 Hub', city: 'Manila', island: 'Luzon', lat: 14.5995, lng: 120.9842, hub: true, stock: {} }],
  });
  return snapshot(d, { manual: [], payments: [], seenShopify: [], payout: { ...PAYOUT } });
}

type Ctx = { d: any; extra: any; now: number };
// Load, change, save — with a version check so two requests never overwrite
// each other (that is what makes "first shop to accept wins" safe).
async function withState<T>(fn: (c: Ctx) => T | Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: row } = await db.from('dispatch_state').select('version, state').eq('id', 1).maybeSingle();
    if (!row) {
      await db.from('dispatch_state').insert({ id: 1, version: 0, state: freshState() });
      continue;
    }
    const { cfg, seq, packages, shops, orders, offers, events, v, ...extra } = row.state;
    const d = restore(row.state);
    const now = Date.now();
    const before = d.events.length;
    const result = await fn({ d, extra, now });
    const fresh = d.events.slice(before);
    prune(d, now);
    const { data: saved, error } = await db.from('dispatch_state')
      .update({ version: row.version + 1, state: snapshot(d, extra), updated_at: new Date().toISOString() })
      .eq('id', 1).eq('version', row.version).select('version');
    if (error) throw error;
    if (!saved?.length) continue; // someone else saved first: run again on their version
    if (fresh.length) {
      await db.from('event_log').insert(fresh.map((e: any) => ({
        at: new Date(e.at).toISOString(), type: e.type, order_id: e.order ?? null, shop_id: e.shop ?? null, data: e,
      })));
    }
    return result;
  }
  throw new Error('Busy, please try again');
}

async function readState() {
  const { data } = await db.from('dispatch_state').select('state').eq('id', 1).maybeSingle();
  if (!data) { await withState(() => null); return readState(); }
  const { cfg, seq, packages, shops, orders, offers, events, v, ...extra } = data.state;
  return { d: restore(data.state), extra, now: Date.now() };
}

// ---------- Shopify ----------
async function onShopify(req: Request) {
  const raw = await req.text();
  const ok = await verifyShopify(raw, req.headers.get('x-shopify-hmac-sha256'), await secret('shopify_webhook_secret'));
  if (!ok) return json({ error: 'bad signature' }, 401);
  const o = JSON.parse(raw);
  const { error: dupe } = await db.from('shopify_orders').insert({ shopify_id: o.id, name: o.name, payload: o });
  if (dupe) return json({ ok: true, duplicate: true }); // Shopify retries: already have it
  const result = await withState(({ d, extra }) => {
    const r: any = fromShopify(o, catalog, extra.payout ?? PAYOUT);
    if (r.manual) { extra.manual = [...(extra.manual ?? []), r.manual]; return { manual: r.manual.reason }; }
    if (r.skip) return { skipped: r.skip };
    if (d.orders.has(r.order.id)) return { exists: r.order.id };
    d.packages.set(r.package.id, r.package);
    d.placeOrder(r.order);
    return { dispatched: r.order.id };
  });
  await db.from('shopify_orders').update({ result }).eq('shopify_id', o.id);
  return json({ ok: true, ...result });
}

// ---------- Shops ----------
async function shopIdFor(token: string | null) {
  if (!token || token.length < 20) return null;
  const { data } = await db.from('shop_links').select('shop_id').eq('token_hash', await sha256(token)).maybeSingle();
  return data?.shop_id ?? null;
}

async function onShop(req: Request, url: URL) {
  const body = req.method === 'POST' ? await req.json() : {};
  const shopId = await shopIdFor(body.t ?? url.searchParams.get('t'));
  if (!shopId) return json({ error: 'This shop link is not valid. Ask 888 for a new one.' }, 403);
  if (req.method === 'GET') { const { d, now } = await readState(); if (!d.shops.has(shopId)) return json({ error: 'Shop removed' }, 404); return json(shopView(d, shopId, catalog, now)); }
  const out = await withState(({ d, now }) => {
    const shop = d.shops.get(shopId); if (!shop) return { result: { ok: false, reason: 'Shop removed' } };
    const mineOffer = (id: string) => { const of = d.offers.find((o: any) => o.id === id); return of && of.shopId === shopId ? of : null; };
    let r: any = { ok: true };
    switch (body.act) {
      case 'accept': r = mineOffer(body.offerId) ? d.accept(body.offerId, now, { commitToSource: !!body.commit }) : { ok: false, reason: 'Not your offer' }; break;
      case 'decline': r = mineOffer(body.offerId) ? d.decline(body.offerId, now, body.reason === 'shortage' ? 'shortage' : 'busy') : { ok: false }; break;
      case 'sourced': r = d.confirmSourced(body.orderId, shopId, now); break;
      case 'cantsource': r = d.cantSource(body.orderId, shopId, now); break;
      case 'ship': r = d.ship(body.orderId, shopId, String(body.tracking ?? '').slice(0, 60), now);
        if (r.ok && body.courier) d.orders.get(body.orderId).courier = String(body.courier).slice(0, 30); break;
      case 'delivered': { const o = d.orders.get(body.orderId); r = o && o.shopId === shopId ? d.deliver(body.orderId, now) : { ok: false }; break; }
      case 'stock': { const q = Math.max(0, Math.floor(Number(body.qty) || 0)); shop.stock[body.sku] = Math.max(q, shop.reserved[body.sku] ?? 0); r = { ok: true, qty: shop.stock[body.sku] }; break; }
      case 'online': shop.active = !!body.active && shop.strikes < d.cfg.strikesToSuspend; r = { ok: true, active: shop.active }; break;
      default: r = { ok: false, reason: 'Unknown action' };
    }
    return { result: r, view: shopView(d, shopId, catalog, now) };
  });
  return json(out);
}

// ---------- Admin ----------
const RULE_PATHS = ['rings.localKm', 'rings.nearbyKm', 'waveSize', 'offerMinutes', 'hubAfterHours', 'shipWithinHours', 'strikesToSuspend',
  'partial.maxMissingItems', 'partial.maxMissingValuePct', 'partial.sourceWithinHours', 'partial.shortageDeclinesToDrop'];

async function onAdmin(req: Request, url: URL) {
  if (!same(req.headers.get('x-admin-key'), await secret('admin_key'))) return json({ error: 'Wrong admin key' }, 403);
  if (req.method === 'GET') {
    if (url.searchParams.get('events')) {
      const { data } = await db.from('event_log').select('at, type, shop_id, data').eq('order_id', url.searchParams.get('events')).order('id');
      return json({ events: data ?? [] });
    }
    const { d, extra, now } = await readState();
    return json(adminView(d, extra, now));
  }
  const body = await req.json();
  let link: string | null = null;
  if (body.act === 'addShop' || body.act === 'newLink') link = newToken();
  const out: any = await withState(({ d, extra, now }) => {
    let r: any = { ok: true };
    const o = body.orderId ? d.orders.get(body.orderId) : null;
    const s = body.shopId ? d.shops.get(body.shopId) : null;
    switch (body.act) {
      case 'addShop': {
        const where = locate({ city: body.city, province: body.province, latitude: body.lat, longitude: body.lng });
        if (!body.name || !where) { r = { ok: false, reason: 'Add a name and a city we know (or map coordinates).' }; break; }
        const id = 'shop-' + newToken().slice(0, 8);
        d.shops.set(id, { id, name: String(body.name).slice(0, 60), city: body.city, province: body.province ?? '', phone: String(body.phone ?? '').slice(0, 20),
          island: where.island, lat: where.lat, lng: where.lng, stock: {}, reserved: {}, active: true, strikes: 0, rating: 4.5 });
        r = { ok: true, shopId: id }; break;
      }
      case 'newLink': r = s ? { ok: true, shopId: s.id } : { ok: false }; break;
      case 'pauseShop': if (s && !s.hub) s.active = false; break;
      case 'reinstate': if (s) { s.active = true; s.strikes = 0; } break;
      case 'clearStrikes': if (s) s.strikes = 0; break;
      case 'tohub': if (o && ['dispatching', 'assigned'].includes(o.status) && !d.shops.get(o.shopId)?.hub) {
        if (o.status === 'assigned') d.release(o);
        d.toHub(o, now, 'sent by admin', true);
      } break;
      case 'hubship': r = o ? d.ship(o.id, 'hub', String(body.tracking ?? 'HUB').slice(0, 60), now) : { ok: false }; break;
      case 'deliver': r = o ? d.deliver(o.id, now) : { ok: false }; break;
      case 'pay': {
        const list = [...d.orders.values()].filter((x: any) => x.payout?.shop === body.shopId && x.payout.status === 'payable');
        const amount = list.reduce((t: number, x: any) => t + x.payout.amount, 0);
        list.forEach((x: any) => { x.payout.status = 'paid'; x.payout.paidAt = now; });
        extra.payments = [...(extra.payments ?? []), { at: now, shop: body.shopId, orders: list.length, amount }];
        r = { ok: true, amount }; break;
      }
      case 'manualDone': extra.manual = (extra.manual ?? []).map((m: any) => m.id === body.id ? { ...m, status: 'done', doneAt: now } : m); break;
      case 'rule': {
        const v = Number(body.value);
        if (!RULE_PATHS.includes(body.path) || !Number.isFinite(v) || v < 0 || v > 1000) { r = { ok: false, reason: 'Not a valid rule value' }; break; }
        const keys = body.path.split('.'), last = keys.pop(); keys.reduce((x: any, k: string) => x[k], d.cfg)[last] = v; break;
      }
      case 'payoutRule': {
        const share = Number(body.share), fee = Number(body.packingFee);
        if (!(share > 0 && share < 1) || !(fee >= 0 && fee < 5000)) { r = { ok: false, reason: 'Share must be between 0 and 1' }; break; }
        extra.payout = { share, packingFee: fee }; break;
      }
      default: r = { ok: false, reason: 'Unknown action' };
    }
    return { result: r, view: adminView(d, extra, now) };
  });
  if (link && out.result?.ok) {
    await db.from('shop_links').delete().eq('shop_id', out.result.shopId);
    await db.from('shop_links').insert({ token_hash: await sha256(link), shop_id: out.result.shopId });
    out.result.link = link;
  }
  return json(out);
}

// ---------- Timer ----------
async function onTick(req: Request) {
  if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return json({ error: 'no' }, 403);
  const n = await withState(({ d, now }) => { const b = d.events.length; d.tick(now); return d.events.length - b; });
  return json({ ok: true, events: n });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api/, '') || '/';
  try {
    if (path === '/shopify' && req.method === 'POST') return await onShopify(req);
    if (path === '/tick' && req.method === 'POST') return await onTick(req);
    if (path === '/shop') return await onShop(req, url);
    if (path === '/admin') return await onAdmin(req, url);
    if (path === '/health') return json({ ok: true, at: new Date().toISOString() });
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
