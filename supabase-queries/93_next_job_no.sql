-- 93 — Global next FAR/STK job number (same as supabase/migrations/0021_next_job_no.sql)

create or replace function public.next_job_no(p_prefix text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if p_prefix not in ('FAR', 'STK') then
    raise exception 'invalid job prefix: %', p_prefix;
  end if;

  perform pg_advisory_xact_lock(hashtext('job_no_' || p_prefix));

  if p_prefix = 'FAR' then
    select coalesce(max((substring(job_no from '[0-9]+$'))::int), 0) + 1
      into v_n
      from public.fixed_assets
     where job_no ~ '^FAR-[0-9]+$';
  else
    select coalesce(max((substring(job_no from '[0-9]+$'))::int), 0) + 1
      into v_n
      from public.store_items
     where job_no ~ '^STK-[0-9]+$';
  end if;

  return p_prefix || '-' || case when v_n < 1000 then lpad(v_n::text, 3, '0') else v_n::text end;
end $$;

revoke all on function public.next_job_no(text) from public, anon;
grant execute on function public.next_job_no(text) to authenticated;
