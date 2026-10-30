-- Batch-wise stock ledger. NOT APPLIED.
-- Backup: /tmp/suntek-backups/2026-10-27/{schema.sql,data.sql}. Rollback = restore it,
-- or drop the view, table and policies created here (no existing table is changed).
--
-- One row per stock movement of a CP / oil batch (not store spares — those stay
-- in store_items / store_stock_events; not the monthly cpm snapshot, which stays).
-- qty is SIGNED drums:
--   opening, production, transfer_in, return  → positive
--   dispatch, transfer_out                     → negative
--   adjustment                                 → either sign, never 0
-- On hand for a batch = sum(qty). Rows are append-only: corrections are adjustments.
-- Plant-scoped like 0039 (plant_in_scope / fail-closed); a row with no plant is
-- visible to all-plants users only and is never deleted.

begin;

create table if not exists public.batch_stock_movements (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null check (btrim(batch_no) <> ''),
  plant_id uuid references public.plants(id),
  reactor_id uuid,
  batch_sheet_id uuid references public.production_batch_sheets(id) on delete set null,
  density numeric,
  location text,
  movement_type text not null check (movement_type in
    ('opening', 'production', 'dispatch', 'transfer_in', 'transfer_out', 'return', 'adjustment')),
  qty numeric(12, 2) not null,
  qty_kg numeric(14, 2),
  -- transfer_out: the plant it is going to; transfer_in: the plant it came from.
  to_plant_id uuid references public.plants(id),
  from_plant_id uuid references public.plants(id),
  -- links a transfer_out with the transfer_in the receiving plant posts
  transfer_group uuid,
  dispatch_ref text,
  -- Busy invoice / dispatch no — a stub until the Busy feed carries batch numbers.
  busy_ref text,
  at timestamptz not null default now(),
  actor_name text,
  created_by uuid default auth.uid(),
  note text,
  created_at timestamptz not null default now(),
  constraint batch_stock_movements_sign_check check (
    (movement_type in ('opening', 'production', 'transfer_in', 'return') and qty > 0)
    or (movement_type in ('dispatch', 'transfer_out') and qty < 0)
    or (movement_type = 'adjustment' and qty <> 0)
  ),
  constraint batch_stock_movements_transfer_check check (
    movement_type <> 'transfer_out' or (to_plant_id is not null and transfer_group is not null)
  )
);

-- Never post twice: one production per batch sheet, one opening per batch and
-- plant, one receipt per transfer.
create unique index if not exists batch_stock_one_production_per_sheet
  on public.batch_stock_movements (batch_sheet_id)
  where movement_type = 'production' and batch_sheet_id is not null;
create unique index if not exists batch_stock_one_opening_per_batch
  on public.batch_stock_movements (upper(batch_no), plant_id)
  where movement_type = 'opening';
create unique index if not exists batch_stock_one_receipt_per_transfer
  on public.batch_stock_movements (transfer_group)
  where movement_type = 'transfer_in';
create index if not exists batch_stock_batch_idx on public.batch_stock_movements (plant_id, upper(batch_no));
create index if not exists batch_stock_at_idx on public.batch_stock_movements (at desc);

alter table public.batch_stock_movements enable row level security;
drop policy if exists batch_stock_read on public.batch_stock_movements;
drop policy if exists batch_stock_insert on public.batch_stock_movements;
-- Read your plants' movements, and transfers coming to your plant.
create policy batch_stock_read on public.batch_stock_movements
  for select to authenticated
  using (public.plant_in_scope(plant_id) or (to_plant_id is not null and public.plant_in_scope(to_plant_id)));
-- Post only for a plant you can see. No update / delete policy: append-only.
create policy batch_stock_insert on public.batch_stock_movements
  for insert to authenticated
  with check (auth.uid() is not null and public.plant_in_scope(plant_id));

-- On hand per batch and plant. security_invoker: the caller's RLS applies.
create or replace view public.batch_stock_on_hand with (security_invoker = true) as
select upper(btrim(batch_no)) as batch_no,
       plant_id,
       sum(qty) as drums,
       sum(qty_kg) as kg,
       count(*) as movements,
       max(at) as last_at
  from public.batch_stock_movements
 group by upper(btrim(batch_no)), plant_id;

grant select on public.batch_stock_on_hand to authenticated;

commit;

notify pgrst, 'reload schema';
