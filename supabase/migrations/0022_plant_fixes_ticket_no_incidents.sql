-- ============================================================================
-- Migration 0022 — Plant fixes (Oct 2026): ticket numbers, raiser edit window,
-- admin back date audit, incident reports.
-- ----------------------------------------------------------------------------
-- FILE ONLY. Review, then apply by hand in the SQL editor. Idempotent.
-- Mirror: supabase-queries/94_plant_fixes_ticket_no_incidents.sql
--
--  1. maintenance_tickets.ticket_no  — sequential MT-0001 in created_at order,
--     then a sequence for new rows. store_requisitions.req_no (SR-0001) the same.
--  2. Edit guard trigger on maintenance_tickets — an emergency ticket's
--     equipment / description / plant may only change:
--       • by an admin / backdate_tickets holder (any time), or
--       • by its raiser within 1 hour of created_at, or
--       • while it is back with the technician (status changes_requested).
--     created_at (the "raised on" date) changes only with backdate_tickets.
--  3. incident_reports — plant-scoped, taggable, optionally linked to a ticket.
-- ============================================================================

-- ── 1. Ticket / requisition numbers ─────────────────────────────────────────
alter table public.maintenance_tickets add column if not exists ticket_no bigint;

update public.maintenance_tickets t
   set ticket_no = n.n
  from (select id, row_number() over (order by created_at, id) as n
          from public.maintenance_tickets) n
 where t.id = n.id and t.ticket_no is null;

create sequence if not exists public.maintenance_ticket_no_seq;
select setval('public.maintenance_ticket_no_seq',
              greatest(coalesce((select max(ticket_no) from public.maintenance_tickets), 0), 1),
              (select max(ticket_no) is not null from public.maintenance_tickets));
alter table public.maintenance_tickets alter column ticket_no set default nextval('public.maintenance_ticket_no_seq');
create unique index if not exists maintenance_tickets_ticket_no_uidx on public.maintenance_tickets (ticket_no);

alter table public.store_requisitions add column if not exists req_no bigint;
update public.store_requisitions r
   set req_no = n.n
  from (select id, row_number() over (order by created_at, id) as n
          from public.store_requisitions) n
 where r.id = n.id and r.req_no is null;
create sequence if not exists public.store_requisition_no_seq;
select setval('public.store_requisition_no_seq',
              greatest(coalesce((select max(req_no) from public.store_requisitions), 0), 1),
              (select max(req_no) is not null from public.store_requisitions));
alter table public.store_requisitions alter column req_no set default nextval('public.store_requisition_no_seq');
create unique index if not exists store_requisitions_req_no_uidx on public.store_requisitions (req_no);

-- ── 2. Edit window / back date guard ────────────────────────────────────────
create or replace function public.guard_ticket_edit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_me text;
begin
  -- service_role / SQL editor (no JWT) is trusted.
  if auth.uid() is null then return new; end if;

  if new.created_at is distinct from old.created_at
     and not public.has_capability('backdate_tickets') then
    raise exception 'forbidden: only an admin can change the raised date';
  end if;

  if old.type = 'emergency'
     and (new.equipment   is distinct from old.equipment
       or new.description is distinct from old.description
       or new.plant_id    is distinct from old.plant_id) then
    if public.has_capability('backdate_tickets') then return new; end if;
    if old.status = 'changes_requested' then return new; end if;
    select ua.name into v_me from user_accounts ua where ua.auth_user_id = auth.uid() limit 1;
    if v_me is not null
       and lower(trim(v_me)) = lower(trim(coalesce(old.raised_by, '')))
       and now() <= old.created_at + interval '1 hour'
       and old.status <> 'closed' then
      return new;
    end if;
    raise exception 'forbidden: ticket edit window (1 hour) has passed';
  end if;
  return new;
end $$;

drop trigger if exists maintenance_tickets_guard_edit on public.maintenance_tickets;
create trigger maintenance_tickets_guard_edit
  before update on public.maintenance_tickets
  for each row execute function public.guard_ticket_edit();

-- ── 3. Incident reports ─────────────────────────────────────────────────────
create sequence if not exists public.incident_no_seq;

create table if not exists public.incident_reports (
  id           uuid primary key default gen_random_uuid(),
  incident_no  bigint not null default nextval('public.incident_no_seq') unique,
  plant_id     uuid not null references public.plants(id),
  unit_id      uuid references public.units(id),
  ticket_id    uuid references public.maintenance_tickets(id) on delete set null,
  title        text not null,
  description  text,
  severity     text not null default 'medium' check (severity in ('low','medium','high','critical')),
  occurred_at  timestamptz not null default now(),
  location     text,
  photo_url    text,
  status       text not null default 'open' check (status in ('open','closed')),
  tagged_ids   text[] not null default '{}',
  tagged_names text[] not null default '{}',
  raised_by    text,
  raised_by_id text,
  closed_by    text,
  closed_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists incident_reports_plant_idx on public.incident_reports (plant_id, created_at desc);
create index if not exists incident_reports_ticket_idx on public.incident_reports (ticket_id);

alter table public.incident_reports enable row level security;
drop policy if exists "scope_all" on public.incident_reports;
create policy "scope_all" on public.incident_reports for all
  using      (public.plant_unit_in_scope(plant_id, unit_id))
  with check (public.plant_unit_in_scope(plant_id, unit_id));

grant select, insert, update on public.incident_reports to authenticated;
grant usage on sequence public.incident_no_seq to authenticated;
grant usage on sequence public.maintenance_ticket_no_seq to authenticated;
grant usage on sequence public.store_requisition_no_seq to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.incident_reports;
exception when others then null; end $$;

notify pgrst, 'reload schema';
