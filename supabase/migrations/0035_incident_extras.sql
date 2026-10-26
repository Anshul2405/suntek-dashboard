-- Photos, documents, tagged people, and a claim on a maintenance incident.

alter table public.incident_reports
  add column if not exists photo_urls text[] not null default '{}',
  add column if not exists doc_urls jsonb not null default '[]'::jsonb,
  add column if not exists tagged_people text[] not null default '{}',
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz;
