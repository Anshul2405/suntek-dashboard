-- Same as supabase/migrations/0033_indent_customer_po.sql

alter table public.store_requisitions
  add column if not exists customer_po text;

notify pgrst, 'reload schema';
