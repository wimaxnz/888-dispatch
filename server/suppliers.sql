-- Supplier price lists (26 Nov 2026). Each supplier opens a private link and enters the price
-- they charge 888 for each single item we sell (packages are built from these items, so they
-- are not priced here). The owner compares all suppliers per item and picks a preferred one.
-- Only the api function (service role) reads or writes these tables; RLS on, no policies.
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text,
  contact text,
  token_hash text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create table if not exists public.supplier_prices (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  variant_id text not null,
  price_php numeric(10,2) not null check (price_php > 0 and price_php < 1000000),
  updated_at timestamptz not null default now(),
  primary key (supplier_id, variant_id)
);
create table if not exists public.supplier_price_log (
  id bigint generated always as identity primary key,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  variant_id text not null,
  old_php numeric(10,2),
  new_php numeric(10,2),
  at timestamptz not null default now()
);
create table if not exists public.preferred_supplier (
  variant_id text primary key,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  chosen_at timestamptz not null default now()
);
alter table public.suppliers enable row level security;
alter table public.supplier_prices enable row level security;
alter table public.supplier_price_log enable row level security;
alter table public.preferred_supplier enable row level security;
revoke all on public.suppliers, public.supplier_prices, public.supplier_price_log, public.preferred_supplier from anon, authenticated;
