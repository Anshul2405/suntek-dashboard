-- The Busy PC publishes its current read-only tunnel address here.
-- The dashboard reads this row, so a reboot can issue a new address
-- without a new site deploy and without anyone watching a command window.

create table if not exists public.busy_link (
  id int primary key default 1 check (id = 1),
  base_url text,
  status text,
  db_name text,
  read_only boolean,
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.busy_link (id)
values (1)
on conflict (id) do nothing;

alter table public.busy_link enable row level security;

drop policy if exists busy_link_read on public.busy_link;
create policy busy_link_read on public.busy_link
  for select to anon, authenticated
  using (true);

-- Writes go through this function. The secret lives in ops_settings, not in git.
create or replace function public.publish_busy_link(
  p_secret text,
  p_url text,
  p_status text default null,
  p_db text default null,
  p_read_only boolean default true,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  expected text;
begin
  select value->>'secret' into expected
  from public.ops_settings
  where key = 'busy_link_secret';

  if expected is null or p_secret is distinct from expected then
    raise exception 'forbidden';
  end if;

  if p_url is null or p_url !~ '^https://[A-Za-z0-9.-]+' then
    raise exception 'invalid url';
  end if;

  update public.busy_link
     set base_url = rtrim(p_url, '/'),
         status = p_status,
         db_name = p_db,
         read_only = coalesce(p_read_only, true),
         detail = coalesce(p_detail, '{}'::jsonb),
         updated_at = now()
   where id = 1;
end;
$$;

revoke all on function public.publish_busy_link(text, text, text, text, boolean, jsonb) from public;
grant execute on function public.publish_busy_link(text, text, text, text, boolean, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
