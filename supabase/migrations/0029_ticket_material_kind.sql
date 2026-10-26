-- Spare vs consumable on an emergency maintenance ticket.
-- Spare must be a FAR asset. Consumable is free text; a FAR match is flagged in the app.
alter table public.maintenance_tickets
  add column if not exists material_kind text;

alter table public.maintenance_tickets
  drop constraint if exists maintenance_tickets_material_kind_check;

alter table public.maintenance_tickets
  add constraint maintenance_tickets_material_kind_check
  check (material_kind is null or material_kind in ('spare', 'consumable'));

notify pgrst, 'reload schema';
