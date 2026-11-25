// Lazada Open Platform sign-in for the 888 Grocery shop (Supabase Edge Function "lazada-auth", verify_jwt off).
//   GET  /lazada-auth             -> sends the owner to Lazada's "Authorize" page for app 144841
//   GET  /lazada-auth?code=...    -> Lazada sends the owner back here; we swap the code for shop tokens
//   POST /lazada-auth/refresh     -> daily from pg_cron (x-cron-key): renews the access token before it runs out
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1d2b20">` +
  `<h1 style="color:#16803d;font-size:24px">${esc(title)}</h1><p style="font-size:17px;line-height:1.5">${body}</p></body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

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
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const code = url.searchParams.get('code');
    if (!code) {
      const go = new URL('https://auth.lazada.com/oauth/authorize');
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
    return page('Lazada did not connect', `Lazada answered: ${esc(msg)}. Open this link again to retry; the sign-in code only works once and only for a few minutes.`, 400);
  }
});
