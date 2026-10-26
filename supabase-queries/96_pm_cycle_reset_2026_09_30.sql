-- Reset periodic maintenance cycle from 30 Sep 2026 (run on live).
-- Companion: supabase/migrations/0024_pm_cycle_reset_2026_09_30.sql

UPDATE public.maintenance_schedules
SET
  next_due_at = '2026-09-30T00:00:00+05:30',
  last_completed_at = NULL
WHERE is_active = true
  AND (next_due_at IS NULL OR next_due_at < '2026-09-30T00:00:00+05:30');

UPDATE public.maintenance_tickets
SET
  status = 'closed',
  closed_at = COALESCE(closed_at, now()),
  description = trim(both E'\n' from coalesce(description, '') || E'\n[System] Closed on PM cycle reset to 30 Sep 2026')
WHERE type = 'periodic'
  AND status IS DISTINCT FROM 'closed'
  AND (
    due_date IS NULL
    OR due_date < DATE '2026-09-30'
    OR schedule_id IN (
      SELECT id FROM public.maintenance_schedules
      WHERE next_due_at = '2026-09-30T00:00:00+05:30'
    )
  );

-- Sanity check
SELECT
  count(*) FILTER (WHERE is_active AND next_due_at::date = DATE '2026-09-30') AS due_on_30_sep,
  count(*) FILTER (WHERE is_active AND next_due_at < '2026-09-30T00:00:00+05:30') AS still_before_30,
  count(*) FILTER (WHERE is_active AND next_due_at::date > DATE '2026-09-30') AS after_30
FROM public.maintenance_schedules;
