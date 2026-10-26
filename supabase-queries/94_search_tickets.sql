-- 94 — Search tickets by short id (same as supabase/migrations/0022_search_tickets.sql)
create or replace function public.search_maintenance_tickets(p_q text)
returns table (
  id uuid,
  title text,
  equipment text,
  description text,
  raised_by text,
  assigned_to text,
  status text
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
    t.status::text
  from public.maintenance_tickets t
  where length(trim(p_q)) >= 2
    and (
      t.id::text ilike trim(p_q) || '%'
      or replace(t.id::text, '-', '') ilike replace(trim(p_q), '-', '') || '%'
      or coalesce(t.title, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.equipment, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.description, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.raised_by, '') ilike '%' || trim(p_q) || '%'
      or coalesce(t.assigned_to, '') ilike '%' || trim(p_q) || '%'
    )
  order by t.created_at desc
  limit 8;
$$;

revoke all on function public.search_maintenance_tickets(text) from public, anon;
grant execute on function public.search_maintenance_tickets(text) to authenticated;
