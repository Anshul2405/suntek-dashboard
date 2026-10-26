-- Customer PO on a material indent (store requisition).
-- The number is stored when the indent is raised and shown on the indent
-- after the approval step.

alter table public.store_requisitions
  add column if not exists customer_po text;

notify pgrst, 'reload schema';
