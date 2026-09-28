-- Oil ratio is a free-text field (letters, numbers, %).
alter table public.production_batch_sheets
  alter column oil_ratio type text using oil_ratio::text;

comment on column public.production_batch_sheets.oil_ratio is
  'Free-text oil ratio as entered on the batch sheet (letters, numbers, %).';
