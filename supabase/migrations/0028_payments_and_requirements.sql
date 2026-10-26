-- Other payments (not raw material) and the store requirement chain.
-- Safe to run again.

alter table public.store_requisitions drop constraint if exists store_requisitions_status_check;
alter table public.store_requisitions
  add constraint store_requisitions_status_check
  check (status = any (array[
    'pending', 'approved', 'dispatched', 'received', 'rejected',
    'pending_store', 'issued', 'pending_approval', 'pending_vijay', 'pending_buyer', 'in_transit'
  ]));

alter table public.store_requisitions
  add column if not exists approver_key text,
  add column if not exists buyer_name text,
  add column if not exists supplier text,
  add column if not exists vehicle_no text,
  add column if not exists dispatch_id uuid;

create table if not exists public.other_payments (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind = any (array['freight', 'service', 'bill', 'advance', 'other'])),
  payee text not null,
  amount numeric not null,
  note text,
  status text not null default 'requested' check (status = any (array['requested', 'approved', 'paid'])),
  requested_by text,
  approved_by text,
  paid_by text,
  plant_id uuid,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  paid_at timestamptz
);

alter table public.other_payments enable row level security;
drop policy if exists other_payments_all on public.other_payments;
create policy other_payments_all on public.other_payments for all using (true) with check (true);

notify pgrst, 'reload schema';
