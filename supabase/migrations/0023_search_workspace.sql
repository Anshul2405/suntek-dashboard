-- ============================================================================
-- Migration 0023 — Cmd+K workspace search (tickets, schedules, store reqs, plants)
-- ----------------------------------------------------------------------------
-- Tickets also match plant name and FAR job_no. Schedules match equipment + FAR
-- job. Store requisitions match the 8-char #. Plants match legacy aliases.
-- SECURITY INVOKER so RLS still applies.
-- ============================================================================

drop function if exists public.search_maintenance_tickets(text);
drop function if exists public.search_maintenance_schedules(text);
drop function if exists public.search_store_requisitions(text);
drop function if exists public.search_plants(text);

create or replace function public.search_maintenance_tickets(p_q text)
returns table (
  id uuid,
  title text,
  equipment text,
  description text,
  raised_by text,
  assigned_to text,
  status text,
  job_no text,
  plant_name text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.id,
    t.title,
    t.equipment,
    t.description,
    t.raised_by,
    t.assigned_to,
    t.status::text,
    a.job_no,
    p.name
  from public.maintenance_tickets t
  left join public.plants p on p.id = t.plant_id
  left join public.fixed_assets a on a.id = t.far_asset_id
  where length(trim(p_q)) >= 2
    and (
      t.id::text ilike trim(p_q) || '%'
      or replace(t.id::text, '-', '') ilike replace(trim(p_q), '-', '') || '%'
      or coalesce(t.title, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.equipment, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.description, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.raised_by, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.assigned_to, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.name, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.entity_name, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.factory_code, '') ilike '%' || trim(p_q) || '%'
      or coalesce(a.job_no, '') ilike '%' || trim(p_q) || '%'
      or coalesce(a.name, '') ilike '%' || trim(p_q) || '%'
      or coalesce(a.identification_mark, '') ilike '%' || trim(p_q) || '%'
    )
  order by t.created_at desc
  limit 8;
$$;

revoke all on function public.search_maintenance_tickets(text) from public, anon;
grant execute on function public.search_maintenance_tickets(text) to authenticated;

create or replace function public.search_maintenance_schedules(p_q text)
returns table (
  id uuid,
  title text,
  equipment text,
  equipment_mark text,
  frequency text,
  assigned_to text,
  job_no text,
  plant_name text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.id,
    s.title,
    s.equipment,
    s.equipment_mark,
    s.frequency::text,
    s.assigned_to,
    a.job_no,
    p.name
  from public.maintenance_schedules s
  left join public.plants p on p.id = s.plant_id
  left join public.fixed_assets a on a.id = s.far_asset_id
  where s.is_active is true
    and length(trim(p_q)) >= 2
    and (
      coalesce(s.title, '') ilike '%' || trim(p_q) || '%'
      or coalesce(s.equipment, '') ilike '%' || trim(p_q) || '%'
      or coalesce(s.equipment_mark, '') ilike '%' || trim(p_q) || '%'
      or coalesce(s.description, '') ilike '%' || trim(p_q) || '%'
      or coalesce(s.assigned_to, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.name, '') ilike '%' || trim(p_q) || '%'
      or coalesce(a.job_no, '') ilike '%' || trim(p_q) || '%'
      or coalesce(a.name, '') ilike '%' || trim(p_q) || '%'
    )
  order by s.next_due_at nulls last
  limit 8;
$$;

revoke all on function public.search_maintenance_schedules(text) from public, anon;
grant execute on function public.search_maintenance_schedules(text) to authenticated;

create or replace function public.search_store_requisitions(p_q text)
returns table (
  id uuid,
  item text,
  raised_by text,
  status text,
  plant_name text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    r.id,
    r.item,
    r.raised_by::text,
    r.status::text,
    p.name
  from public.store_requisitions r
  left join public.plants p on p.id = r.plant_id
  where length(trim(p_q)) >= 2
    and (
      r.id::text ilike trim(p_q) || '%'
      or replace(r.id::text, '-', '') ilike replace(trim(p_q), '-', '') || '%'
      or coalesce(r.item, '') ilike '%' || trim(p_q) || '%'
      or coalesce(r.raised_by::text, '') ilike '%' || trim(p_q) || '%'
      or coalesce(r.approved_by::text, '') ilike '%' || trim(p_q) || '%'
      or coalesce(r.remarks, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.name, '') ilike '%' || trim(p_q) || '%'
    )
  order by r.created_at desc
  limit 8;
$$;

revoke all on function public.search_store_requisitions(text) from public, anon;
grant execute on function public.search_store_requisitions(text) to authenticated;

create or replace function public.search_plants(p_q text)
returns table (
  id uuid,
  name text,
  factory_code text,
  entity_name text,
  company_name text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.id,
    p.name,
    p.factory_code,
    p.entity_name,
    p.company_name
  from public.plants p
  where coalesce(p.is_active, true) is true
    and length(trim(p_q)) >= 2
    and (
      coalesce(p.name, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.factory_code, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.entity_name, '') ilike '%' || trim(p_q) || '%'
      or coalesce(p.company_name, '') ilike '%' || trim(p_q) || '%'
      or exists (
        select 1 from unnest(coalesce(p.legacy_names, '{}'::text[])) n
        where n ilike '%' || trim(p_q) || '%'
      )
    )
  order by p.name
  limit 8;
$$;

revoke all on function public.search_plants(text) from public, anon;
grant execute on function public.search_plants(text) to authenticated;
