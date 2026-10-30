-- Axis payment machine on purchase_payments (0038). NOT APPLIED.
-- Backup: /tmp/suntek-backups/2026-10-27/{schema.sql,data.sql}. Rollback = restore it,
-- or drop the trigger/function/policies below and re-create purchase_payments_auth.
--
-- Additive: new columns, a wider status list, a guard trigger and tighter RLS.
-- No row is deleted. Existing rows keep their old status and are read as
-- "flow_version is null" (0038 meanings) — see the optional mapping at the end.
--
-- Six saved stages (+ rejected):
--   input_done → payment_pending → payment_approved → payment_processing (Axis)
--   → payment_completed → busy_updated
-- Who moves what (same as the app, lib/paymentFlow.ts):
--   pending, processing          Delhi accounts (accountant_delhi / accountant_other) or admin
--   approved / rejected          management or admin — never the person who entered the row
--   completed, busy_updated      accounts or management
--   processing needs account no + IFSC (missing bank is flagged, not silently allowed)
-- busy_updated is a saved status. The dashboard confirms it from the READ-ONLY
-- Busy feed (or a person types the voucher no). Nothing is written to Busy.

begin;

alter table public.purchase_payments
  add column if not exists company_code text,
  add column if not exists purpose text,
  add column if not exists payee_source text,
  add column if not exists busy_party_code text,
  add column if not exists exception_reason text,
  add column if not exists created_by uuid,
  add column if not exists flow_version smallint,
  add column if not exists pending_by text,
  add column if not exists pending_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists processing_by text,
  add column if not exists processing_at timestamptz,
  add column if not exists completed_by text,
  add column if not exists completed_at timestamptz,
  add column if not exists busy_updated_by text,
  add column if not exists busy_updated_at timestamptz,
  add column if not exists busy_match text,
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text;

-- Defaults apply to NEW rows only; existing rows keep flow_version NULL (= 0038 meanings).
alter table public.purchase_payments alter column created_by set default auth.uid();
alter table public.purchase_payments alter column flow_version set default 2;
alter table public.purchase_payments alter column status set default 'input_done';

alter table public.purchase_payments
  add column if not exists missing_bank boolean
  generated always as (coalesce(btrim(account_no), '') = '' or coalesce(btrim(ifsc), '') = '') stored;

alter table public.purchase_payments drop constraint if exists purchase_payments_status_check;
alter table public.purchase_payments add constraint purchase_payments_status_check check (status in (
  -- 0038 values, still valid for old rows
  'entered', 'input_done', 'payment_done', 'busy_done',
  -- meeting stages
  'payment_pending', 'payment_approved', 'payment_processing', 'payment_completed', 'busy_updated',
  'rejected'));

alter table public.purchase_payments drop constraint if exists purchase_payments_company_check;
alter table public.purchase_payments add constraint purchase_payments_company_check
  check (company_code is null or company_code in ('0007', '0009', '0010', '0012'));
alter table public.purchase_payments drop constraint if exists purchase_payments_payee_source_check;
alter table public.purchase_payments add constraint purchase_payments_payee_source_check
  check (payee_source is null or payee_source in ('busy', 'manual'));
alter table public.purchase_payments drop constraint if exists purchase_payments_busy_match_check;
alter table public.purchase_payments add constraint purchase_payments_busy_match_check
  check (busy_match is null or busy_match in ('auto', 'manual'));
-- New-flow rows: company + purpose required; a payee not in Busy needs a reason.
alter table public.purchase_payments drop constraint if exists purchase_payments_v2_fields_check;
alter table public.purchase_payments add constraint purchase_payments_v2_fields_check check (
  coalesce(flow_version, 0) < 2 or (
    company_code is not null
    and nullif(btrim(coalesce(purpose, '')), '') is not null
    and (payee_source is distinct from 'manual' or nullif(btrim(coalesce(exception_reason, '')), '') is not null)
  ));

create index if not exists purchase_payments_company_status_idx
  on public.purchase_payments (company_code, status, pay_date desc);

-- ── Role helpers ────────────────────────────────────────────────────────────
create or replace function public.has_role_any(p_roles text[]) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_accounts ua
     where ua.auth_user_id = auth.uid()
       and (ua.role_id = any(p_roles)
            or exists (select 1 from user_roles ur where ur.user_account_id = ua.id and ur.role_id = any(p_roles)))
  );
$$;

create or replace function public.is_accounts() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_global_user() or public.has_role_any(array['accountant_delhi', 'accountant_other']);
$$;

-- Old status → stage (0038 rows: input_done meant "keyed into Axis").
create or replace function public.payment_stage(p_status text, p_flow smallint) returns text
  language sql immutable as $$
  select case p_status
    when 'entered' then 'input_done'
    when 'input_done' then case when p_flow is null then 'payment_processing' else 'input_done' end
    when 'payment_done' then 'payment_completed'
    when 'busy_done' then 'busy_updated'
    else p_status end;
$$;

-- ── Guard: order, people, locked fields, stamps ─────────────────────────────
create or replace function public.guard_payment_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_to text;
  v_me text;
begin
  -- SQL editor / service jobs (no signed-in user) are not checked.
  if auth.uid() is null then return new; end if;
  select coalesce(ua.name, '') into v_me from user_accounts ua where ua.auth_user_id = auth.uid() limit 1;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.flow_version := 2;
    new.status := 'input_done';
    return new;
  end if;

  v_from := public.payment_stage(old.status, old.flow_version);
  v_to := public.payment_stage(new.status, coalesce(new.flow_version, old.flow_version));

  if v_to is distinct from v_from then
    if not (
      (v_from = 'input_done' and v_to = 'payment_pending') or
      (v_from = 'payment_pending' and v_to in ('payment_approved', 'rejected')) or
      (v_from = 'payment_approved' and v_to = 'payment_processing') or
      (v_from = 'payment_processing' and v_to = 'payment_completed') or
      (v_from = 'payment_completed' and v_to = 'busy_updated')
    ) then
      raise exception 'Payment cannot move from % to %', v_from, v_to;
    end if;

    if v_to = 'payment_pending' then
      if not public.is_accounts() then raise exception 'Only accounts can queue a payment for approval'; end if;
      new.pending_at := now(); new.pending_by := coalesce(new.pending_by, v_me);
    elsif v_to in ('payment_approved', 'rejected') then
      if not public.is_manager() then raise exception 'Only management can approve or reject a payment'; end if;
      if old.created_by = auth.uid() then raise exception 'You cannot approve or reject a payment you entered'; end if;
      if v_to = 'payment_approved' then
        new.approved_at := now(); new.approved_by := coalesce(new.approved_by, v_me);
      else
        new.rejected_at := now(); new.rejected_by := coalesce(new.rejected_by, v_me);
      end if;
    elsif v_to = 'payment_processing' then
      if not public.is_accounts() then raise exception 'Only accounts can key a payment into Axis'; end if;
      if coalesce(btrim(new.account_no), '') = '' or coalesce(btrim(new.ifsc), '') = '' then
        raise exception 'Account number and IFSC are needed before Axis processing';
      end if;
      new.processing_at := now(); new.processing_by := coalesce(new.processing_by, v_me);
    elsif v_to = 'payment_completed' then
      if not (public.is_accounts() or public.is_manager()) then raise exception 'Only accounts or management can mark a payment completed'; end if;
      new.completed_at := now(); new.completed_by := coalesce(new.completed_by, v_me);
    elsif v_to = 'busy_updated' then
      if not (public.is_accounts() or public.is_manager()) then raise exception 'Only accounts or management can confirm Busy'; end if;
      new.busy_updated_at := now(); new.busy_updated_by := coalesce(new.busy_updated_by, v_me);
    end if;
  end if;

  -- Approved entries are locked: after approval the payee, amount and company
  -- do not change; bank details can still be filled until Axis processing.
  if v_from in ('payment_approved', 'payment_processing', 'payment_completed', 'busy_updated', 'rejected')
     and (new.amount is distinct from old.amount
          or new.beneficiary is distinct from old.beneficiary
          or new.company_code is distinct from old.company_code
          or new.pay_date is distinct from old.pay_date) then
    raise exception 'An approved payment cannot be changed';
  end if;
  if v_from in ('payment_processing', 'payment_completed', 'busy_updated')
     and (new.account_no is distinct from old.account_no or new.ifsc is distinct from old.ifsc or new.bank is distinct from old.bank) then
    raise exception 'Bank details are locked once the payment is in Axis';
  end if;
  new.created_by := old.created_by;
  return new;
end $$;

drop trigger if exists guard_payment_change on public.purchase_payments;
create trigger guard_payment_change
  before insert or update on public.purchase_payments
  for each row execute function public.guard_payment_change();

-- ── RLS: plant rows by plant; head-office rows (no plant) for accounts / management.
alter table public.purchase_payments enable row level security;
drop policy if exists purchase_payments_auth on public.purchase_payments;
drop policy if exists purchase_payments_read on public.purchase_payments;
drop policy if exists purchase_payments_insert on public.purchase_payments;
drop policy if exists purchase_payments_update on public.purchase_payments;
create policy purchase_payments_read on public.purchase_payments
  for select to authenticated
  using (public.plant_in_scope(plant_id) or (plant_id is null and (public.is_accounts() or public.is_manager())));
create policy purchase_payments_insert on public.purchase_payments
  for insert to authenticated
  with check (auth.uid() is not null and (plant_id is null or public.plant_in_scope(plant_id)));
create policy purchase_payments_update on public.purchase_payments
  for update to authenticated
  using (public.plant_in_scope(plant_id) or (plant_id is null and (public.is_accounts() or public.is_manager())))
  with check (public.plant_in_scope(plant_id) or (plant_id is null and (public.is_accounts() or public.is_manager())));
-- No delete policy: payments are never deleted from the app.

grant execute on function public.has_role_any(text[]) to authenticated;
grant execute on function public.is_accounts() to authenticated;
grant execute on function public.payment_stage(text, smallint) to authenticated;

commit;

notify pgrst, 'reload schema';

-- ── OPTIONAL, documented, NOT run: rename 0038 statuses to the new names. ───
-- The app already reads old rows correctly (flow_version NULL), so this is only
-- for tidy data. Run as postgres in the SQL editor (auth.uid() is NULL there, so
-- the guard above does not block it). It changes status text only; no row is lost.
--
-- update public.purchase_payments
--    set status = case status
--                   when 'entered'      then 'input_done'
--                   when 'input_done'   then 'payment_processing'  -- 0038: keyed into Axis
--                   when 'payment_done' then 'payment_completed'
--                   when 'busy_done'    then 'busy_updated'
--                 end,
--        processing_at = coalesce(processing_at, case when status = 'input_done' then input_done_at end),
--        processing_by = coalesce(processing_by, case when status = 'input_done' then input_done_by end),
--        completed_at  = coalesce(completed_at, payment_done_at),
--        completed_by  = coalesce(completed_by, payment_done_by),
--        busy_updated_at = coalesce(busy_updated_at, busy_done_at),
--        flow_version = 1
--  where flow_version is null and status in ('entered', 'input_done', 'payment_done', 'busy_done');
