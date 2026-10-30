-- Payments: "Updated in Busy" from any open stage.
-- Applied live 30 Oct 2026 (function replace only; purchase_payments still 1 pending row).
--
-- Why (Sidak, 29 Oct 2026): a payment can be paid in Busy before anyone walks it
-- through Axis (Pending → Approved → Processing → Completed). When the read-only
-- Busy feed shows that payment voucher, the dashboard saves busy_updated + the
-- voucher straight away. 0040's guard only allows payment_completed →
-- busy_updated and raises "Payment cannot move from payment_pending to
-- busy_updated" for anything else.
--
-- Change: busy_updated may be reached from input_done / payment_pending /
-- payment_approved / payment_processing / payment_completed, by accounts or
-- management (same people as before), and only with a Busy voucher number.
-- Rejected and already-updated rows still cannot move. Every other rule of 0040
-- (order of the six stages, who may approve, locked fields, bank before Axis)
-- is unchanged. Nothing is written to Busy; the voucher comes from the feed.
-- Rollback: re-run the guard_payment_change() body from 0040.

begin;

create or replace function public.guard_payment_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_to text;
  v_me text;
begin
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
      -- Busy already shows the payment: from any open stage (0043).
      (v_from in ('input_done', 'payment_pending', 'payment_approved', 'payment_processing', 'payment_completed')
         and v_to = 'busy_updated')
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
      if coalesce(btrim(new.busy_voucher), '') = '' then raise exception 'A Busy voucher number is needed to mark Updated in Busy'; end if;
      new.busy_updated_at := now(); new.busy_updated_by := coalesce(new.busy_updated_by, v_me);
    end if;
  end if;

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

commit;
