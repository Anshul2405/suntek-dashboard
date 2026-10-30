/**
 * Typed dates for the dd/mm/yyyy date box. The native <input type="date"> shows
 * the browser's own order (often mm/dd/yyyy), so plant forms show and accept
 * dd/mm/yyyy and keep YYYY-MM-DD as the value. Calendar days only — no time zone.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function realDay(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** '2026-10-02' → '02/10/2026'; anything else → ''. */
export function isoToDmy(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * What a person typed → 'YYYY-MM-DD', or null if it is not a real day.
 * Day first: 2/10/2026, 02-10-2026, 02.10.26, 02102026. A pasted 2026-10-02 is
 * also read (year first is never ambiguous).
 */
export function parseDmy(text: string | null | undefined): string | null {
  const raw = (text || '').trim();
  if (!raw) return null;
  let y: number; let mo: number; let d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/.exec(raw))) {
    d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  } else if ((m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
  } else return null;
  return realDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** min / max check on ISO days ('' = no limit). */
export function dayInRange(iso: string, min?: string, max?: string): boolean {
  if (min && iso < min) return false;
  if (max && iso > max) return false;
  return true;
}
