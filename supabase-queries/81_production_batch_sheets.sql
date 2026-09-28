-- Production Batch Sheets (meeting Aug 2026 spec)
-- Linear chain: created at production → in_stock → dispatched.
-- Customer linkage deferred until Busy integration.
-- Continuous global batch_no + per-reactor sequence.
-- Photos: 1–2 JPEGs per evidence slot (sheet / bucket / heat sample).

create table if not exists public.reactors (
  id          uuid primary key default gen_random_uuid(),
  plant_id    uuid not null references public.plants(id) on delete cascade,
  code        text not null,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (plant_id, code)
);

create index if not exists reactors_plant_idx on public.reactors (plant_id) where is_active;

create sequence if not exists public.production_batch_no_seq start 1 increment 1;

create table if not exists public.production_batch_sheets (
  id                     uuid primary key default gen_random_uuid(),
  batch_no               text not null unique,
  reactor_id             uuid not null references public.reactors(id),
  reactor_seq            int not null,
  plant_id               uuid not null references public.plants(id),
  density                numeric not null,
  -- Evidence photos (1–2 URLs each)
  sheet_photo_urls       text[] not null default '{}',
  bucket_photo_urls      text[] not null default '{}',
  heat_sample_photo_urls text[] not null default '{}',
  -- Optional searchable colour label (photo remains primary)
  colour_note            text,
  stage                  text not null default 'created'
                           check (stage in ('created', 'in_stock', 'dispatched')),
  notes                  text,
  created_by             uuid references public.profiles(id),
  created_by_name        text,
  active_batch_id        uuid references public.active_batches(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (reactor_id, reactor_seq)
);

create index if not exists pbs_plant_idx on public.production_batch_sheets (plant_id, created_at desc);
create index if not exists pbs_stage_idx on public.production_batch_sheets (stage, created_at desc);
create index if not exists pbs_reactor_idx on public.production_batch_sheets (reactor_id, reactor_seq);

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

  -- Client rule: batch no = reactor code + "-" + per-reactor sequence (e.g. P12-13).
  batch_no := v_code || '-' || v_seq::text;
  reactor_seq := v_seq;
  return next;
end;
$$;

grant execute on function public.allocate_production_batch_numbers(uuid) to anon, authenticated, service_role;

alter table public.reactors enable row level security;
alter table public.production_batch_sheets enable row level security;

drop policy if exists "anon_all" on public.reactors;
drop policy if exists "scope_all" on public.reactors;
create policy "scope_all" on public.reactors for all
  using      (public.plant_in_scope(plant_id))
  with check (public.plant_in_scope(plant_id));

drop policy if exists "anon_all" on public.production_batch_sheets;
drop policy if exists "scope_all" on public.production_batch_sheets;
create policy "scope_all" on public.production_batch_sheets for all
  using      (public.plant_in_scope(plant_id))
  with check (public.plant_in_scope(plant_id));

-- Official reactor IDs by factory (client note). Drum Plant (DRUM_REHLA) is omitted.
-- Display names are plant-local: Reactor 1(P33) … Reactor 11(P43) for Madan, etc.
insert into public.reactors (plant_id, code, name, sort_order)
select p.id,
       'P' || g.n,
       'Reactor ' || (g.n - g.from_n + 1)::text || '(P' || g.n || ')',
       g.n
from public.plants p
join lateral (
  select gs.n as n, r.from_n as from_n
  from (
    values
      ('SCPL_REHLA', 1, 12),
      ('SPPL_REHLA', 13, 28),
      ('SPPLK_REHLA', 29, 32),
      ('MADAN_SIKANDRABAD', 33, 43),
      ('SCPL_GANJAM', 44, 49)
  ) as r(factory_code, from_n, to_n)
  cross join lateral generate_series(r.from_n, r.to_n) as gs(n)
  where r.factory_code = p.factory_code
) g on true
where p.factory_code is not null
  and not exists (
    select 1 from public.reactors x where x.plant_id = p.id and x.code = ('P' || g.n)
  );
