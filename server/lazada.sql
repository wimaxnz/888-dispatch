-- Lazada Open Platform tokens for the 888 Grocery shop (25 Nov 2026). Written only by the
-- "lazada-auth" edge function (service role). RLS on with no policies, so the public keys cannot read it.
create table if not exists public.lazada_tokens (
  id int primary key default 1 check (id = 1),
  access_token text not null,
  refresh_token text not null,
  account text,
  country text,
  seller_info jsonb,
  expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.lazada_tokens enable row level security;
revoke all on public.lazada_tokens from anon, authenticated;

-- Daily renewal (the function only renews when fewer than 2 days are left).
create or replace function public.refresh_lazada_token() returns void
language plpgsql security definer set search_path = public, net as $$
begin
  perform net.http_post(
    'https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/lazada-auth/refresh',
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-cron-key', (select value from app_secrets where name = 'cron_key')),
    timeout_milliseconds := 20000);
end $$;
revoke all on function public.refresh_lazada_token() from public, anon, authenticated;
select cron.schedule('lazada-token-refresh', '17 3 * * *', 'select public.refresh_lazada_token()');
