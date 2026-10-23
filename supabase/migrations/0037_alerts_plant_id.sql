-- DRAFT — file only. Not applied anywhere. Apply on live only when told to.
--
-- alerts has no plant column, so Overview's Open Alerts tile cannot follow a
-- user's plant grant. This adds the column only (additive, nullable): existing
-- rows keep plant_id null and nothing about current reads or RLS changes.
--
-- Follow-up after applying (not in this file):
--   * whatever writes alerts sets plant_id;
--   * Overview reads alerts through scopeQuery (plant-less alerts would then
--     be visible to global users only);
--   * optionally tighten RLS from the open policy to plant_in_scope(plant_id).

alter table public.alerts
  add column if not exists plant_id uuid references public.plants(id) on delete set null;

create index if not exists alerts_plant_id_idx on public.alerts (plant_id);
