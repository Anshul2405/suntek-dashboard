/**
 * The incident "When" box is the browser's own date-time picker. On a phone or
 * PC set to US order it reads 02/10/2026 as 10 Feb, not 2 Oct — that is how the
 * Ganjam incident of 2 Oct 2026 was saved as 10/02/2026. The form echoes the
 * pick back in dd/mm/yyyy and flags a date that is far off.
 */
const DAY = 86_400_000;

/** 'future' (after now), 'old' (more than 45 days ago), or null. */
export function incidentWhenWarning(whenLocal: string, nowMs: number = Date.now()): 'future' | 'old' | null {
  if (!whenLocal) return null;
  const at = new Date(whenLocal).getTime();
  if (!Number.isFinite(at)) return null;
  if (at > nowMs + 60 * 60 * 1000) return 'future';
  if (at < nowMs - 45 * DAY) return 'old';
  return null;
}
