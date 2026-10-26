-- When Technical submits a periodic job, and when Unit Head later verifies it.
-- submitted_* is the technical completion. closed_at / verified_by stay the Unit Head step.

ALTER TABLE public.maintenance_tickets
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by text;

-- Jobs already waiting on Unit Head: use the verify-notification time as the submit time.
UPDATE public.maintenance_tickets t
SET
  submitted_at = n.created_at,
  submitted_by = COALESCE(t.submitted_by, NULLIF(t.assigned_to, ''), n.actor_name)
FROM (
  SELECT DISTINCT ON (substring(route FROM 'ticket=([0-9a-f-]{36})'))
    substring(route FROM 'ticket=([0-9a-f-]{36})') AS ticket_id,
    created_at,
    actor_name
  FROM public.notifications
  WHERE title LIKE 'Verify maintenance:%'
    AND route LIKE '%ticket=%'
  ORDER BY substring(route FROM 'ticket=([0-9a-f-]{36})'), created_at ASC
) n
WHERE t.id::text = n.ticket_id
  AND t.type = 'periodic'
  AND t.submitted_at IS NULL
  AND t.completion_photo_url IS NOT NULL;
