-- Read-only Busy results, pushed by the PC. The dashboard reads this table.
-- No public tunnel address is required.

create table if not exists public.busy_feed (
  path text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.busy_feed enable row level security;

drop policy if exists busy_feed_read on public.busy_feed;
create policy busy_feed_read on public.busy_feed
  for select to anon, authenticated
  using (true);

create or replace function public.publish_busy_feed(p_secret text, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  expected text;
  item jsonb;
  p text;
begin
  select value->>'secret' into expected
  from public.ops_settings
  where key = 'busy_link_secret';

  if expected is null or p_secret is distinct from expected then
    raise exception 'forbidden';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid items';
  end if;

  for item in select * from jsonb_array_elements(p_items)
  loop
    p := item->>'path';
    if p is null or p !~ '^/api/[A-Za-z0-9_./?=&%-]+$' then
      raise exception 'invalid path';
    end if;
    insert into public.busy_feed (path, payload, updated_at)
    values (p, coalesce(item->'payload', '{}'::jsonb), now())
    on conflict (path) do update
      set payload = excluded.payload,
          updated_at = now();
  end loop;
end;
$$;

revoke all on function public.publish_busy_feed(text, jsonb) from public;
grant execute on function public.publish_busy_feed(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
