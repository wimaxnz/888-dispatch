-- Saved copy of the storefront product list for gift-voucher quotes (applied 24 Nov 2026,
-- updated 25 Nov 2026).
-- Shopify throttles /products.json from Supabase's network (429) — first on the myshopify.com
-- domain, and from 24 Nov 16:00 UTC also on 888grocery.com/products.json. The same list served at
-- /collections/all/products.json was not throttled, so the database fetches that every 5 minutes,
-- switching to the other address whenever one answers with anything but 200. The api function
-- reads this table instead of calling Shopify on every quote (see packItems in index.ts).
create table if not exists public.shop_catalog_cache (
  id int primary key default 1 check (id = 1),
  products jsonb,
  fetched_at timestamptz,
  pending_request bigint
);
alter table public.shop_catalog_cache enable row level security;
insert into public.shop_catalog_cache (id) values (1) on conflict do nothing;
alter table public.shop_catalog_cache add column if not exists url_idx int not null default 0;
alter table public.shop_catalog_cache add column if not exists last_status int;

create or replace function public.refresh_shop_catalog() returns void
language plpgsql security definer set search_path = public, net as $$
declare
  r record; req bigint; idx int; n int;
  urls text[] := array[
    'https://888grocery.com/collections/all/products.json?limit=250',
    'https://888grocery.com/products.json?limit=250'
  ];
begin
  select pending_request, url_idx into req, idx from shop_catalog_cache where id = 1;
  if req is not null then
    select status_code, content into r from net._http_response where id = req;
    if found then
      update shop_catalog_cache set last_status = r.status_code where id = 1;
      n := case when r.status_code = 200 and r.content is not null
                then jsonb_array_length((r.content::jsonb)->'products') end;
      if n > 0 then
        update shop_catalog_cache set products = (r.content::jsonb)->'products', fetched_at = now() where id = 1;
      else
        idx := (idx + 1) % array_length(urls, 1);  -- blocked or empty: try the other address next time
        update shop_catalog_cache set url_idx = idx where id = 1;
      end if;
    end if;
  end if;
  select net.http_get(urls[idx + 1], headers := '{"User-Agent":"888-dispatch-catalog/1.0"}'::jsonb,
                      timeout_milliseconds := 20000) into req;
  update shop_catalog_cache set pending_request = req where id = 1;
end $$;
revoke all on function public.refresh_shop_catalog() from public, anon, authenticated;

select cron.schedule('shop-catalog-refresh', '*/5 * * * *', 'select public.refresh_shop_catalog()');

-- 25 Nov 2026 (later): Shopify now answers 429 on BOTH storefront addresses from Supabase, so the copy
-- went 8 h stale. The 5-minute job now asks the api function, which reads the products through the
-- Shopify Admin API (not rate-limited per IP) and saves them here, SKUs included.
create or replace function public.refresh_shop_catalog() returns void
language plpgsql security definer set search_path = public, net as $$
begin
  perform net.http_post(
    'https://jssnhzkyhtobhuogddeq.supabase.co/functions/v1/api/catalog-refresh',
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-cron-key', (select value from app_secrets where name = 'cron_key')),
    timeout_milliseconds := 60000);
end $$;
select cron.alter_job((select jobid from cron.job where jobname = 'shop-catalog-refresh'), schedule := '*/10 * * * *');
