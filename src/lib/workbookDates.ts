/**
 * Dates typed into the Purchase workbook (dd.mm.yyyy).
 *
 * The workbook has typos like 24.04.2036 or 29.08.2029. Sorted newest first,
 * those win row 1. A date is "bogus" when its year is before 2020 or after the
 * current financial year + 1; it keeps showing as typed (so the typo is visible)
 * but sorts to the bottom of its sheet.
 */
import { formatDate, istFyStartYear, istToday } from './utils/formatting';

const WORKBOOK_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
/** Typed like a date but mangled: 16.054.2026, 15.09.206, 3.4.26. */
const DATE_LIKE = /^\d{1,3}\.\d{1,3}\.\d{1,5}$/;

/** Earliest believable year in the workbook. */
export const WORKBOOK_MIN_YEAR = 2020;

/** Latest believable year: the current FY's start year + 1 (Oct 2026 → 2027). */
export function workbookMaxYear(todayIso: string = istToday()): number {
  return istFyStartYear(todayIso) + 1;
}

/** yyyymmdd for a dd.mm.yyyy value, or 0 when it is not a workbook date. */
export function workbookDateKey(value: unknown): number {
  const m = WORKBOOK_DATE.exec(String(value ?? '').trim());
  return m ? Number(m[3] + m[2] + m[1]) : 0;
}

/**
 * A date the workbook got wrong: a year outside 2020 … FY+1, an impossible
 * day/month, or a mangled dd.mm.yyyy (16.054.2026). Text and "25.09" (no year)
 * are not flagged.
 */
export function isBogusWorkbookDate(value: unknown, todayIso: string = istToday()): boolean {
  const raw = String(value ?? '').trim();
  const m = WORKBOOK_DATE.exec(raw);
  if (!m) return DATE_LIKE.test(raw);
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return true;
  return year < WORKBOOK_MIN_YEAR || year > workbookMaxYear(todayIso);
}

/** Show a workbook date like every other screen (dd/mm/yyyy), typo included. */
export function workbookDateLabel(value: unknown): string {
  const m = WORKBOOK_DATE.exec(String(value ?? '').trim());
  return m ? formatDate(`${m[3]}-${m[2]}-${m[1]}`) : String(value ?? '');
}

/**
 * Newest first by `key`. Rows with a bogus date go to the bottom, after rows
 * with no date. Ties keep the workbook's own order.
 */
export function sortWorkbookRows<T extends Record<string, unknown>>(rows: T[], key = 'date', todayIso: string = istToday()): T[] {
  const tier = (r: T) => (isBogusWorkbookDate(r[key], todayIso) ? 2 : workbookDateKey(r[key]) ? 0 : 1);
  return rows
    .map((row, i) => ({ row, i, tier: tier(row), k: workbookDateKey(row[key]) }))
    .sort((a, b) => a.tier - b.tier || (a.tier === 0 ? b.k - a.k : 0) || a.i - b.i)
    .map(x => x.row);
}
