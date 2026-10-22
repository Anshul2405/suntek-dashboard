-- ═══════════════════════════════════════════════════════════════════════════
-- 89_production_batch_sheets_rls.sql — Plant-scope production batch sheets
-- ═══════════════════════════════════════════════════════════════════════════
-- production_batch_sheets was created with anon_all (81 / 0009). Lock it to
-- plant_in_scope() like active_batches (36) so operators only see their factory.
--
-- Requires 28 (plant_in_scope). Idempotent. Does NOT run itself.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.reactors enable row level security;
drop policy if exists "anon_all" on public.reactors;
drop policy if exists "scope_all" on public.reactors;
create policy "scope_all" on public.reactors for all
  using      (public.plant_in_scope(plant_id))
  with check (public.plant_in_scope(plant_id));

alter table public.production_batch_sheets enable row level security;
drop policy if exists "anon_all" on public.production_batch_sheets;
drop policy if exists "scope_all" on public.production_batch_sheets;
create policy "scope_all" on public.production_batch_sheets for all
  using      (public.plant_in_scope(plant_id))
  with check (public.plant_in_scope(plant_id));

notify pgrst, 'reload schema';
