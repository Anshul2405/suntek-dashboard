-- Admin controls: module edit/delete, late-entry approval, stock bill history, system audit.
-- Idempotent. Also copied to supabase-queries/97_ops_controls.sql.

create table if not exists public.ops_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.late_entry_requests (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  entry_date date,
  reason text not null,
  status text not null default 'pending',
  requested_by text,
  requested_role text,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  ref_key text,
  created_at timestamptz not null default now()
);

create index if not exists late_entry_requests_status_idx
  on public.late_entry_requests (status, created_at desc);

create table if not exists public.stock_bill_uploads (
  id uuid primary key default gen_random_uuid(),
  item_key text not null,
  item_name text not null,
  plant_id uuid,
  entry_date date,
  bill_url text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by text,
  note text,
  late boolean not null default false
);

create index if not exists stock_bill_uploads_item_idx
  on public.stock_bill_uploads (item_key, uploaded_at desc);

create table if not exists public.system_audit (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  action text not null,
  summary text not null,
  actor_name text,
  actor_role text,
  photo_url text,
  created_at timestamptz not null default now()
);

create index if not exists system_audit_created_idx
  on public.system_audit (created_at desc);

alter table public.ops_settings enable row level security;
alter table public.late_entry_requests enable row level security;
alter table public.stock_bill_uploads enable row level security;
alter table public.system_audit enable row level security;

drop policy if exists ops_settings_all on public.ops_settings;
create policy ops_settings_all on public.ops_settings for all using (true) with check (true);

drop policy if exists late_entry_all on public.late_entry_requests;
create policy late_entry_all on public.late_entry_requests for all using (true) with check (true);

drop policy if exists stock_bill_all on public.stock_bill_uploads;
create policy stock_bill_all on public.stock_bill_uploads for all using (true) with check (true);

drop policy if exists system_audit_all on public.system_audit;
create policy system_audit_all on public.system_audit for all using (true) with check (true);

notify pgrst, 'reload schema';
