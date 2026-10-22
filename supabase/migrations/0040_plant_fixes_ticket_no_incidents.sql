-- ============================================================================
-- Migration 0040 — Plant fixes (Oct 2026): ticket numbers, raiser edit window,
-- admin back-date guard, incident reports.
-- ----------------------------------------------------------------------------
-- FILE ONLY — NOT APPLIED TO LIVE. Review first, apply by hand on staging.
-- Mirror: supabase-queries/110_plant_fixes_ticket_no_incidents.sql
--
-- Numbered 0040 to stay clear of 0031/0032 (Busy, this branch) and of the
-- 0034/0035 ticket-number / incident SQL that exists on the Mac copy and is
-- not in Git yet. It is written to be SAFE ON TOP OF THAT SQL:
--   • ticket_no / req_no are only created + back-filled when the column does
--     not exist. An existing column (e.g. text "STK0001" from next_ticket_no)
--     is left exactly as it is — the app shows a text code verbatim.
--   • incident_reports is only created when missing; on an existing table it
--     only ADDS the columns the app reads, never drops or retypes one, and it
--     adds a scope policy only when the table has no policy at all.
--   • Nothing here touches busy_* tables.
--
--  1. maintenance_tickets.ticket_no (sequential, created_at order) and
--     store_requisitions.req_no — when absent.
--  2. Edit guard on maintenance_tickets — an emergency ticket's equipment /
--     description / plant may only change:
--       • with backdate_tickets (admins hold it implicitly), any time; or
--       • by its raiser within 1 hour of created_at (not once closed); or
--       • while it is back with the technician (status changes_requested).
--     created_at (the "raised on" date) changes only with backdate_tickets.
--  3. incident_reports — plant-scoped, taggable, optionally linked to a ticket.
-- ============================================================================

-- ── 1. Ticket / requisition numbers (only when the column is absent) ────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'maintenance_tickets' and column_name = 'ticket_no') then
    alter table public.maintenance_tickets add column ticket_no bigint;
    update public.maintenance_tickets t set ticket_no = n.n
      from (select id, row_number() over (order by created_at, id) as n from public.maintenance_tickets) n
     where t.id = n.id;
    create sequence if not exists public.maintenance_ticket_no_seq;
    perform setval('public.maintenance_ticket_no_seq',
                   greatest(coalesce((select max(ticket_no) from public.maintenance_tickets), 0), 1),
                   (select max(ticket_no) is not null from public.maintenance_tickets));
    alter table public.maintenance_tickets alter column ticket_no set default nextval('public.maintenance_ticket_no_seq');
    create unique index if not exists maintenance_tickets_ticket_no_uidx on public.maintenance_tickets (ticket_no);
    grant usage on sequence public.maintenance_ticket_no_seq to authenticated;
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'store_requisitions' and column_name = 'req_no') then
    alter table public.store_requisitions add column req_no bigint;
    update public.store_requisitions r set req_no = n.n
      from (select id, row_number() over (order by created_at, id) as n from public.store_requisitions) n
     where r.id = n.id;
    create sequence if not exists public.store_requisition_no_seq;
    perform setval('public.store_requisition_no_seq',
                   greatest(coalesce((select max(req_no) from public.store_requisitions), 0), 1),
                   (select max(req_no) is not null from public.store_requisitions));
    alter table public.store_requisitions alter column req_no set default nextval('public.store_requisition_no_seq');
    create unique index if not exists store_requisitions_req_no_uidx on public.store_requisitions (req_no);
    grant usage on sequence public.store_requisition_no_seq to authenticated;
  end if;
end $$;

-- ── 2. Edit window / back-date guard ────────────────────────────────────────
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

-- ── 3. Incident reports (create when missing, otherwise only add columns) ───
create sequence if not exists public.incident_no_seq;

create table if not exists public.incident_reports (
  id           uuid primary key default gen_random_uuid(),
  incident_no  bigint not null default nextval('public.incident_no_seq') unique,
  plant_id     uuid not null references public.plants(id),
  created_at   timestamptz not null default now()
);

alter table public.incident_reports add column if not exists unit_id      uuid references public.units(id);
alter table public.incident_reports add column if not exists ticket_id    uuid references public.maintenance_tickets(id) on delete set null;
alter table public.incident_reports add column if not exists title        text;
alter table public.incident_reports add column if not exists description  text;
alter table public.incident_reports add column if not exists severity     text default 'medium';
alter table public.incident_reports add column if not exists occurred_at  timestamptz default now();
alter table public.incident_reports add column if not exists location     text;
alter table public.incident_reports add column if not exists photo_url    text;
alter table public.incident_reports add column if not exists status       text default 'open';
alter table public.incident_reports add column if not exists tagged_ids   text[] default '{}';
alter table public.incident_reports add column if not exists tagged_names text[] default '{}';
alter table public.incident_reports add column if not exists raised_by    text;
alter table public.incident_reports add column if not exists raised_by_id text;
alter table public.incident_reports add column if not exists closed_by    text;
alter table public.incident_reports add column if not exists closed_at    timestamptz;

create index if not exists incident_reports_plant_idx on public.incident_reports (plant_id, created_at desc);
create index if not exists incident_reports_ticket_idx on public.incident_reports (ticket_id);

alter table public.incident_reports enable row level security;
do $$
begin
  -- Never replace an existing policy set — only seed one on a bare table.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incident_reports') then
    create policy "incident_scope_all" on public.incident_reports for all
      using      (public.plant_unit_in_scope(plant_id, unit_id))
      with check (public.plant_unit_in_scope(plant_id, unit_id));
  end if;
end $$;

grant select, insert, update on public.incident_reports to authenticated;
grant usage on sequence public.incident_no_seq to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.incident_reports;
exception when others then null; end $$;

notify pgrst, 'reload schema';
