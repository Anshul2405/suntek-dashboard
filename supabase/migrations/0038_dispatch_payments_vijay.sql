-- Purchase book: live payments, dispatch access, and the Vijay ji → purchaser step.
-- NOT APPLIED. Review, then run once in the Supabase SQL editor. Safe to run again.
--
-- Until this runs the app keeps working on the old paths:
--   * ticket part not in store: unit head → purchase (no Vijay step),
--   * Store Req "Approve — needs buying" stays disabled,
--   * Purchase book → Payments shows the workbook sheet and a "not applied" note.
--
-- Before running, check no row would break the new status lists:
--   select status, count(*) from maintenance_tickets group by 1;
--   select status, count(*) from store_requisitions group by 1;

begin;

-- 1. Ticket statuses: not-in-store part → Vijay ji → named purchaser.
--    Vijay ji IS management; there is no further management step.
alter table public.maintenance_tickets
  drop constraint if exists maintenance_tickets_status_check;
alter table public.maintenance_tickets
  add constraint maintenance_tickets_status_check
  check (status in (
    'open','in_progress','pending_store','pending_unit_head',
    'pending_vijay','pending_buyer',
    'pending_purchase','pending_purchase_manager','pending_handover',
    'pending_defective_return','changes_requested','closed'));

-- 2. Per part: Vijay ji's decision and the purchaser he named.
alter table public.maintenance_store_requests
  add column if not exists vijay_approval text,
  add column if not exists vijay_approved_by text,
  add column if not exists vijay_approved_at timestamptz,
  add column if not exists buyer_name text;
alter table public.maintenance_store_requests
  drop constraint if exists maintenance_store_requests_vijay_approval_check;
alter table public.maintenance_store_requests
  add constraint maintenance_store_requests_vijay_approval_check
  check (vijay_approval is null or vijay_approval in ('approved', 'rejected'));

-- 3. Store requisitions: a buy goes pending → pending_vijay → pending_buyer → approved.
alter table public.store_requisitions drop constraint if exists store_requisitions_status_check;
alter table public.store_requisitions
  add constraint store_requisitions_status_check
  check (status = any (array[
    'pending', 'approved', 'dispatched', 'received', 'rejected',
    'pending_store', 'issued', 'pending_approval', 'pending_vijay', 'pending_buyer', 'in_transit'
  ]));
alter table public.store_requisitions
  add column if not exists buyer_name text;

-- 4. Live payments (not on the ticket). Entered with the inputter's name,
--    Delhi office marks input done (Axis), management marks payment done.
--    busy_done is for a Busy-confirmed row; the dashboard only READS Busy.
create table if not exists public.purchase_payments (
  id uuid primary key default gen_random_uuid(),
  pay_date date not null,
  beneficiary text not null,
  account_no text,
  ifsc text,
  bank text,
  amount numeric(14, 2) not null check (amount > 0),
  remarks text,
  input_by text not null,
  status text not null default 'entered'
    check (status in ('entered', 'input_done', 'payment_done', 'busy_done')),
  input_done_by text,
  input_done_at timestamptz,
  payment_done_by text,
  payment_done_at timestamptz,
  busy_done_at timestamptz,
  busy_voucher text,
  plant_id uuid references public.plants(id),
  created_at timestamptz not null default now()
);
create index if not exists purchase_payments_status_idx on public.purchase_payments (status, pay_date desc);

alter table public.purchase_payments enable row level security;
-- Bank details: signed-in users only (no anon).
drop policy if exists purchase_payments_auth on public.purchase_payments;
create policy purchase_payments_auth on public.purchase_payments
  for all to authenticated using (true) with check (true);

-- 5. Dispatch (dispatch_logs already exists). Only if it has no policy yet,
--    let signed-in users write consignments; an existing policy is left alone.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'dispatch_logs') then
    execute 'alter table public.dispatch_logs enable row level security';
    execute 'create policy dispatch_logs_auth on public.dispatch_logs for all to authenticated using (true) with check (true)';
  end if;
end $$;
create index if not exists dispatch_logs_vehicle_date_idx on public.dispatch_logs (vehicle_no, date);
create index if not exists dispatch_logs_in_transit_idx on public.dispatch_logs (date desc) where receive_date is null;

-- 6. Purchase book route for roles that already see Purchase Orders or Marine.
--    (The app already allows those roles in code; this makes it explicit.)
update public.roles
   set allowed_routes = array_append(allowed_routes, '/dashboard/purchase/book')
 where not ('*' = any(allowed_routes))
   and not ('/dashboard/purchase/book' = any(allowed_routes))
   and (
     '/dashboard/purchase/purchase' = any(allowed_routes)
     or '/dashboard/purchase/marine' = any(allowed_routes)
   );

commit;

notify pgrst, 'reload schema';
