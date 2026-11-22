// 888 dispatch server (Supabase Edge Function "api"). Deployed with imports pinned to a commit of this repo.
//   POST /api/shopify          Shopify "order payment" webhook (signed)
//   POST /api/tick             every minute from pg_cron (x-cron-key)
//   GET/POST /api/shop         partner shop screen (secret link token)
//   GET/POST /api/admin        owner screen (x-admin-key)
//   GET/POST /api/voucher      company gift voucher welcome page (secret link)
//   GET/POST /api/vadmin       owner: company voucher batches (x-admin-key)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { Dispatcher } from './engine.js';
import { config as DEFAULT_CONFIG } from './config.js';
import { snapshot, restore, prune } from './store.js';
import { fromShopify, verifyShopify, PAYOUT } from './shopify.js';
import { buildCatalog } from './catalog.js';
import { locate } from './places.js';
import { shopView, adminView } from './views.js';
import { normalizePH, textsFor, manualText } from './sms.js';
import { itemsFromProducts, buildPack, priceBatch, validateBatch, voucherCode, prefixFor, voucherState, packDeadline,
  voucherPackage, cleanRecipient, forecast, VOUCHER_DEFAULTS, roundTo10, splitAmount, voucherPayments, cleanBuyer, BATCH_PROP, voucherPhp, validateSelf } from './vouchers.js';

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
  const res = await fetch(`${STORE}/products.json?limit=250`);
  if (!res.ok) throw new Error(`Shop catalogue ${res.status}`);
  const items = itemsFromProducts((await res.json()).products);
  productCache = { at: Date.now(), items };
  return items;
}
const publicPack = (pack: any) => ({ total: pack.total, kg: pack.kg, lines: pack.lines.map((l: any) => ({ title: l.title, qty: l.qty, image: l.image })) });

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
    greeting: b.greeting ?? '', signOff: b.sign_off ?? '', valuePhp: b.budget_php,
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
  const state = voucherState(v, b, now);
  if (state !== 'pack') return json({ ok: false, reason: state === 'redeemed' ? 'This gift has already been sent.' : state === 'credit' ? 'The pack time has ended, so this voucher is now shop credit. Please message 888 Grocery to use it.' : 'This voucher is not active yet.', view: voucherView(v, b, now) });
  const c: any = cleanRecipient(body.recipient);
  if (c.error) return json({ ok: false, reason: c.error });
  const r = c.recipient;
  // Claim it first, so two taps (or two people) can never send it twice.
  const { data: claimed } = await db.from('vouchers').update({ status: 'redeeming' }).eq('code', v.code).eq('status', 'issued').select('code');
  if (!claimed?.length) return json({ ok: false, reason: 'This gift has already been sent.' });
  try {
    const ref = `V-${v.code}`;
    const recipient = { name: r.name, phone: r.phone, address: [r.address, r.barangay].filter(Boolean).join(', '), city: r.city, province: r.province, zip: r.zip };
    const result: any = await withState(({ d, extra }) => {
      const pkg = voucherPackage(v.code, b, extra.payout);
      const lines = [{ title: `${b.company} gift pack (voucher ${v.code})`, qty: 1 }];
      const orderExtra = { ref, voucher: v.code, company: b.company, recipient, buyer: { country: b.company }, note: r.note, lines };
      const where = locate({ city: r.city, province: r.province });
      if (!where) {
        const m = { id: `M-${ref}`, ref, paidAt: now, reason: `Gift voucher: couldn't place the address (${r.city}, ${r.province})`, recipient, buyer: orderExtra.buyer, note: r.note,
          items: pkg.items.map((i: any) => ({ title: i.name, qty: i.qty })), status: 'todo' };
        extra.manual = [...(extra.manual ?? []), m];
        return { manual: m.id, ownerText: manualText(m, extra.ownerPhone) };
      }
      if (d.orders.has(ref)) return { exists: ref };
      d.packages.set(pkg.id, pkg);
      d.placeOrder({ id: ref, packageId: pkg.id, qty: 1, address: { lat: where.lat, lng: where.lng, island: where.island }, paidAt: now,
        extra: { ...orderExtra, locatedBy: where.source, shopifyId: null } });
      return { dispatched: ref };
    });
    if (result.ownerText) { try { await sendTexts([result.ownerText]); } catch (e) { console.error('sms', e); } }
    const at = new Date().toISOString();
    await db.from('vouchers').update({ status: 'redeemed', redeemed_at: at, order_ref: ref, recipient: r }).eq('code', v.code);
    return json({ ok: true, view: voucherView({ ...v, status: 'redeemed', redeemed_at: at, recipient: r }, b, Date.now()) });
  } catch (e) {
    await db.from('vouchers').update({ status: 'issued' }).eq('code', v.code).eq('status', 'redeeming');
    throw e;
  }
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
        pack, qty: Number(body.qty), note: String(body.note ?? '').slice(0, 300) });
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
      const { data } = await db.from('voucher_batches').update({ paid: true, paid_at: at }).eq('id', body.batchId).eq('paid', false).select('id');
      if (data?.length) await db.from('vouchers').update({ issued_at: at }).eq('batch_id', body.batchId).is('issued_at', null);
      return json({ ok: true });
    }
    case 'editBatch': {
      const patch: any = {};
      if (typeof body.greeting === 'string') patch.greeting = body.greeting.slice(0, 600);
      if (typeof body.signOff === 'string') patch.sign_off = body.signOff.slice(0, 120);
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
      await db.from('vouchers').update({ status: 'cancelled' }).eq('code', body.code).eq('status', 'issued');
      return json({ ok: true });
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

async function payVoucherBatches(o: any) {
  const paid = voucherPayments(o);
  for (const [batchId, amount] of paid) {
    const { data: b } = await db.from('voucher_batches').select('id, paid, total_php, paid_php').eq('id', batchId).maybeSingle();
    if (!b || b.paid) continue;
    const sum = Number(b.paid_php ?? 0) + amount;
    const full = sum + 0.5 >= Number(b.total_php);
    const at = new Date().toISOString();
    await db.from('voucher_batches').update({ paid_php: sum, shopify_order: String(o.name ?? o.id), ...(full ? { paid: true, paid_at: at } : {}) }).eq('id', batchId);
    if (full) await db.from('vouchers').update({ issued_at: at }).eq('batch_id', batchId).is('issued_at', null);
  }
}

// Today's rate: pesos per 1 unit of the buyer's currency (cached for an hour).
const fxCache = new Map<string, { at: number; rate: number }>();
async function phpPer(cur: string) {
  if (cur === 'PHP') return 1;
  const hit = fxCache.get(cur);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.rate;
  const k = cur.toLowerCase();
  for (const u of [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${k}.json`, `https://latest.currency-api.pages.dev/v1/currencies/${k}.json`]) {
    try { const j = await (await fetch(u)).json(); const r = Number(j?.[k]?.php); if (r > 0) { fxCache.set(cur, { at: Date.now(), rate: r }); return r; } } catch { /* try next */ }
  }
  throw new Error('No exchange rate for ' + cur);
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
    currency: opts.currency ?? 'NZD', amount_local: opts.amount ?? null, php_rate: opts.rate ?? null,
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
    return json({ ok: true, currency, amount: Number(body.amount), rate, budgetPhp: v.php, deliveryPhp: delivery, pack: publicPack(buildPack(v.php - delivery, await packItems())) });
  }
  if (body.act !== 'create') return json({ ok: false, reason: 'Unknown action' });
  const err = validateSelf({ ...body, currency });
  if (err) return json({ ok: false, reason: err });
  const c: any = cleanBuyer(body.buyer);
  if (c.error) return json({ ok: false, reason: c.error });
  // A little brake on abuse: at most 8 unpaid orders per email per day.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from('voucher_batches').select('id', { count: 'exact', head: true }).eq('buyer_email', c.buyer.email).eq('paid', false).gte('created_at', since);
  if ((count ?? 0) >= 8) return json({ ok: false, reason: 'You have several unpaid voucher orders already. Please finish one, or contact us.' });
  const made: any = await makeBatch(body, { source: 'self', budgetPhp: v.php, delivery, buyer: c.buyer, currency, amount: Number(body.amount), rate,
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
  const { data: vs } = await db.from('vouchers').select('code, token, staff_name, staff_contact, status, issued_at, opened_at, redeemed_at, recipient').eq('batch_id', b.id).order('created_at');
  return json({
    ok: true,
    batch: { id: b.id, company: b.company, logo: b.logo, greeting: b.greeting, signOff: b.sign_off, budgetNzd: b.budget_nzd, currency: b.currency, amountLocal: b.amount_local, budgetPhp: b.budget_php,
      qty: b.qty, totalPhp: b.total_php, paid: b.paid, paidAt: b.paid_at, order: b.shopify_order, pack: publicPack(b.pack) },
    vouchers: (vs ?? []).map((v: any) => {
      const state = voucherState(v, b, now);
      return { code: v.code, token: state === 'redeemed' ? null : v.token, staff: v.staff_name, contact: v.staff_contact,
        state, opened: !!v.opened_at, sentTo: v.recipient ? `${v.recipient.name}, ${v.recipient.city}` : null, sentAt: v.redeemed_at };
    }),
  });
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
    if (path === '/voucher') return await onVoucher(req, url);
    if (path === '/vadmin') return await onVoucherAdmin(req, url);
    if (path === '/vbuy') return await onVoucherBuy(req);
    if (path === '/vmanage') return await onVoucherManage(req, url);
    if (path === '/health') return json({ ok: true, at: new Date().toISOString() });
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
