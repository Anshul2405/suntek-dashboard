-- Incident reports, STK ticket numbers, purchase value category, FAR daily snapshot.

create table if not exists public.incident_reports (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid references public.plants(id),
  occurred_at timestamptz not null default now(),
  where_text text,
  what_text text not null,
  who_text text,
  how_text text,
  solution_text text,
  reported_by text,
  created_at timestamptz not null default now()
);

alter table public.incident_reports enable row level security;
drop policy if exists incident_reports_rw on public.incident_reports;
create policy incident_reports_rw on public.incident_reports
  for all to authenticated using (true) with check (true);

alter table public.maintenance_tickets add column if not exists ticket_no text;
create unique index if not exists maintenance_tickets_ticket_no_key
  on public.maintenance_tickets (ticket_no) where ticket_no is not null;

create sequence if not exists public.ticket_no_seq;

create or replace function public.next_ticket_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  n := nextval('public.ticket_no_seq');
  return 'STK' || lpad(n::text, 4, '0');
end;
$$;

grant execute on function public.next_ticket_no() to authenticated;

grant select, insert, update, delete on public.incident_reports to authenticated;

with ordered as (
  select id, row_number() over (order by created_at, id) as n
  from public.maintenance_tickets
  where ticket_no is null
)
update public.maintenance_tickets t
set ticket_no = 'STK' || lpad(ordered.n::text, 4, '0')
from ordered
where t.id = ordered.id;

select setval(
  'public.ticket_no_seq',
  greatest((select count(*) from public.maintenance_tickets), 1),
  (select count(*) from public.maintenance_tickets) > 0
);

alter table public.store_items add column if not exists value_category text;
alter table public.maintenance_store_requests add column if not exists value_category text;

alter table public.fixed_assets add column if not exists deleted_at timestamptz;

create table if not exists public.far_daily (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  asset_id uuid not null,
  payload jsonb not null,
  unique (snapshot_date, asset_id)
);

alter table public.far_daily enable row level security;
drop policy if exists far_daily_rw on public.far_daily;
create policy far_daily_rw on public.far_daily
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.far_daily to authenticated;
