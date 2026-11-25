// Lazada Open Platform sign-in for the 888 Grocery shop (Supabase Edge Function "lazada-auth", verify_jwt off).
//   GET  /lazada-auth             -> sends the owner to Lazada's "Authorize" page for app 144841
//   GET  /lazada-auth?code=...    -> Lazada sends the owner back here; we swap the code for shop tokens
//   POST /lazada-auth/refresh     -> daily from pg_cron (x-cron-key): renews the access token before it runs out
//   POST /lazada-auth/fulfil      -> from the dispatch "api" function only (x-cron-key): pack / shipping label / ready to ship
// The App Secret lives only in app_secrets.lazada_app_secret (pasted by the owner). Tokens are kept in
// public.lazada_tokens (RLS on, no policies: only the service role can read them) and never shown on a page.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP_KEY = '144841';
const AUTH = 'https://auth.lazada.com/rest';
const SELF = 'https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/lazada-auth';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function secret(name: string): Promise<string | null> {
  const { data } = await db.from('app_secrets').select('value').eq('name', name).maybeSingle();
  return data?.value ?? null;
}
const same = (a: string | null, b: string | null) => {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0;
};

// Lazada signature: HMAC-SHA256(secret, apiPath + key1value1key2value2... sorted by key), upper-case hex.
export async function lazadaSign(appSecret: string, path: string, params: Record<string, string>) {
  const base = path + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function callAuth(path: string, extra: Record<string, string>) {
  const appSecret = await secret('lazada_app_secret');
  if (!appSecret) throw new Error('missing_secret');
  const params: Record<string, string> = { app_key: APP_KEY, timestamp: String(Date.now()), sign_method: 'sha256', ...extra };
  params.sign = await lazadaSign(appSecret, path, params);
  const res = await fetch(AUTH + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(params) });
  const out = await res.json().catch(() => ({}));
  if (!out.access_token) throw new Error(`lazada_${out.code ?? res.status}: ${out.message ?? 'no token'}`);
  return out;
}

// Signed call to the Philippines Lazada API with the saved shop token (GET for reads, POST for the shipping steps).
async function callApi(path: string, extra: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
  const appSecret = await secret('lazada_app_secret');
  const { data: tok } = await db.from('lazada_tokens').select('access_token').eq('id', 1).maybeSingle();
  if (!appSecret || !tok?.access_token) throw new Error('not_connected');
  const params: Record<string, string> = { app_key: APP_KEY, timestamp: String(Date.now()), sign_method: 'sha256', access_token: tok.access_token, ...extra };
  params.sign = await lazadaSign(appSecret, path, params);
  const res = method === 'GET'
    ? await fetch('https://api.lazada.com.ph/rest' + path + '?' + new URLSearchParams(params))
    : await fetch('https://api.lazada.com.ph/rest' + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams(params) });
  const out = await res.json().catch(() => ({}));
  if (out.code && out.code !== '0') throw new Error(`lazada_${out.code}: ${out.message ?? ''}`);
  return out;
}

async function save(t: any) {
  const now = Date.now();
  const row = {
    id: 1, access_token: t.access_token, refresh_token: t.refresh_token, account: t.account ?? null,
    country: t.country ?? null, seller_info: t.country_user_info ?? null,
    expires_at: new Date(now + Number(t.expires_in ?? 0) * 1000).toISOString(),
    refresh_expires_at: new Date(now + Number(t.refresh_expires_in ?? 0) * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  const { error } = await db.from('lazada_tokens').upsert(row);
  if (error) throw new Error('save_failed: ' + error.message);
  return row;
}

// Supabase serves function responses on *.supabase.co as plain text (no HTML), so the result is plain text.
const esc = (s: string) => s;
const page = (title: string, body: string, status = 200) => new Response(
  `${title}\n\n${body.replace(/<\/?b>/g, '')}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (req.method === 'POST' && url.pathname.endsWith('/refresh')) {
      if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return new Response('forbidden', { status: 403 });
      const { data: cur } = await db.from('lazada_tokens').select('refresh_token, expires_at').eq('id', 1).maybeSingle();
      if (!cur?.refresh_token) return Response.json({ ok: false, reason: 'not_authorized_yet' });
      // renew when less than 2 days are left
      if (Date.parse(cur.expires_at) - Date.now() > 2 * 86400e3) return Response.json({ ok: true, renewed: false, expires_at: cur.expires_at });
      const row = await save(await callAuth('/auth/token/refresh', { refresh_token: cur.refresh_token }));
      return Response.json({ ok: true, renewed: true, expires_at: row.expires_at });
    }
    // Read-only product list (name, SKU, price, sale price, stock) for planning campaigns. x-cron-key only.
    if (req.method === 'POST' && url.pathname.endsWith('/products')) {
      if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return new Response('forbidden', { status: 403 });
      const out: unknown[] = [];
      for (let offset = 0; offset < 1000; offset += 50) {
        const r = await callApi('/products/get', { filter: 'all', offset: String(offset), limit: '50' });
        const prods = r?.data?.products ?? [];
        for (const p of prods) for (const s of p.skus ?? []) out.push({
          item_id: p.item_id, status: p.status, name: p.attributes?.name, seller_sku: s.SellerSku, sku_id: s.SkuId,
          price: Number(s.price), special_price: s.special_price != null ? Number(s.special_price) : null,
          special_from: s.special_from_date ?? null, special_to: s.special_to_date ?? null, quantity: s.quantity, sku_status: s.Status,
        });
        if (prods.length < 50) break;
      }
      return Response.json({ ok: true, count: out.length, skus: out });
    }
    // Every 5 minutes from pg_cron: orders created or changed in the last 2 days -> the dispatch "api" function.
    // It ignores orders whose Lazada status hasn't changed, so reading the same orders again is harmless.
    if (req.method === 'POST' && url.pathname.endsWith('/orders-sync')) {
      const key = await secret('cron_key');
      if (!same(req.headers.get('x-cron-key'), key)) return new Response('forbidden', { status: 403 });
      const since = new Date(Date.now() - 2 * 86400e3).toISOString().replace(/\.\d{3}Z$/, '+00:00');
      const orders: any[] = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const r = await callApi('/orders/get', { update_after: since, sort_by: 'updated_at', sort_direction: 'DESC', limit: '100', offset: String(offset) });
        const list = r?.data?.orders ?? [];
        orders.push(...list);
        if (list.length < 100) break;
      }
      const out: any[] = [];
      for (let i = 0; i < orders.length; i += 50) {
        const ids = orders.slice(i, i + 50).map((o) => o.order_id);
        const r = await callApi('/orders/items/get', { order_ids: JSON.stringify(ids) });
        const byId = new Map((r?.data ?? []).map((x: any) => [String(x.order_id), x.order_items ?? []]));
        for (const o of orders.slice(i, i + 50)) out.push({ order: o, items: byId.get(String(o.order_id)) ?? [] });
      }
      if (!out.length) return Response.json({ ok: true, orders: 0 });
      const res = await fetch('https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/api/lazada', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-key': key! }, body: JSON.stringify({ orders: out }) });
      return Response.json({ ok: res.ok, orders: out.length, dispatch: await res.json().catch(() => null) });
    }
    // Read-only passthrough for planning (orders, order items, shipment providers). x-cron-key only.
    if (req.method === 'POST' && url.pathname.endsWith('/read')) {
      if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return new Response('forbidden', { status: 403 });
      const { path, params } = await req.json();
      const READ = ['/orders/get', '/order/get', '/order/items/get', '/shipment/providers/get', '/seller/get', '/seller/warehouse/get'];
      if (!READ.includes(path)) return Response.json({ ok: false, error: 'path not allowed' }, { status: 400 });
      return Response.json(await callApi(path, params ?? {}));
    }
    // Shipping steps, called only by the dispatch server (which checks who may ship which order).
    // Body: { path, body } where body is the documented request object for that path.
    if (req.method === 'POST' && url.pathname.endsWith('/fulfil')) {
      if (!same(req.headers.get('x-cron-key'), await secret('cron_key'))) return new Response('forbidden', { status: 403 });
      const { path, body } = await req.json();
      const PARAM: Record<string, string> = { '/order/fulfill/pack': 'packReq', '/order/package/document/get': 'getDocumentReq', '/order/package/rts': 'readyToShipReq' };
      if (!PARAM[path] || typeof body !== 'object') return Response.json({ ok: false, error: 'path not allowed' }, { status: 400 });
      const out = await callApi(path, { [PARAM[path]]: JSON.stringify(body) }, 'POST');
      console.log('lazada fulfil', path, JSON.stringify(out).slice(0, 400));
      return Response.json(out);
    }
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const code = url.searchParams.get('code');
    if (!code) {
      const go = new URL('https://api.lazada.com.ph/oauth/authorize');  // Philippines sign-in (auth.lazada.com defaults to Singapore)
      go.search = new URLSearchParams({ response_type: 'code', force_auth: 'true', redirect_uri: SELF, client_id: APP_KEY }).toString();
      return Response.redirect(go.toString(), 302);
    }
    const row = await save(await callAuth('/auth/token/create', { code }));
    const days = Math.round((Date.parse(row.refresh_expires_at) - Date.now()) / 86400e3);
    return page('Lazada shop connected ✅',
      `888 Grocery can now read and update the Lazada shop${row.account ? ` (<b>${esc(String(row.account))}</b>)` : ''}. ` +
      `The connection renews itself automatically; Lazada asks for a fresh Authorize in about ${days} days. You can close this page.`);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.error('lazada-auth', msg);
    if (msg === 'missing_secret') return page('One step first', 'The Lazada App Secret is not saved yet. Paste it into Supabase <b>app_secrets</b> as <b>lazada_app_secret</b>, then open this link again.', 400);
    if (/\/(products|read|orders-sync|fulfil)$/.test(url.pathname)) return Response.json({ ok: false, error: msg }, { status: 500 });
    return page('Lazada did not connect', `Lazada answered: ${esc(msg)}. Open this link again to retry; the sign-in code only works once and only for a few minutes.`, 400);
  }
});
