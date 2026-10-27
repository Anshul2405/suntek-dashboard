import { istDayDiff, istDayKey } from './utils/formatting';

/** IST calendar-day gap between an entry date and today (whatever zone the browser is in). */
export function daysBeforeToday(entryDate: string, now = new Date()): number {
  const day = entryDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
  return istDayDiff(day, now);
}

/** True when the date is older than the allowed buffer (default 2 days). */
export function needsLateApproval(entryDate: string | null | undefined, bufferDays = 2, now = new Date()): boolean {
  if (!entryDate) return false;
  return daysBeforeToday(entryDate, now) > bufferDays;
}

/**
 * Days a bill may be late before Management has to approve it.
 * A plant with its own number wins. Several plants on one row use the
 * tightest of those numbers. Anything else uses the default.
 */
export function billBufferDays(
  plantIds: (string | null | undefined)[],
  byPlant: Record<string, number> | undefined,
  fallback = 2,
): number {
  const custom = plantIds
    .filter((id): id is string => !!id)
    .map((id) => byPlant?.[id])
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (!custom.length) return fallback;
  return Math.min(...custom);
}

/** Today's IST day (yyyy-mm-dd). Name kept for callers; it was browser-local before. */
export function localToday(now = new Date()): string {
  return istDayKey(now);
}
