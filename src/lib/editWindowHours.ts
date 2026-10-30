/** The saved edit window (Access & backup). Kept apart so opsControls can use it without an import loop. */
export const DEFAULT_EDIT_WINDOW_HOURS = 1;
/** Longest window Admin may save (one week). */
export const MAX_EDIT_WINDOW_HOURS = 168;

/** A saved value → hours: a positive number up to a week (quarter hours), else the 1-hour default. */
export function cleanEditWindowHours(raw: unknown): number {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n) || n <= 0 || n > MAX_EDIT_WINDOW_HOURS) return DEFAULT_EDIT_WINDOW_HOURS;
  return Math.max(0.25, Math.round(n * 4) / 4);
}
