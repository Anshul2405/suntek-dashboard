-- DRAFT — file only. Not applied anywhere. Apply on live only when told to.
--
-- One open periodic ticket per schedule. Maintenance turns due schedules into
-- tickets in the browser; the client now locks and re-reads before inserting,
-- but two people opening Maintenance at the same instant can still both
-- create one. This index makes the second insert fail instead.
--
-- Safe to re-run. If duplicates already exist it does NOT delete anything:
-- it skips the index and prints how many schedules need a manual look
-- (close the extra ticket, then run this again).

do $$
declare
  dupes int;
begin
  select count(*) into dupes from (
    select schedule_id
      from public.maintenance_tickets
     where type = 'periodic' and schedule_id is not null and status <> 'closed'
     group by schedule_id
    having count(*) > 1
  ) d;

  if dupes > 0 then
    raise notice 'Skipped: % schedule(s) already have more than one open periodic ticket. Close the extras, then re-run.', dupes;
  else
    create unique index if not exists maintenance_tickets_one_open_periodic
      on public.maintenance_tickets (schedule_id)
      where type = 'periodic' and schedule_id is not null and status <> 'closed';
  end if;
end $$;

-- Find the duplicates (read-only):
-- select schedule_id, array_agg(coalesce(ticket_no, id::text) order by created_at) as tickets
--   from public.maintenance_tickets
--  where type = 'periodic' and schedule_id is not null and status <> 'closed'
--  group by schedule_id having count(*) > 1;
