-- ============================================================================
-- Migration 0020 — Consumed disposition after store handover
-- ----------------------------------------------------------------------------
-- After the store hands parts to the operator, the ticket used to force a
-- defective return (Repair / Scrap). Consumables (grease, oil, tape, one-use
-- gaskets) have no old part to return. The operator now chooses Consumed, and
-- the ticket closes with defective_part_decision = 'consumed'.
--
-- Widens the original check (repair | scrap) and also allows 'mixed' which
-- record_defective_disposition already writes.
-- ============================================================================

do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  where con.conrelid = 'public.maintenance_tickets'::regclass
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%defective_part_decision%';
  if cname is not null then
    execute format('alter table public.maintenance_tickets drop constraint %I', cname);
  end if;
end $$;

alter table public.maintenance_tickets
  add constraint maintenance_tickets_defective_part_decision_check
  check (
    defective_part_decision is null
    or defective_part_decision in ('repair', 'scrap', 'mixed', 'consumed')
  );

comment on column public.maintenance_tickets.defective_part_decision is
  'How issued parts were settled: repair | scrap | mixed | consumed.';
