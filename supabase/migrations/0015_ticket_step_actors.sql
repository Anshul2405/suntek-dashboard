-- Who completed each maintenance workflow step (shown on stage "what happened").
alter table public.maintenance_store_requests
  add column if not exists store_decided_by text,
  add column if not exists store_decided_at timestamptz,
  add column if not exists unit_head_approved_by text,
  add column if not exists unit_head_approved_at timestamptz,
  add column if not exists procured_by text,
  add column if not exists procured_at timestamptz,
  add column if not exists handover_confirmed_by text;

alter table public.maintenance_tickets
  add column if not exists assessed_by text,
  add column if not exists verified_by text,
  add column if not exists defective_decided_by text,
  add column if not exists closed_by text;
