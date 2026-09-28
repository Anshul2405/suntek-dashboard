-- 92 — Consumed disposition after store handover
-- Same as supabase/migrations/0020_consumed_disposition.sql.
-- Run in the Supabase SQL editor if the app cannot write
-- maintenance_tickets.defective_part_decision = 'consumed'.

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
