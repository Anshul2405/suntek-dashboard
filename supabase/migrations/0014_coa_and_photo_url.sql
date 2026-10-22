-- COA results on production batch sheets + profile photo URL.
alter table public.production_batch_sheets
  add column if not exists oil_grade text,
  add column if not exists oil_ratio integer,
  add column if not exists coa_results jsonb,
  add column if not exists coa_issued_at timestamptz;

comment on column public.production_batch_sheets.coa_results is
  'Manual COA Result column values keyed by CoaParamKey.';

alter table public.user_accounts
  add column if not exists photo_url text;

alter table public.profiles
  add column if not exists photo_url text;

comment on column public.user_accounts.photo_url is
  'Cloudinary (or CDN) URL for the user profile photo.';
comment on column public.profiles.photo_url is
  'Cloudinary (or CDN) URL for the login profile photo.';
