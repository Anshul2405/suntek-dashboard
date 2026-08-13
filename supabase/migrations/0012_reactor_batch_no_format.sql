-- Batch number format: reactor code + "-" + per-reactor sequence (e.g. P12-13).
-- Replaces the old global PBS-###### allocator when migration 0009 already ran.

create or replace function public.allocate_production_batch_numbers(p_reactor_id uuid)
returns table (batch_no text, reactor_seq int)
language plpgsql
security definer
as $$
declare
  v_seq int;
  v_code text;
begin
  if p_reactor_id is null then
    raise exception 'reactor_id is required';
  end if;

  select r.code into v_code from public.reactors r where r.id = p_reactor_id for update;
  if not found then
    raise exception 'reactor not found: %', p_reactor_id;
  end if;

  select coalesce(max(p.reactor_seq), 0) + 1
    into v_seq
  from public.production_batch_sheets p
  where p.reactor_id = p_reactor_id;

  batch_no := v_code || '-' || v_seq::text;
  reactor_seq := v_seq;
  return next;
end;
$$;

grant execute on function public.allocate_production_batch_numbers(uuid) to anon, authenticated, service_role;
