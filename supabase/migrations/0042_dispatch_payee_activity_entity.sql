-- Dispatch: Busy company + payee + bank; Activity Log: which entry a row points at.
-- Applied live 29 Oct 2026 (additive columns only; dispatch_logs 2 rows, activity_logs 565, unchanged).
-- Additive only: new nullable columns, two checks, one index. No row changes.
-- Rollback: drop the columns listed below.

begin;

-- ── Dispatch: whose books (Busy company) and who is paid ──────────────────────
-- Company = whose books (0007 Chlorides, 0009 Plasticizer, 0010 NKG, 0012 Madan).
-- Kolkata is a party-name desk inside a company, not a company.
-- Payee comes from that company's Busy payee feed (read only) or, as an
-- exception with a reason, typed by hand — same as purchase_payments (0040).
alter table public.dispatch_logs
  add column if not exists company_code text,
  add column if not exists payee text,
  add column if not exists payee_source text,
  add column if not exists exception_reason text,
  add column if not exists account_no text,
  add column if not exists ifsc text,
  add column if not exists bank text;

alter table public.dispatch_logs drop constraint if exists dispatch_logs_company_check;
alter table public.dispatch_logs add constraint dispatch_logs_company_check
  check (company_code is null or company_code in ('0007', '0009', '0010', '0012'));
alter table public.dispatch_logs drop constraint if exists dispatch_logs_payee_source_check;
alter table public.dispatch_logs add constraint dispatch_logs_payee_source_check
  check (payee_source is null or payee_source in ('busy', 'manual'));
alter table public.dispatch_logs drop constraint if exists dispatch_logs_ifsc_check;
alter table public.dispatch_logs add constraint dispatch_logs_ifsc_check
  check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

-- ── Activity Log: open the real entry ─────────────────────────────────────────
-- entity_type: stock_item | stock_receipt | store_req | dispatch | payment |
-- batch_sheet | far_asset | repair_return | maintenance_ticket | incident.
alter table public.activity_logs
  add column if not exists entity_type text,
  add column if not exists entity_id text;
create index if not exists activity_logs_entity_idx on public.activity_logs (entity_type, entity_id);

commit;

notify pgrst, 'reload schema';
