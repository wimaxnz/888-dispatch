-- Saved copy of the storefront product list for gift-voucher quotes (applied 24 Nov 2026).
-- Shopify throttles 3vyvyi-iq.myshopify.com/products.json from Supabase's network (429),
-- so the database fetches 888grocery.com/products.json every 5 minutes and the api function
-- reads this table instead of calling Shopify on every quote (see packItems in index.ts).
create table if not exists public.shop_catalog_cache (
  id int primary key default 1 check (id = 1),
  products jsonb,
  fetched_at timestamptz,
  pending_request bigint
);
alter table public.shop_catalog_cache enable row level security;
insert into public.shop_catalog_cache (id) values (1) on conflict do nothing;

create or replace function public.refresh_shop_catalog() returns void
language plpgsql security definer set search_path = public, net as $$
declare r record; req bigint;
begin
  select pending_request into req from shop_catalog_cache where id = 1;
  if req is not null then
    select status_code, content into r from net._http_response where id = req;
    if found and r.status_code = 200 and r.content is not null then
      update shop_catalog_cache set products = (r.content::jsonb)->'products', fetched_at = now() where id = 1;
    end if;
  end if;
  select net.http_get('https://888grocery.com/products.json?limit=250', timeout_milliseconds := 20000) into req;
  update shop_catalog_cache set pending_request = req where id = 1;
end $$;
revoke all on function public.refresh_shop_catalog() from public, anon, authenticated;

select cron.schedule('shop-catalog-refresh', '*/5 * * * *', 'select public.refresh_shop_catalog()');
