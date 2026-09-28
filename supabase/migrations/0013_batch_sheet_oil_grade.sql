-- Meeting Aug 2026: Create Batch Sheet Step 2 captures Oil Ratio + NP/HNP grade.
-- Density remains the measured value; oil_ratio is the selected reference row
-- (e.g. 1200 / 1300) and oil_grade is NP or HNP for TDS/COA linkage.

alter table public.production_batch_sheets
  add column if not exists oil_grade text,
  add column if not exists oil_ratio integer;

comment on column public.production_batch_sheets.oil_grade is
  'NP or HNP — product family for TDS / COA.';
comment on column public.production_batch_sheets.oil_ratio is
  'Selected oil-ratio density key (e.g. 1200) from the oil_ratios reference.';

-- Keep reactor seed aligned with meet: SPPL P13–P28, SPPL(K) P29–P32.
-- Idempotent insert for any missing P-codes after the range shift.
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
