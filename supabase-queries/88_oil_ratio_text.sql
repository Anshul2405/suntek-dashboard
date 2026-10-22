-- Oil ratio on production sheets is a free label (52%, CP52, 1400, …), not an integer.
alter table public.production_batch_sheets
  alter column oil_ratio type text using oil_ratio::text;

comment on column public.production_batch_sheets.oil_ratio is
  'Free-text oil ratio as entered on the batch sheet (letters, numbers, %).';
