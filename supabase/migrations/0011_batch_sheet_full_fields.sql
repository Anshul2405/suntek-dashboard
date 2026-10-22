-- Extend active_batches for full CPW batch-sheet capture (dummy sheet + workflow PDF).
-- Stores process/summary fields OCR already extracts but previously only put in audit logs.

alter table public.active_batches
  add column if not exists opening_balance numeric,
  add column if not exists closing_balance numeric,
  add column if not exists oil_con_ratio_g_per_kg numeric,
  add column if not exists net_cp_kg numeric,
  add column if not exists sheet_details jsonb not null default '{}'::jsonb,
  add column if not exists sheet_image_url text,
  add column if not exists helper_name text,
  add column if not exists operator_name text,
  add column if not exists technical_name text,
  add column if not exists type_of_oil text,
  add column if not exists total_batch_time text;

comment on column public.active_batches.sheet_details is
  'Full OCR/process block: oil/Cl2/FRR times, purge, HS, brightener, free Cl2, etc.';
comment on column public.active_batches.oil_con_ratio_g_per_kg is
  'Yield: paraffin_kg / net_cp_kg * 1000 (g oil per kg CP). net_cp = drums*250 + closing - opening.';

-- Latest closed batch closing balance for a plant (carry-forward helper).
create or replace function public.latest_batch_closing_balance(p_plant_id uuid default null)
returns numeric
language sql
stable
security definer
as $$
  select b.closing_balance
  from public.active_batches b
  where b.closing_balance is not null
    and (p_plant_id is null or b.plant_id = p_plant_id or b.plant_id is null)
  order by coalesce(b.closed_at, b.started_at) desc nulls last
  limit 1;
$$;

grant execute on function public.latest_batch_closing_balance(uuid) to anon, authenticated, service_role;
