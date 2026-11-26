// 888 dispatch server (Supabase Edge Function "api"). Deployed with imports pinned to a commit of this repo.
//   POST /api/shopify          Shopify "order payment" webhook (signed)
//   POST /api/tick             every minute from pg_cron (x-cron-key)
//   POST /api/lazada           new/changed Lazada orders, posted by the lazada-auth function (x-cron-key)
//   POST /api/catalog-refresh  every 10 min from pg_cron: product list copy via the Shopify Storefront API (x-cron-key)
//   GET/POST /api/shop         partner shop screen (secret link token)
//   GET/POST /api/admin        owner screen (x-admin-key)
//   GET/POST /api/voucher      company gift voucher welcome page (secret link)
//   GET/POST /api/vadmin       owner: company voucher batches (x-admin-key)
//   GET/POST /api/supplier     supplier price list (secret link token)
//   GET/POST /api/sadmin       owner: compare supplier prices per item (x-admin-key)
//   GET/POST /api/sinvite      staff helper: name supplier slots, copy invite links (secret link)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { Dispatcher } from './engine.js';
import { config as DEFAULT_CONFIG } from './config.js';
import { snapshot, restore, prune } from './store.js';
import { fromShopify, verifyShopify, PAYOUT } from './shopify.js';
import { buildCatalog } from './catalog.js';
import { locate } from './places.js';
import { shopView, adminView } from './views.js';
import { normalizePH, textsFor, manualText } from './sms.js';
import { fromLazada, skuMap, lazadaStage, lazadaRawStatus, lazadaTracking, packReq, labelReq, rtsReq, packResult, rtsErrors } from './lazada.js';
import { itemsFromProducts, buildPack, priceBatch, validateBatch, voucherCode, prefixFor, voucherState, packDeadline,
  voucherPackage, cleanRecipient, forecast, VOUCHER_DEFAULTS, roundTo10, splitAmount, voucherPayments, cleanBuyer, BATCH_PROP, voucherPhp, validateSelf, packForCard, giftCardCode } from './vouchers.js';

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

// ---------- Text messages (Semaphore) ----------
async function sendTexts(texts: any[]) {
  if (!texts.length) return [];
  const key = await secret('semaphore_api_key');
  const sender = await secret('semaphore_sender');
  const results = [];
  for (const t of texts.slice(0, 20)) {
    let ok = false, response = '';
    if (!key || key.startsWith('PASTE-')) response = 'No Semaphore key yet';
    else {
      try {
        const form = new URLSearchParams({ apikey: key, number: t.to, message: t.message });
        if (sender) form.set('sendername', sender);
        const res = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body: form });
        response = (await res.text()).slice(0, 500);
        ok = res.ok && !/insufficient|invalid|error|failed/i.test(response);
      } catch (e) { response = String(e).slice(0, 200); }
    }
    results.push({ ...t, ok, response });
  }
  await db.from('sms_log').insert(results.map((r) => ({ to_number: r.to, kind: r.kind, ref: r.ref ?? null, message: r.message, ok: r.ok, response: r.response })));
  return results;
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
      try { await sendTexts(textsFor(fresh, d, { ownerPhone: extra.ownerPhone })); } catch (e) { console.error('sms', e); }
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
  // Refunds and cancellations (their own Shopify webhooks, same signing secret): switch off the gift cards
  // that order paid for, so money given back can never also be spent as a gift card.
  const topic = req.headers.get('x-shopify-topic') ?? '';
  if (topic === 'refunds/create' || topic === 'orders/cancelled') return json({ ok: true, ...(await reverseVouchers(o, topic)) });
  const { error: dupe } = await db.from('shopify_orders').insert({ shopify_id: o.id, name: o.name, payload: o });
  if (dupe) return json({ ok: true, duplicate: true }); // Shopify retries: already have it
  try { await payVoucherBatches(o); } catch (e) { console.error('voucher payment', e); }
  const result = await withState(({ d, extra }) => {
    const r: any = fromShopify(o, catalog, extra.payout ?? PAYOUT);
    if (r.manual) { extra.manual = [...(extra.manual ?? []), r.manual]; return { manual: r.manual.reason, ownerText: manualText(r.manual, extra.ownerPhone) }; }
    if (r.skip) return { skipped: r.skip };
    if (d.orders.has(r.order.id)) return { exists: r.order.id };
    d.packages.set(r.package.id, r.package);
    d.placeOrder(r.order);
    return { dispatched: r.order.id };
  });
  if ((result as any).ownerText) { try { await sendTexts([(result as any).ownerText]); } catch (e) { console.error('sms', e); } delete (result as any).ownerText; }
  await db.from('shopify_orders').update({ result }).eq('shopify_id', o.id);
  return json({ ok: true, ...result });
}

// ---------- Lazada ----------
// The lazada-auth function reads new and changed Lazada orders every 5 minutes and posts them here
// (x-cron-key): { orders: [{ order, items }] }. Each partner shop is a Lazada warehouse, so Lazada has
// already chosen the shop; we hand the order to it, then follow Lazada's status (cancel / shipped / delivered).
async function onLazada(req: Request) {
  if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return json({ error: 'no' }, 403);
  const { orders } = await req.json();
  const { data: cache } = await db.from('shop_catalog_cache').select('products').eq('id', 1).maybeSingle();
  const bySku = skuMap(cache?.products ?? []);
  const results: any[] = [];
  for (const { order, items } of (orders ?? []).slice(0, 100)) {
    const lazId = String(order?.order_id ?? '');
    if (!lazId) continue;
    const stage = lazadaStage(items), raw = lazadaRawStatus(items);
    const { data: seen } = await db.from('lazada_orders').select('stage, payload').eq('order_id', lazId).maybeSingle();
    if (seen && seen.stage === stage && lazadaRawStatus(seen.payload?.items) === raw) continue; // nothing new
    if (!seen) await db.from('lazada_orders').insert({ order_id: lazId, stage, payload: { order, items } });
    else await db.from('lazada_orders').update({ stage, payload: { order, items }, updated_at: new Date().toISOString() }).eq('order_id', lazId);
    const id = `LZ-${lazId}`;
    const result: any = await withState(({ d, extra, now }) => {
      const known = d.orders.get(id);
      if (known?.lazada && known.lazada.status !== raw) { known.lazada.status = raw; known.lazada.statusAt = now; if (!known.lazada.tracking) known.lazada.tracking = lazadaTracking(items); }
      if (!known) {
        // Orders that were already shipped/finished before this link existed are only recorded.
        if (stage !== 'new') return { history: stage };
        const r: any = fromLazada(order, items, { catalog, bySku, payout: extra.payout ?? PAYOUT,
          shopForWarehouse: (code: string) => [...d.shops.values()].find((s: any) => s.lazadaWarehouse && s.lazadaWarehouse === code)?.id ?? null });
        if (r.manual) { extra.manual = [...(extra.manual ?? []), r.manual]; return { manual: r.manual.reason, ownerText: manualText(r.manual, extra.ownerPhone) }; }
        if (r.skip) return { skipped: r.skip };
        if (!r.order.address) { const s = d.shops.get(r.order.shopId) ?? d.hub(); r.order.address = { lat: s.lat, lng: s.lng, island: s.island }; }
        d.packages.set(r.package.id, r.package);
        const o = d.assignDirect(r.order);
        o.lazada.status = raw; o.lazada.statusAt = now;
        return { assigned: o.shopId };
      }
      if (stage === 'cancelled') return d.cancel(id, now, 'Lazada: cancelled');
      if (stage === 'shipped' || stage === 'delivered') {
        let r: any = { ok: true };
        if (known.status === 'assigned') {
          r = d.ship(id, known.shopId, lazadaTracking(items) ?? 'LAZADA', now);
          if (!r.ok) { known.status = 'shipped'; known.shippedAt = now; known.tracking = lazadaTracking(items) ?? 'LAZADA'; known.lateShip = true; r = { ok: true, late: true }; }
        }
        if (stage === 'delivered') r = d.deliver(id, now);
        return r;
      }
      return { unchanged: stage };
    });
    if (result?.ownerText) { try { await sendTexts([result.ownerText]); } catch (e) { console.error('sms', e); } delete result.ownerText; }
    await db.from('lazada_orders').update({ result }).eq('order_id', lazId);
    results.push({ id, stage, result });
  }
  return json({ ok: true, results });
}

// ---------- Lazada shipping from Dispatch (no Seller Center needed) ----------
// Pack -> shipping label (J&T, printed by the shop) -> Ready to ship (J&T comes to pick up).
// Calls go through the lazada-auth function, which holds the Lazada keys. `who` = the shop asking
// (shop screen) or null (owner/admin screen, any order, including hub orders).
const LZ_FULFIL = 'https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/lazada-auth/fulfil';
async function lazadaCall(path: string, body: unknown) {
  const res = await fetch(LZ_FULFIL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-key': (await secret('cron_key'))! }, body: JSON.stringify({ path, body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.ok === false) throw new Error(String(j?.error ?? `Lazada ${res.status}`).replace(/^lazada_/, 'Lazada '));
  return j;
}

async function lazadaShip(act: string, orderId: string, who: string | null): Promise<any> {
  const { d } = await readState();
  const o = d.orders.get(orderId);
  if (!o || o.source !== 'lazada' || !o.lazada) return { ok: false, reason: 'Not a Lazada order.' };
  if (who && o.shopId !== who) return { ok: false, reason: 'Not your order.' };
  if (o.status === 'cancelled') return { ok: false, reason: 'This order was cancelled. Do not ship it.' };
  if (act === 'lzRts' && o.status !== 'assigned') return { ok: false, reason: 'Already marked ready to ship.' };
  let lz = o.lazada;
  try {
    if (!lz.packageIds?.length) {
      if (o.status !== 'assigned') return { ok: false, reason: 'This order is not waiting to be packed.' };
      let itemIds: string[] = lz.itemIds ?? [];
      if (!itemIds.length) {
        const { data: row } = await db.from('lazada_orders').select('payload').eq('order_id', lz.orderId).maybeSingle();
        itemIds = (row?.payload?.items ?? []).filter((i: any) => !/cancel|fail|return/i.test(String(i.status))).map((i: any) => String(i.order_item_id));
      }
      if (!itemIds.length) return { ok: false, reason: 'No Lazada items found for this order.' };
      const p = packResult(await lazadaCall('/order/fulfill/pack', packReq(lz.orderId, itemIds)));
      if (!p.packageIds.length) return { ok: false, reason: `Lazada did not pack it: ${p.errors.join('; ') || 'no package made'}` };
      lz = { ...lz, itemIds, packageIds: p.packageIds, tracking: p.tracking, provider: p.provider ?? lz.provider };
      await withState(({ d, now }) => {
        const x = d.orders.get(orderId); if (!x) return;
        x.lazada = { ...x.lazada, ...lz, packedAt: now };
        d.log(now, 'lazada_packed', { order: orderId, shop: x.shopId, tracking: p.tracking });
      });
    }
    if (act === 'lzLabel') {
      const r = await lazadaCall('/order/package/document/get', labelReq(lz.packageIds));
      const data = r?.result?.data ?? {};
      if (!data.file && !data.pdf_url) return { ok: false, reason: `No label from Lazada yet (${r?.result?.error_msg ?? 'try again in a minute'}).` };
      await withState(({ d, now }) => { const x = d.orders.get(orderId); if (x && !x.lazada.labelAt) x.lazada.labelAt = now; });
      return { ok: true, label: { file: data.file ?? null, url: data.pdf_url ?? null }, tracking: lz.tracking ?? null };
    }
    if (act === 'lzRts') {
      const errs = rtsErrors(await lazadaCall('/order/package/rts', rtsReq(lz.packageIds)));
      if (errs.length) return { ok: false, reason: `Lazada said: ${errs.join('; ')}` };
      return await withState(({ d, now }) => {
        const x = d.orders.get(orderId); if (!x) return { ok: false };
        x.lazada.rtsAt = now;
        if (x.status !== 'assigned') return { ok: true };
        const r = d.ship(orderId, x.shopId, lz.tracking ?? 'LAZADA', now);
        if (!r.ok) { x.status = 'shipped'; x.shippedAt = now; x.tracking = lz.tracking ?? 'LAZADA'; x.lateShip = true; d.log(now, 'shipped', { order: orderId, shop: x.shopId, tracking: x.tracking, late: true }); }
        return { ok: true, tracking: lz.tracking ?? null };
      });
    }
    return { ok: true, packed: true, tracking: lz.tracking ?? null };
  } catch (e) {
    console.error('lazada ship', act, orderId, String(e));
    return { ok: false, reason: String((e as Error).message ?? e).slice(0, 200) };
  }
}

// Several Lazada orders on one label file (bulk print / reprint). Packs any that aren't packed yet.
async function lazadaLabels(ids: string[]): Promise<any> {
  const errors: string[] = [];
  for (const id of ids.slice(0, 50)) { const r = await lazadaShip('lzPack', id, null); if (!r.ok) errors.push(`${id}: ${r.reason}`); }
  const { d } = await readState();
  const done = ids.filter((id) => d.orders.get(id)?.lazada?.packageIds?.length && d.orders.get(id)?.status !== 'cancelled');
  const pk = [...new Set(done.flatMap((id) => d.orders.get(id).lazada.packageIds))];
  if (!pk.length) return { ok: false, reason: errors.join('; ') || 'No Lazada orders to print.' };
  try {
    const r = await lazadaCall('/order/package/document/get', labelReq(pk));
    const data = r?.result?.data ?? {};
    if (!data.file && !data.pdf_url) return { ok: false, reason: `No labels from Lazada yet (${r?.result?.error_msg ?? 'try again in a minute'}).` };
    await withState(({ d, now }) => { for (const id of done) { const x = d.orders.get(id); if (x?.lazada && !x.lazada.labelAt) x.lazada.labelAt = now; } });
    return { ok: true, label: { file: data.file ?? null, url: data.pdf_url ?? null }, printed: done.length, errors };
  } catch (e) { return { ok: false, reason: String((e as Error).message ?? e).slice(0, 200) }; }
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
  if (['lzPack', 'lzLabel', 'lzRts'].includes(body.act)) {
    const result = await lazadaShip(body.act, String(body.orderId), shopId);
    const { d, now } = await readState();
    return json({ result, view: shopView(d, shopId, catalog, now) });
  }
  const out = await withState(({ d, now }) => {
    const shop = d.shops.get(shopId); if (!shop) return { result: { ok: false, reason: 'Shop removed' } };
    const mineOffer = (id: string) => { const of = d.offers.find((o: any) => o.id === id); return of && of.shopId === shopId ? of : null; };
    let r: any = { ok: true };
    switch (body.act) {
      case 'accept': r = mineOffer(body.offerId) ? d.accept(body.offerId, now, {
        commitToSource: !!body.commit, mode: body.mode === 'without' || body.mode === 'buyin' ? body.mode : null,
        notHave: Array.isArray(body.notHave) ? body.notHave.map(String).slice(0, 50) : [],
        confirmHave: Array.isArray(body.confirmHave) ? body.confirmHave.map(String).slice(0, 50) : [] }) : { ok: false, reason: 'Not your offer' }; break;
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
    if (url.searchParams.get('sms')) {
      const { data } = await db.from('sms_log').select('at, to_number, kind, ref, message, ok, response').order('id', { ascending: false }).limit(30);
      return json({ sms: data ?? [] });
    }
    if (url.searchParams.get('events')) {
      const { data } = await db.from('event_log').select('at, type, shop_id, data').eq('order_id', url.searchParams.get('events')).order('id');
      return json({ events: data ?? [] });
    }
    const { d, extra, now } = await readState();
    return json(adminView(d, extra, now));
  }
  const body = await req.json();
  if (['lzPack', 'lzLabel', 'lzRts', 'lzLabels'].includes(body.act)) {
    const result = body.act === 'lzLabels' ? await lazadaLabels((Array.isArray(body.orderIds) ? body.orderIds : []).map(String))
      : await lazadaShip(body.act, String(body.orderId), null);
    const { d, extra, now } = await readState();
    return json({ result, view: adminView(d, extra, now) });
  }
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
      case 'lazadaWarehouse': {
        if (!s || s.hub) { r = { ok: false }; break; }
        const code = String(body.code ?? '').trim().slice(0, 60);
        const taken = code && [...d.shops.values()].find((x: any) => x.id !== s.id && x.lazadaWarehouse === code);
        if (taken) { r = { ok: false, reason: `That warehouse code is already linked to ${taken.name}.` }; break; }
        if (code) s.lazadaWarehouse = code; else delete s.lazadaWarehouse;
        r = { ok: true }; break;
      }
      case 'setPhone': {
        if (!s) { r = { ok: false }; break; }
        const phone = String(body.phone ?? '').trim().slice(0, 20);
        if (phone && !normalizePH(phone)) { r = { ok: false, reason: 'Use a Philippine mobile number, like 0917 123 4567.' }; break; }
        s.phone = phone; r = { ok: true }; break;
      }
      case 'ownerPhone': {
        const phone = String(body.phone ?? '').trim().slice(0, 20);
        if (phone && !normalizePH(phone)) { r = { ok: false, reason: 'Texts can only go to Philippine mobile numbers, like 0917 123 4567.' }; break; }
        extra.ownerPhone = phone; r = { ok: true }; break;
      }
      case 'testSms': {
        const to = normalizePH(s ? s.phone : extra.ownerPhone);
        if (!to) { r = { ok: false, reason: 'Add a Philippine mobile number first.' }; break; }
        r = { ok: true, test: { to, kind: 'test', ref: s?.id ?? 'owner', message: `888 test: order alerts by text are working${s ? ' for ' + String(s.name).slice(0, 40) : ''}. Salamat!` } }; break;
      }
      case 'buyerChoice': r = o ? d.buyerChoice(o.id, body.choice === 'later' ? 'later' : 'refund', now) : { ok: false }; break;
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
  if (out.result?.test) { const [t] = await sendTexts([out.result.test]); out.result = t.ok ? { ok: true, sent: true } : { ok: false, reason: `Semaphore didn't send it: ${t.response.slice(0, 160)}` }; }
  if (link && out.result?.ok) {
    await db.from('shop_links').delete().eq('shop_id', out.result.shopId);
    await db.from('shop_links').insert({ token_hash: await sha256(link), shop_id: out.result.shopId });
    out.result.link = link;
  }
  return json(out);
}

// ---------- Company gift vouchers ----------
const STORE = 'https://3vyvyi-iq.myshopify.com';
let productCache: { at: number; items: any[] } | null = null;
async function packItems() {
  if (productCache && Date.now() - productCache.at < 10 * 60_000) return productCache.items;
  // Shopify rate-limits products.json from the edge function's shared IPs (429), so the database keeps a copy
  // (refresh_shop_catalog, pg_cron every 5 min). Use it; only ask Shopify directly if the copy is missing or > 1 day old.
  let products: any[] | null = null;
  const { data: saved } = await db.from('shop_catalog_cache').select('products, fetched_at').eq('id', 1).maybeSingle();
  const age = saved?.fetched_at ? Date.now() - Date.parse(saved.fetched_at) : Infinity;
  if (saved?.products && age < 30 * 60_000) products = saved.products;
  if (!products) {
    products = await freshProducts();
    if (products?.length) await db.from('shop_catalog_cache').update({ products, fetched_at: new Date().toISOString() }).eq('id', 1);
  }
  if (!products?.length && saved?.products && age < 86_400_000) products = saved.products;
  if (!products?.length) {
    const res = await fetch(`${STORE}/products.json?limit=250`);
    if (!res.ok) throw new Error(`Shop catalogue ${res.status}`);
    products = (await res.json()).products;
  }
  const items = itemsFromProducts(products).filter((i: any) => catalog.byVariant.has(String(i.variantId)));
  productCache = { at: Date.now(), items };
  return items;
}
// Same shape as storefront products.json (what itemsFromProducts reads), via the Admin API (own rate limit, not per IP).
const GRAMS: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, POUNDS: 453.592, OUNCES: 28.3495 };
async function adminProducts(): Promise<any[] | null> {
  const token = await shopifyAdminToken();
  if (!token) return null;
  const out: any[] = []; let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`${STORE}/admin/api/2026-10/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ variables: { after }, query: `query($after: String) { products(first: 100, after: $after, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        nodes { title handle productType featuredMedia { preview { image { url } } }
          variants(first: 10) { nodes { legacyResourceId sku price availableForSale inventoryItem { measurement { weight { value unit } } } } } } } }` }) });
    const j = await res.json();
    const conn = j?.data?.products;
    if (!conn) throw new Error(j?.errors?.[0]?.message ?? `HTTP ${res.status}`);
    for (const n of conn.nodes) out.push({
      title: n.title, handle: n.handle, product_type: n.productType,
      images: n.featuredMedia?.preview?.image?.url ? [{ src: n.featuredMedia.preview.image.url }] : [],
      variants: n.variants.nodes.map((v: any) => {
        const w = v.inventoryItem?.measurement?.weight;
        return { id: Number(v.legacyResourceId), sku: v.sku ?? '', price: v.price, available: v.availableForSale, grams: w ? Math.round(Number(w.value) * (GRAMS[w.unit] ?? 0)) : 0 };
      }),
    });
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}
// Same shape again, from Shopify's public Storefront API (tokenless, on the shop's own domain). It isn't
// blocked the way products.json is, and needs no app permission (the Admin app has no read_products).
const W: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, POUNDS: 453.592, OUNCES: 28.3495 };
async function storefrontProducts(): Promise<any[] | null> {
  const out: any[] = []; let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await fetch('https://888grocery.com/api/2026-10/graphql.json', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variables: { after }, query: `query($after: String) { products(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { title handle productType featuredImage { url }
          variants(first: 10) { nodes { id sku availableForSale weight weightUnit price { amount } } } } } }` }) });
    if (!res.ok) throw new Error(`storefront ${res.status}`);
    const j = await res.json();
    const conn = j?.data?.products;
    if (!conn) throw new Error(j?.errors?.[0]?.message ?? 'storefront: no products');
    for (const n of conn.nodes) out.push({
      title: n.title, handle: n.handle, product_type: n.productType, images: n.featuredImage?.url ? [{ src: n.featuredImage.url }] : [],
      variants: n.variants.nodes.map((v: any) => ({ id: Number(String(v.id).split('/').pop()), sku: v.sku ?? '', price: v.price?.amount,
        available: v.availableForSale, grams: Math.round(Number(v.weight ?? 0) * (W[v.weightUnit] ?? 0)) })),
    });
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}
async function freshProducts(): Promise<any[] | null> {
  try { const p = await storefrontProducts(); if (p?.length) return p; } catch (e) { console.error('storefront products', String(e)); }
  try { return await adminProducts(); } catch (e) { console.error('admin products', String(e)); return null; }
}
const DESIGNS = ['christmas', 'thankyou', 'easter'];
const designOf = (d: any) => (DESIGNS.includes(String(d)) ? String(d) : 'christmas');
const publicPack = (pack: any) => ({ total: pack.total, kg: pack.kg, lines: pack.lines.map((l: any) => ({ title: l.title, qty: l.qty, image: l.image, variantId: l.variantId })) });

async function voucherByToken(t: string | null) {
  if (!t || t.length < 20) return null;
  const { data: v } = await db.from('vouchers').select('*').eq('token', t).maybeSingle();
  if (!v) return null;
  const { data: b } = await db.from('voucher_batches').select('*').eq('id', v.batch_id).maybeSingle();
  return b ? { v, b } : null;
}

function voucherView(v: any, b: any, now: number) {
  const state = voucherState(v, b, now);
  return {
    code: v.code, state, staffName: v.staff_name ?? '', company: b.company, logo: b.logo ?? null,
    greeting: b.greeting ?? '', signOff: b.sign_off ?? '', valuePhp: b.budget_php, design: b.design ?? 'christmas', issuedAt: v.issued_at ?? b.paid_at ?? null, giftCode: v.gift_card_code ?? null, deliveryPhp: b.delivery_php,
    pack: publicPack(b.pack), packUntil: packDeadline(v, b),
    redeemed: state === 'redeemed' ? { at: v.redeemed_at, to: v.recipient?.name ?? '', city: v.recipient?.city ?? '' } : null,
  };
}

async function onVoucher(req: Request, url: URL) {
  const body = req.method === 'POST' ? await req.json() : {};
  const found = await voucherByToken(body.t ?? url.searchParams.get('t'));
  if (!found) return json({ error: 'We could not find this gift voucher. Please check the link, or message 888 Grocery.' }, 404);
  const { v, b } = found;
  const now = Date.now();
  if (req.method === 'GET') {
    if (!v.opened_at) await db.from('vouchers').update({ opened_at: new Date().toISOString() }).eq('code', v.code);
    return json(voucherView(v, b, now));
  }
  // Shopify only: a voucher is redeemed by entering its Shopify gift card code at
  // Shopify checkout. There is no other way to send a gift.
  return json({ ok: false, reason: 'Please redeem this gift at checkout with your Shopify gift card code.', view: voucherView(v, b, now) }, 405);
}

async function onVoucherAdmin(req: Request, url: URL) {
  if (!same(req.headers.get('x-admin-key'), await secret('admin_key'))) return json({ error: 'Wrong admin key' }, 403);
  const now = Date.now();
  if (req.method === 'GET') {
    const batchId = url.searchParams.get('batch');
    if (batchId) {
      const { data: b } = await db.from('voucher_batches').select('*').eq('id', batchId).maybeSingle();
      if (!b) return json({ error: 'No such batch' }, 404);
      const { data: vs } = await db.from('vouchers').select('code, token, staff_name, staff_contact, status, issued_at, opened_at, redeemed_at, order_ref, recipient').eq('batch_id', batchId).order('created_at');
      return json({ batch: b, vouchers: (vs ?? []).map((v: any) => ({ ...v, state: voucherState(v, b, now) })) });
    }
    const { data: bs } = await db.from('voucher_batches').select('id, company, greeting, sign_off, budget_nzd, nzd_to_php, delivery_php, budget_php, pack, qty, paid, paid_at, created_at, currency, amount_local, source, buyer_email').order('created_at', { ascending: false });
    const { data: vs } = await db.from('vouchers').select('batch_id, status, issued_at, opened_at');
    const batches = (bs ?? []).map((b: any) => {
      const mine = (vs ?? []).filter((v: any) => v.batch_id === b.id);
      const count = (st: string) => mine.filter((v: any) => voucherState(v, b, now) === st).length;
      return { ...b, opened: mine.filter((v: any) => v.opened_at).length, waiting: count('pack'), redeemed: count('redeemed'), credit: count('credit') };
    });
    return json({ batches, forecast: forecast(bs ?? [], vs ?? [], now), defaults: VOUCHER_DEFAULTS });
  }
  const body = await req.json();
  switch (body.act) {
    case 'preview': {
      const rate = Number(body.nzdToPhp) || VOUCHER_DEFAULTS.nzdToPhp, delivery = body.deliveryPhp ?? VOUCHER_DEFAULTS.deliveryPhp;
      const p = priceBatch({ budgetNzd: body.budgetNzd, nzdToPhp: rate, deliveryPhp: delivery });
      if (!(p.goodsPhp > 300)) return json({ ok: false, reason: 'That value is too small for a pack after delivery.' });
      return json({ ok: true, ...p, pack: buildPack(p.goodsPhp, await packItems()) });
    }
    case 'create': {
      const err = validateBatch(body);
      if (err) return json({ ok: false, reason: err });
      const p = priceBatch(body);
      const pack = buildPack(p.goodsPhp, await packItems());
      if (!pack.lines.length) return json({ ok: false, reason: 'Could not make a pack for that value.' });
      const id = `B-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${newToken().slice(0, 4).toUpperCase()}`;
      const { error } = await db.from('voucher_batches').insert({ id, company: String(body.company).trim().slice(0, 80), logo: body.logo || null,
        greeting: String(body.greeting ?? '').slice(0, 600), sign_off: String(body.signOff ?? '').slice(0, 120),
        budget_nzd: Number(body.budgetNzd), nzd_to_php: Number(body.nzdToPhp), delivery_php: Number(body.deliveryPhp), budget_php: p.budgetPhp,
        pack, qty: Number(body.qty), note: String(body.note ?? '').slice(0, 300), design: designOf(body.design) });
      if (error) throw error;
      const staff = Array.isArray(body.staff) ? body.staff : [];
      const prefix = prefixFor(body.company);
      const rows = [];
      for (let i = 0; i < Number(body.qty); i++) {
        const s = staff[i] ?? {};
        rows.push({ code: voucherCode(prefix, crypto.getRandomValues(new Uint8Array(6))), token: newToken(), batch_id: id,
          staff_name: String(s.name ?? '').slice(0, 80) || null, staff_contact: String(s.contact ?? '').slice(0, 120) || null });
      }
      const { error: e2 } = await db.from('vouchers').insert(rows);
      if (e2) { await db.from('voucher_batches').delete().eq('id', id); throw e2; }
      return json({ ok: true, batchId: id });
    }
    case 'markPaid': {
      const at = new Date().toISOString();
      // Paid outside Shopify (bank transfer): always on the record.
      await db.from('event_log').insert({ at, type: 'voucher_mark_paid', order_id: String(body.batchId ?? ''), data: { by: 'owner key' } });
      const { data } = await db.from('voucher_batches').update({ paid: true, paid_at: at }).eq('id', body.batchId).eq('paid', false).select('id');
      if (data?.length) await db.from('vouchers').update({ issued_at: at }).eq('batch_id', body.batchId).is('issued_at', null);
      return json({ ok: true, cards: await issueGiftCards(body.batchId) });
    }
    case 'issueCards': {
      return json({ ok: true, cards: await issueGiftCards(body.batchId) });
    }
    case 'editBatch': {
      const patch: any = {};
      if (typeof body.greeting === 'string') patch.greeting = body.greeting.slice(0, 600);
      if (typeof body.signOff === 'string') patch.sign_off = body.signOff.slice(0, 120);
      if (typeof body.design === 'string') patch.design = designOf(body.design);
      if (typeof body.company === 'string' && body.company.trim()) patch.company = body.company.trim().slice(0, 80);
      if (body.logo === null || (typeof body.logo === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(body.logo) && body.logo.length <= 400_000)) patch.logo = body.logo;
      await db.from('voucher_batches').update(patch).eq('id', body.batchId);
      return json({ ok: true });
    }
    case 'staff': {
      await db.from('vouchers').update({ staff_name: String(body.name ?? '').slice(0, 80) || null, staff_contact: String(body.contact ?? '').slice(0, 120) || null }).eq('code', body.code);
      return json({ ok: true });
    }
    case 'cancel': {
      // Cancelling a voucher also switches off its Shopify gift card (before, the card stayed spendable).
      const { data: v } = await db.from('vouchers').select('code, gift_card_id').eq('code', body.code).eq('status', 'issued').maybeSingle();
      const off = v ? await deactivateCard(v.code, v.gift_card_id, 'cancelled by owner') : false;
      await db.from('event_log').insert({ at: new Date().toISOString(), type: 'voucher_cancelled', order_id: String(body.code ?? ''), data: { cardOff: off } });
      return json({ ok: true, cardOff: off });
    }
    case 'newLink': {
      const token = newToken();
      const { data } = await db.from('vouchers').update({ token, opened_at: null }).eq('code', body.code).eq('status', 'issued').select('code');
      return json(data?.length ? { ok: true, token } : { ok: false, reason: 'Only unused vouchers can get a new link.' });
    }
    default: return json({ ok: false, reason: 'Unknown action' });
  }
}

// ---------- Self-service: companies buy vouchers themselves ----------
//   POST /api/vbuy      preview a pack, or make an unpaid batch + the cart lines to pay for it
//   GET/POST /api/vmanage  the buyer's own voucher page (secret manage link)
// The batch goes live when Shopify's "order payment" webhook shows it paid.
const CREDIT_VARIANTS: Record<number, number> = { 1000: 44605447897149, 100: 44605447929917, 10: 44605447962685 };
const SELF_MAX_QTY = 500;

// What was really paid per batch: line price x qty MINUS any discount on that line (a sale code must never
// buy full-value gift cards), and only for orders Shopify reports as fully paid.
// Only the "Gift voucher credit" variants count: anyone can tag ANY cart line with the batch property, so a
// tagged rice line would otherwise ship the rice AND pay for vouchers worth the same money.
const CREDIT_VARIANT_IDS = new Set(Object.values(CREDIT_VARIANTS).map(String));
function netVoucherPayments(o: any) {
  const by = new Map<string, number>();
  if (o?.financial_status !== 'paid') return by; // fail closed: missing status = not paid
  for (const li of o?.line_items ?? []) {
    const p = (li.properties ?? []).find((x: any) => x.name === BATCH_PROP);
    if (!p?.value) continue;
    if (!CREDIT_VARIANT_IDS.has(String(li.variant_id))) continue;
    const allocs = li.discount_allocations ?? [];
    const disc = allocs.length ? allocs.reduce((t: number, d: any) => t + Number(d.amount ?? 0), 0) : Number(li.total_discount ?? 0);
    const net = Math.max(0, Number(li.price) * Number(li.quantity) - disc);
    by.set(String(p.value), Math.round(((by.get(String(p.value)) ?? 0) + net) * 100) / 100);
  }
  return by;
}

async function payVoucherBatches(o: any) {
  const paid = netVoucherPayments(o);
  for (const [batchId, amount] of paid) {
    // Optimistic update: only applies if nobody changed the batch in between (two orders paying at once).
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: b } = await db.from('voucher_batches').select('id, paid, total_php, paid_php, reversed_at').eq('id', batchId).maybeSingle();
      if (!b || b.paid || b.reversed_at) break;
      const sum = Number(b.paid_php ?? 0) + amount;
      const full = sum + 0.5 >= Number(b.total_php);
      const at = new Date().toISOString();
      let q = db.from('voucher_batches').update({ paid_php: sum, shopify_order: String(o.name ?? o.id), ...(full ? { paid: true, paid_at: at } : {}) }).eq('id', batchId).eq('paid', false);
      q = b.paid_php == null ? q.is('paid_php', null) : q.eq('paid_php', b.paid_php);
      const { data: done } = await q.select('id');
      if (!done?.length) continue;
      if (full) { await db.from('vouchers').update({ issued_at: at }).eq('batch_id', batchId).is('issued_at', null); await issueGiftCards(batchId); }
      break;
    }
  }
}

// ---------- Money given back: switch the gift cards off ----------
const tagOf = (li: any) => (li?.properties ?? []).find((x: any) => x.name === BATCH_PROP)?.value;
async function shopifyGql(query: string, variables: unknown) {
  const token = await shopifyAdminToken();
  if (!token) throw new Error('no Shopify access');
  const res = await fetch(`${STORE}/admin/api/2026-10/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables }) });
  return await res.json();
}
async function deactivateCard(code: string, giftCardId: string | null, why: string) {
  let err: string | null = null;
  if (giftCardId?.startsWith('gid://')) {
    try {
      const j = await shopifyGql('mutation($id: ID!) { giftCardDeactivate(id: $id) { giftCard { id enabled } userErrors { message } } }', { id: giftCardId });
      err = j?.data?.giftCardDeactivate?.userErrors?.map((e: any) => e.message).join('; ') || j?.errors?.[0]?.message || null;
    } catch (e) { err = String(e); }
  }
  // Even if Shopify refused, the voucher is cancelled on our side and the error is kept for the owner.
  await db.from('vouchers').update({ status: 'cancelled', gift_card_error: err ? `NOT deactivated (${why}): ${err}`.slice(0, 300) : `deactivated: ${why}` }).eq('code', code);
  return !err;
}
async function reverseVouchers(o: any, topic: string) {
  const orderId = String(topic === 'refunds/create' ? o.order_id : o.id);
  const ids = new Set<string>();
  const refundLines = topic === 'refunds/create' ? (o.refund_line_items ?? []) : [];
  if (refundLines.length) {
    // Only the voucher lines that were refunded (refunding the rice in the same order leaves the cards alone).
    for (const r of refundLines) if (tagOf(r.line_item) && CREDIT_VARIANT_IDS.has(String(r.line_item?.variant_id))) ids.add(String(tagOf(r.line_item)));
  } else {
    // A cancel, or a refund of an amount with no lines: every voucher batch this order paid for (fail closed).
    const { data: row } = await db.from('shopify_orders').select('payload').eq('shopify_id', orderId).maybeSingle();
    for (const li of row?.payload?.line_items ?? o.line_items ?? []) if (tagOf(li) && CREDIT_VARIANT_IDS.has(String(li.variant_id))) ids.add(String(tagOf(li)));
  }
  const why = topic === 'refunds/create' ? 'order refunded' : 'order cancelled';
  const out: any[] = [];
  for (const batchId of ids) {
    await db.from('voucher_batches').update({ reversed_at: new Date().toISOString(), reversed_reason: `${why} (Shopify order ${orderId})` }).eq('id', batchId).is('reversed_at', null);
    const { data: vs } = await db.from('vouchers').select('code, gift_card_id').eq('batch_id', batchId).neq('status', 'cancelled');
    let off = 0, failed = 0;
    for (const v of vs ?? []) (await deactivateCard(v.code, v.gift_card_id, why)) ? off++ : failed++;
    out.push({ batchId, off, failed });
  }
  if (out.length) await db.from('event_log').insert({ at: new Date().toISOString(), type: 'voucher_reversed', order_id: orderId, data: { topic, batches: out } });
  return { vouchersReversed: out };
}

// Each paid voucher becomes a real Shopify gift card (code = voucher code without dashes).
// Needs app_secrets.shopify_admin_token (custom app with write_gift_cards). Without it nothing happens.
// Shopify Admin access: a Dev Dashboard app (client credentials grant, token valid 24 h),
// or an older admin-created app's fixed token. Secrets live only in app_secrets.
let adminTokenCache: { token: string; until: number } | null = null;
async function shopifyAdminToken(): Promise<string | null> {
  const fixed = await secret('shopify_admin_token');
  if (fixed && !fixed.startsWith('PASTE')) return fixed;
  if (adminTokenCache && Date.now() < adminTokenCache.until) return adminTokenCache.token;
  const id = await secret('shopify_client_id'), sec = await secret('shopify_client_secret');
  if (!id || !sec || id.startsWith('PASTE') || sec.startsWith('PASTE')) return null;
  const res = await fetch(`${STORE}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: sec }) });
  if (!res.ok) { console.error('shopify token', res.status); return null; }
  const j = await res.json();
  adminTokenCache = { token: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in ?? 86400) - 600) * 1000 };
  return adminTokenCache.token;
}

// Shopify gift card code: company prefix + random characters, 16 long (~65+ bits), so bots guessing
// codes at checkout ("card cracking") have no realistic chance. The short voucher code stays a label only.
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function strongGiftCode(voucherCode: string) {
  const prefix = String(voucherCode).split('-')[0].replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 3);
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += CODE_ALPHA[b % 32];
  return (prefix + s).slice(0, 16);
}

async function issueGiftCards(batchId: string) {
  const token = await shopifyAdminToken();
  if (!token) return { issued: 0, reason: 'no Shopify access yet' };
  const { data: b } = await db.from('voucher_batches').select('id, company, budget_php, paid, reversed_at').eq('id', batchId).maybeSingle();
  if (!b?.paid) return { issued: 0, reason: 'not paid' };
  if (b.reversed_at) return { issued: 0, reason: 'refunded or cancelled' };
  const { data: vs } = await db.from('vouchers').select('code').eq('batch_id', batchId).is('gift_card_id', null).neq('status', 'cancelled');
  let issued = 0;
  for (const v of vs ?? []) {
    // Claim the voucher first, so two runs at the same moment can never make two gift cards for it.
    const { data: claim } = await db.from('vouchers').update({ gift_card_id: 'claim:' + newToken().slice(0, 12) }).eq('code', v.code).is('gift_card_id', null).neq('status', 'cancelled').select('code');
    if (!claim?.length) continue;
    const code = strongGiftCode(v.code);
    try {
      const res = await fetch(`${STORE}/admin/api/2026-10/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query: 'mutation($i: GiftCardCreateInput!) { giftCardCreate(input: $i) { giftCard { id } userErrors { field message } } }',
          variables: { i: { initialAmount: { amount: String(b.budget_php), currencyCode: 'PHP' }, code, note: `888 company voucher ${v.code} · ${b.company}` } } }) });
      const j = await res.json();
      const id = j?.data?.giftCardCreate?.giftCard?.id;
      const err = j?.data?.giftCardCreate?.userErrors?.map((e: any) => e.message).join('; ') || j?.errors?.[0]?.message || (res.ok ? '' : `HTTP ${res.status}`);
      if (id) { await db.from('vouchers').update({ gift_card_id: id, gift_card_code: code, gift_card_error: null }).eq('code', v.code); issued++; }
      else await db.from('vouchers').update({ gift_card_id: null, gift_card_error: String(err).slice(0, 300) }).eq('code', v.code);
    } catch (e) { await db.from('vouchers').update({ gift_card_id: null, gift_card_error: String(e).slice(0, 300) }).eq('code', v.code); }
  }
  return { issued };
}

// Today's rate: pesos per 1 unit of the buyer's currency (cached for an hour).
const fxCache = new Map<string, { at: number; rate: number }>();
async function phpPer(cur: string) {
  if (cur === 'PHP') return 1;
  const hit = fxCache.get(cur);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.rate;
  const k = cur.toLowerCase();
  // Two independent copies of the free rate feed. If both answer they must agree within 5%,
  // so one tampered or broken copy can't make gift cards sell at the wrong price.
  const rates: number[] = [];
  for (const u of [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${k}.json`, `https://latest.currency-api.pages.dev/v1/currencies/${k}.json`]) {
    try { const j = await (await fetch(u)).json(); const r = Number(j?.[k]?.php); if (r > 0) rates.push(r); } catch { /* try next */ }
  }
  if (!rates.length) throw new Error('No exchange rate for ' + cur);
  if (rates.length === 2 && Math.abs(rates[0] - rates[1]) / Math.min(rates[0], rates[1]) > 0.05) {
    console.error('fx sources disagree', cur, rates);
    throw new Error('Exchange rate sources disagree for ' + cur);
  }
  const rate = rates.length === 2 ? (rates[0] + rates[1]) / 2 : rates[0];
  fxCache.set(cur, { at: Date.now(), rate });
  return rate;
}

async function makeBatch(body: any, opts: { source: string; budgetPhp: number; delivery: number; buyer?: any; currency?: string; amount?: number; rate?: number; budgetNzd?: number | null }) {
  const budgetPhp = opts.budgetPhp;
  const pack = buildPack(budgetPhp - opts.delivery, await packItems());
  if (!pack.lines.length) return { error: 'Could not make a pack for that value.' };
  const id = `B-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${newToken().slice(0, 4).toUpperCase()}`;
  const qty = Number(body.qty);
  const manage = opts.source === 'self' ? newToken() : null;
  const { error } = await db.from('voucher_batches').insert({ id, company: String(body.company).trim().slice(0, 80), logo: body.logo || null,
    greeting: String(body.greeting ?? '').slice(0, 600), sign_off: String(body.signOff ?? '').slice(0, 120),
    budget_nzd: opts.budgetNzd ?? null, nzd_to_php: opts.currency === 'NZD' ? opts.rate : null, delivery_php: opts.delivery, budget_php: budgetPhp,
    currency: opts.currency ?? 'NZD', amount_local: opts.amount ?? null, php_rate: opts.rate ?? null, design: designOf(body.design),
    pack, qty, note: String(body.note ?? '').slice(0, 300), source: opts.source,
    buyer_name: opts.buyer?.name ?? null, buyer_email: opts.buyer?.email ?? null, manage_token: manage, total_php: budgetPhp * qty });
  if (error) throw error;
  const staff = Array.isArray(body.staff) ? body.staff : [];
  const prefix = prefixFor(body.company);
  const rows = [];
  for (let i = 0; i < qty; i++) {
    const s = staff[i] ?? {};
    rows.push({ code: voucherCode(prefix, crypto.getRandomValues(new Uint8Array(6))), token: newToken(), batch_id: id,
      staff_name: String(s.name ?? '').slice(0, 80) || null, staff_contact: String(s.contact ?? '').slice(0, 120) || null });
  }
  const { error: e2 } = await db.from('vouchers').insert(rows);
  if (e2) { await db.from('voucher_batches').delete().eq('id', id); throw e2; }
  return { id, manage, budgetPhp, totalPhp: budgetPhp * qty };
}

async function onVoucherBuy(req: Request) {
  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  const body = await req.json();
  const delivery = VOUCHER_DEFAULTS.deliveryPhp;
  const currency = String(body.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return json({ ok: false, reason: 'Choose your currency.' });
  let rate: number;
  try { rate = await phpPer(currency); } catch { return json({ ok: false, reason: `We can't take ${currency} right now. Please choose another currency.` }); }
  const v: any = voucherPhp(body.amount, rate);
  if (v.error) return json({ ok: false, reason: v.error });
  if (body.act === 'preview') {
    const pc = packForCard(v.php, await packItems());
    return json({ ok: true, currency, amount: Number(body.amount), rate, budgetPhp: v.php, deliveryPhp: pc.shipPhp, pack: publicPack(pc.pack) });
  }
  if (body.act !== 'create') return json({ ok: false, reason: 'Unknown action' });
  const err = validateSelf({ ...body, currency });
  if (err) return json({ ok: false, reason: err });
  // Logo: only a PNG/JPEG/WebP picture, at most ~300 KB.
  if (body.logo != null && body.logo !== '' && !(typeof body.logo === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body.logo) && body.logo.length <= 400_000))
    return json({ ok: false, reason: 'Please use a PNG or JPG logo under 300 KB.' });
  // A brake on floods of unpaid orders from many emails: at most 40 unpaid self-service orders per hour in total.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count: recent } = await db.from('voucher_batches').select('id', { count: 'exact', head: true }).eq('source', 'self').eq('paid', false).gte('created_at', hourAgo);
  if ((recent ?? 0) >= 40) return json({ ok: false, reason: 'We are getting a lot of orders right now. Please try again in a few minutes, or contact us.' });
  const c: any = cleanBuyer(body.buyer);
  if (c.error) return json({ ok: false, reason: c.error });
  // A little brake on abuse: at most 8 unpaid orders per email per day.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from('voucher_batches').select('id', { count: 'exact', head: true }).eq('buyer_email', c.buyer.email).eq('paid', false).gte('created_at', since);
  if ((count ?? 0) >= 8) return json({ ok: false, reason: 'You have several unpaid voucher orders already. Please finish one, or contact us.' });
  const ship = packForCard(v.php, await packItems()).shipPhp;
  const made: any = await makeBatch(body, { source: 'self', budgetPhp: v.php, delivery: ship, buyer: c.buyer, currency, amount: Number(body.amount), rate,
    budgetNzd: currency === 'NZD' ? Number(body.amount) : null });
  if (made.error) return json({ ok: false, reason: made.error });
  const items = splitAmount(made.totalPhp).map((s) => ({ id: CREDIT_VARIANTS[s.denom], quantity: s.qty, properties: { [BATCH_PROP]: made.id } }));
  return json({ ok: true, batchId: made.id, manageToken: made.manage, budgetPhp: made.budgetPhp, totalPhp: made.totalPhp, currency, amount: Number(body.amount), items });
}

async function onVoucherManage(req: Request, url: URL) {
  const body = req.method === 'POST' ? await req.json() : {};
  const m = body.m ?? url.searchParams.get('m');
  if (!m || m.length < 20) return json({ error: 'This voucher page link is not valid.' }, 404);
  const { data: b } = await db.from('voucher_batches').select('*').eq('manage_token', m).maybeSingle();
  if (!b) return json({ error: 'This voucher page link is not valid.' }, 404);
  const now = Date.now();
  if (req.method === 'POST') {
    const owns = async (code: string) => { const { data } = await db.from('vouchers').select('code').eq('code', code).eq('batch_id', b.id).maybeSingle(); return !!data; };
    if (!(await owns(String(body.code)))) return json({ ok: false, reason: 'Not one of your vouchers.' });
    if (body.act === 'staff') {
      await db.from('vouchers').update({ staff_name: String(body.name ?? '').slice(0, 80) || null, staff_contact: String(body.contact ?? '').slice(0, 120) || null }).eq('code', body.code);
    } else if (body.act === 'newLink') {
      const { data } = await db.from('vouchers').update({ token: newToken(), opened_at: null }).eq('code', body.code).eq('status', 'issued').select('code');
      if (!data?.length) return json({ ok: false, reason: 'Only unused vouchers can get a new link.' });
    } else return json({ ok: false, reason: 'Unknown action' });
  }
  const { data: vs } = await db.from('vouchers').select('code, token, staff_name, staff_contact, status, issued_at, opened_at, redeemed_at, recipient, gift_card_code').eq('batch_id', b.id).order('created_at');
  return json({
    ok: true,
    batch: { id: b.id, company: b.company, logo: b.logo, greeting: b.greeting, signOff: b.sign_off, budgetNzd: b.budget_nzd, currency: b.currency, amountLocal: b.amount_local, budgetPhp: b.budget_php, design: b.design ?? 'christmas',
      qty: b.qty, totalPhp: b.total_php, paid: b.paid, paidAt: b.paid_at, order: b.shopify_order, pack: publicPack(b.pack) },
    vouchers: (vs ?? []).map((v: any) => {
      const state = voucherState(v, b, now);
      return { code: v.code, giftCode: v.gift_card_code ?? null, token: state === 'redeemed' ? null : v.token, staff: v.staff_name, contact: v.staff_contact,
        state, opened: !!v.opened_at, sentTo: v.recipient ? `${v.recipient.name}, ${v.recipient.city}` : null, sentAt: v.redeemed_at };
    }),
  });
}

// ---------- Supplier price lists ----------
// Suppliers open a private link (?t=token) and enter what they charge 888 for each single item.
// Packages are built from items, so only single items are listed. Suppliers never see our selling
// prices or each other's prices. The owner (x-admin-key) compares every supplier per item.
const NOT_SINGLE = new Set(['Essentials Bundle', 'Gift Pack', 'Gift Voucher']);
async function singleItems() {
  const { data } = await db.from('shop_catalog_cache').select('products').eq('id', 1).maybeSingle();
  const out: any[] = [];
  for (const p of data?.products ?? []) {
    if (NOT_SINGLE.has(p.product_type) || (p.tags ?? []).some((t: string) => /^package$/i.test(t))) continue;
    for (const v of p.variants ?? []) {
      out.push({
        variantId: String(v.id), sku: v.sku ?? '', group: p.product_type || 'Other',
        title: p.title + (p.variants.length > 1 && v.title && v.title !== 'Default Title' ? ` – ${v.title}` : ''),
        image: (p.images?.find((i: any) => (i.variant_ids ?? []).includes(v.id)) ?? p.images?.[0])?.src ?? null,
        sellPrice: Number(v.price) || null,
      });
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
}
const priceOf = (x: unknown) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Math.round(Number(String(x).replace(/[₱,\s]/g, '')) * 100) / 100;
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : NaN;
};

async function onSupplier(req: Request, url: URL) {
  const body = req.method === 'POST' ? await req.json() : {};
  const token = String(body.t ?? url.searchParams.get('t') ?? '');
  if (!/^[0-9a-f]{40}$/.test(token)) return json({ error: 'This link is not valid. Ask 888 for a new one.' }, 403);
  const { data: s } = await db.from('suppliers').select('id, name, location, active').eq('token_hash', await sha256(token)).maybeSingle();
  if (!s || !s.active) return json({ error: 'This link is not valid. Ask 888 for a new one.' }, 403);
  const items = await singleItems();
  if (req.method === 'POST') {
    const known = new Set(items.map((i) => i.variantId));
    const changes = (Array.isArray(body.prices) ? body.prices : []).slice(0, 1000);
    const bad = changes.filter((c: any) => !known.has(String(c.variantId)) || Number.isNaN(priceOf(c.price)));
    if (bad.length) return json({ error: 'Some prices are not valid numbers. Please check them.', bad: bad.map((c: any) => String(c.variantId)) }, 400);
    const { data: before } = await db.from('supplier_prices').select('variant_id, price_php').eq('supplier_id', s.id);
    const old = new Map((before ?? []).map((r: any) => [r.variant_id, Number(r.price_php)]));
    const log: any[] = [], up: any[] = [], del: string[] = [];
    const at = new Date().toISOString();
    for (const c of changes) {
      const v = String(c.variantId), p = priceOf(c.price) as number | null, o = old.get(v) ?? null;
      if (p === o) continue;
      if (p === null) del.push(v); else up.push({ supplier_id: s.id, variant_id: v, price_php: p, updated_at: at });
      log.push({ supplier_id: s.id, variant_id: v, old_php: o, new_php: p });
    }
    if (up.length) { const { error } = await db.from('supplier_prices').upsert(up); if (error) throw error; }
    if (del.length) await db.from('supplier_prices').delete().eq('supplier_id', s.id).in('variant_id', del);
    if (log.length) await db.from('supplier_price_log').insert(log);
    await db.from('suppliers').update({ last_seen_at: at }).eq('id', s.id);
    return json({ ok: true, saved: log.length });
  }
  await db.from('suppliers').update({ last_seen_at: new Date().toISOString() }).eq('id', s.id);
  const { data: mine } = await db.from('supplier_prices').select('variant_id, price_php, updated_at').eq('supplier_id', s.id);
  return json({
    supplier: { name: s.name, location: s.location },
    items: items.map(({ sellPrice, ...i }) => i), // never show our selling price to a supplier
    prices: Object.fromEntries((mine ?? []).map((r: any) => [r.variant_id, { price: Number(r.price_php), at: r.updated_at }])),
  });
}

async function onSupplierAdmin(req: Request, url: URL) {
  if (!same(req.headers.get('x-admin-key'), await secret('admin_key'))) return json({ error: 'Wrong admin key' }, 403);
  if (req.method === 'POST') {
    const b = await req.json();
    const clean = (x: unknown, n = 80) => (typeof x === 'string' ? x.trim().slice(0, n) : '') || null;
    if (b.act === 'addSupplier') {
      const name = clean(b.name);
      if (!name) return json({ error: 'Enter the supplier name.' }, 400);
      const token = newToken();
      const { data, error } = await db.from('suppliers').insert({ name, location: clean(b.location), contact: clean(b.contact, 120), token_hash: await sha256(token), link_token: token }).select('id').single();
      if (error) throw error;
      return json({ ok: true, id: data.id, token });
    }
    if (b.act === 'newLink') {
      const token = newToken();
      const { error } = await db.from('suppliers').update({ token_hash: await sha256(token), link_token: token }).eq('id', String(b.id));
      if (error) throw error;
      return json({ ok: true, token });
    }
    if (b.act === 'editSupplier') {
      const name = clean(b.name);
      if (!name) return json({ error: 'Enter the supplier name.' }, 400);
      await db.from('suppliers').update({ name, location: clean(b.location), contact: clean(b.contact, 120), active: b.active !== false }).eq('id', String(b.id));
      return json({ ok: true });
    }
    if (b.act === 'prefer') {
      const v = String(b.variantId ?? '');
      if (!b.supplierId) await db.from('preferred_supplier').delete().eq('variant_id', v);
      else await db.from('preferred_supplier').upsert({ variant_id: v, supplier_id: String(b.supplierId), chosen_at: new Date().toISOString() });
      return json({ ok: true });
    }
    return json({ error: 'Unknown action' }, 400);
  }
  if (url.searchParams.get('log')) {
    const { data } = await db.from('supplier_price_log').select('supplier_id, variant_id, old_php, new_php, at').order('id', { ascending: false }).limit(200);
    return json({ log: data ?? [] });
  }
  const [items, sup, pr, pref] = await Promise.all([
    singleItems(),
    db.from('suppliers').select('id, name, location, contact, active, created_at, last_seen_at, link_token').order('created_at'),
    db.from('supplier_prices').select('supplier_id, variant_id, price_php, updated_at'),
    db.from('preferred_supplier').select('variant_id, supplier_id'),
  ]);
  return json({
    items, suppliers: sup.data ?? [],
    prices: (pr.data ?? []).map((r: any) => ({ s: r.supplier_id, v: r.variant_id, p: Number(r.price_php), at: r.updated_at })),
    preferred: Object.fromEntries((pref.data ?? []).map((r: any) => [r.variant_id, r.supplier_id])),
  });
}

// Helper page for staff (Janet): name each supplier slot and copy its invite link. Its own secret link
// (?k=…, hash in app_secrets.supplier_helper_hash). It can rename and add suppliers, nothing else:
// no prices, no switching off, no admin.
async function onSupplierHelper(req: Request, url: URL) {
  const body = req.method === 'POST' ? await req.json() : {};
  const k = String(body.k ?? url.searchParams.get('k') ?? '');
  if (!/^[0-9a-f]{40}$/.test(k) || !same(await sha256(k), await secret('supplier_helper_hash'))) return json({ error: 'This link is not valid. Ask 888 for a new one.' }, 403);
  const clean = (x: unknown, n = 80) => (typeof x === 'string' ? x.trim().slice(0, n) : '') || null;
  if (req.method === 'POST') {
    if (body.act === 'rename') {
      const name = clean(body.name);
      if (!name) return json({ error: 'Type the shop name first.' }, 400);
      const { data } = await db.from('suppliers').update({ name, location: clean(body.location), contact: clean(body.contact, 120) }).eq('id', String(body.id)).eq('active', true).select('id');
      if (!data?.length) return json({ error: 'This supplier is switched off.' }, 400);
    } else if (body.act === 'add') {
      const { count } = await db.from('suppliers').select('id', { count: 'exact', head: true });
      if ((count ?? 0) >= 100) return json({ error: 'Too many suppliers. Ask 888.' }, 400);
      const token = newToken();
      await db.from('suppliers').insert({ name: `Supplier ${(count ?? 0) + 1}`, token_hash: await sha256(token), link_token: token });
    } else return json({ error: 'Unknown action' }, 400);
  }
  const [items, sup, pr] = await Promise.all([
    singleItems(),
    db.from('suppliers').select('id, name, location, contact, last_seen_at, link_token').eq('active', true).order('created_at'),
    db.from('supplier_prices').select('supplier_id'),
  ]);
  const n = new Map<string, number>();
  for (const r of pr.data ?? []) n.set(r.supplier_id, (n.get(r.supplier_id) ?? 0) + 1);
  return json({ total: items.length, suppliers: (sup.data ?? []).map((s: any) => ({ ...s, priced: n.get(s.id) ?? 0 })) });
}

// ---------- Product list copy ----------
// Shopify answers 429 to products.json from Supabase's network (both addresses, since 24-25 Nov), so the
// copy in shop_catalog_cache is refreshed through the Storefront API instead (Admin API as a fallback).
// pg_cron calls this every 10 minutes (x-cron-key).
async function onCatalogRefresh(req: Request) {
  if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return json({ error: 'no' }, 403);
  const products = await freshProducts();
  if (!products?.length) return json({ ok: false, reason: 'Shopify product list unavailable' });
  await db.from('shop_catalog_cache').update({ products, fetched_at: new Date().toISOString(), last_status: 200 }).eq('id', 1);
  productCache = null;
  const shippable = products.flatMap((p: any) => p.product_type === 'Gift Voucher' ? [] : p.variants);
  const missing = shippable.filter((v: any) => !catalog.byVariant.has(String(v.id))).map((v: any) => v.sku || v.id);
  return json({ ok: true, products: products.length, notInDispatchCatalogue: missing });
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
    if (path === '/lazada' && req.method === 'POST') return await onLazada(req);
    if (path === '/catalog-refresh' && req.method === 'POST') return await onCatalogRefresh(req);
    if (path === '/shop') return await onShop(req, url);
    if (path === '/admin') return await onAdmin(req, url);
    if (path === '/voucher') return await onVoucher(req, url);
    if (path === '/vadmin') return await onVoucherAdmin(req, url);
    if (path === '/vbuy') return await onVoucherBuy(req);
    if (path === '/vmanage') return await onVoucherManage(req, url);
    if (path === '/supplier') return await onSupplier(req, url);
    if (path === '/sadmin') return await onSupplierAdmin(req, url);
    if (path === '/sinvite') return await onSupplierHelper(req, url);
    if (path === '/health') return json({ ok: true, at: new Date().toISOString() });
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
