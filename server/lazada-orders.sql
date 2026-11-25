-- Lazada orders seen by dispatch (25 Nov 2026). One row per Lazada order; `stage` is our summary of
-- Lazada's item statuses (new / shipped / delivered / cancelled). The api function only acts when it changes.
create table if not exists public.lazada_orders (
  order_id text primary key,
  stage text not null,
  payload jsonb,
  result jsonb,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.lazada_orders enable row level security;
revoke all on public.lazada_orders from anon, authenticated;

-- Every 5 minutes: lazada-auth reads new/changed Lazada orders and posts them to api/lazada.
create or replace function public.sync_lazada_orders() returns void
language plpgsql security definer set search_path = public, net as $$
begin
  if not exists (select 1 from lazada_tokens where id = 1) then return; end if;
  perform net.http_post(
    'https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/lazada-auth/orders-sync',
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-cron-key', (select value from app_secrets where name = 'cron_key')),
    timeout_milliseconds := 60000);
end $$;
revoke all on function public.sync_lazada_orders() from public, anon, authenticated;
select cron.schedule('lazada-orders-sync', '*/5 * * * *', 'select public.sync_lazada_orders()');
