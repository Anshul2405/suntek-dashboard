-- Mirror of supabase/migrations/0013_batch_sheet_oil_grade.sql
alter table public.production_batch_sheets
  add column if not exists oil_grade text,
  add column if not exists oil_ratio integer;

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
