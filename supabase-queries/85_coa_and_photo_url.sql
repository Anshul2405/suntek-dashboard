-- Mirror of 0014_coa_and_photo_url.sql
alter table public.production_batch_sheets
  add column if not exists oil_grade text,
  add column if not exists oil_ratio integer,
  add column if not exists coa_results jsonb,
  add column if not exists coa_issued_at timestamptz;

alter table public.user_accounts
  add column if not exists photo_url text;

alter table public.profiles
  add column if not exists photo_url text;
