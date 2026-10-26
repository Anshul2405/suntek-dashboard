-- 0024: Reset periodic maintenance cycle from 30 Sep 2026.
-- Clears the "19d overdue" backlog so Due Today starts clean on that date.
-- Run once on the live DB (supabase-queries/96_pm_cycle_reset_2026_09_30.sql).

-- 1) Any active schedule still due before 30 Sep → first due = 30 Sep 2026 (IST midnight).
UPDATE public.maintenance_schedules
SET
  next_due_at = '2026-09-30T00:00:00+05:30',
  last_completed_at = NULL
WHERE is_active = true
  AND (next_due_at IS NULL OR next_due_at < '2026-09-30T00:00:00+05:30');

-- 2) Close open periodic tickets spawned for the old overdue cycle so they
--    don't keep showing "Ticket open" next to the reset schedules.
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
