/**
 * Formatting utilities for the Suntek ERP Dashboard.
 */

/** Format Indian Rupee amounts (₹ 1,23,456) */
export function formatINR(amount: number, short = false): string {
  if (short) {
    if (amount >= 1_00_00_000) return `₹ ${(amount / 1_00_00_000).toFixed(2)} Cr`;
    if (amount >= 1_00_000) return `₹ ${(amount / 1_00_000).toFixed(2)} L`;
    if (amount >= 1_000) return `₹ ${(amount / 1_000).toFixed(1)} K`;
    return `₹ ${amount.toLocaleString('en-IN')}`;
  }
  return `₹ ${amount.toLocaleString('en-IN')}`;
}

/** Format metric tons */
export function formatMT(qty: number): string {
  return `${qty.toLocaleString('en-IN', { maximumFractionDigits: 1 })} MT`;
}

/** Format drums count */
export function formatDrums(count: number): string {
  return `${count.toLocaleString('en-IN')} drums`;
}

/** Format percentage */
export function formatPct(value: number, decimals = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

// ── Dates (IST) ──────────────────────────────────────────────────────────────
// The plants run on India time and every screen shows one format: "22/10/2026"
// (dd/mm/yyyy; "22/10/2026, 3:05 pm" with a time). Pinning the zone means a
// browser left on UTC — or a phone set abroad — still shows the plant's day.

export const IST_TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60_000; // IST has no DST

function toDate(date: string | Date | null | undefined): Date | null {
  if (date == null || date === '') return null;
  // A bare 'YYYY-MM-DD' is a calendar day, not UTC midnight — read it as IST.
  const d = typeof date === 'string'
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00+05:30` : date)
    : date;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "22/10/2026" (dd/mm/yyyy) in IST. Empty / invalid input → '—'.
 *  Built from the IST calendar day rather than toLocaleDateString, whose
 *  output depends on the browser locale — one format is the point. */
export function formatDate(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '—';
  const [y, m, day] = istDayKey(d).split('-');
  return `${day}/${m}/${y}`;
}

/** "3:05 pm" in IST (12-hour, lower-case am/pm). Empty / invalid input → '—'. */
export function formatTime(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '—';
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST_TZ });
  return time.replace(/\s?(AM|PM)$/i, m => ` ${m.trim().toLowerCase()}`);
}

/** "22/10/2026, 3:05 pm" in IST. Empty / invalid input → '—'. */
export function formatDateTime(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '—';
  return `${formatDate(d)}, ${formatTime(d)}`;
}

/** The IST calendar day ('YYYY-MM-DD') an instant falls on. */
export function istDayKey(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '';
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's IST calendar day ('YYYY-MM-DD'). */
export function istToday(): string {
  return istDayKey(new Date());
}

/**
 * Normalise a From/To pair typed into two date inputs. Empty bound = open.
 * A To before From is a typo, not an empty range — swap rather than silently
 * emptying the table, and say so (`swapped`) so the UI can show it.
 */
export function normalizeDayRange(from: string, to: string): { from: string; to: string; swapped: boolean } {
  const f = (from || '').trim();
  const t = (to || '').trim();
  if (f && t && t < f) return { from: t, to: f, swapped: true };
  return { from: f, to: t, swapped: false };
}

/**
 * Is `value` inside the inclusive IST calendar-day range [from, to]?
 * Both bounds are 'YYYY-MM-DD'; either may be empty (= no limit). A row with no
 * date only matches when no bound is set.
 */
export function inIstDayRange(value: string | Date | null | undefined, from: string, to: string): boolean {
  const { from: f, to: t } = normalizeDayRange(from, to);
  if (!f && !t) return true;
  const day = istDayKey(value);
  if (!day) return false;
  if (f && day < f) return false;
  if (t && day > t) return false;
  return true;
}

/** ISO instants bounding an inclusive IST day range, for server-side filters
 *  (.gte(col, start).lt(col, endExclusive)). Empty bound → undefined. */
export function istRangeToIso(from: string, to: string): { start?: string; endExclusive?: string } {
  const { from: f, to: t } = normalizeDayRange(from, to);
  const out: { start?: string; endExclusive?: string } = {};
  if (f) out.start = new Date(`${f}T00:00:00+05:30`).toISOString();
  if (t) out.endExclusive = new Date(new Date(`${t}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();
  return out;
}

/** Get relative time (e.g. "2h ago") */
export function relativeTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

/** Clamp a number between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Convert density to a display label */
export function densityLabel(density: number): string {
  return density.toLocaleString('en-IN');
}
