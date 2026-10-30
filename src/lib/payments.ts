/**
 * Live payments (purchase_payments, migration 0038).
 *
 * entered → input_done (Delhi office keyed it into Axis) → payment_done
 * (management) → Done in Busy. The Busy tick is READ from the Busy feed —
 * nothing is ever written back to Busy.
 */
import type { Movement } from '../hooks/useBusyData';
import type { Database } from './database.types';
import { personMatches } from './procurementPeople';

export type PaymentRow = Database['public']['Tables']['purchase_payments']['Row'];
export type PaymentStatus = PaymentRow['status'];

/** Show only the last four digits of an account number. */
export function maskAccount(acct: string | null | undefined): string {
  const digits = (acct || '').replace(/\s+/g, '');
  if (!digits) return '';
  return digits.length <= 4 ? digits : `••••${digits.slice(-4)}`;
}

/**
 * The Busy feed sends amounts already formatted: "-₹56,124", "-₹1.2 L",
 * "-₹2.15 Cr". Return the value and how far off that rounding can be.
 */
export function parseFeedAmount(amt: string): { value: number; tolerance: number } | null {
  const m = /₹\s*([\d,.]+)\s*(L|Cr)?/i.exec(amt || '');
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'l') return { value: n * 1e5, tolerance: 0.05 * 1e5 };
  if (unit === 'cr') return { value: n * 1e7, tolerance: 0.005 * 1e7 };
  return { value: n, tolerance: 1 };
}

const PAYMENT_TITLE = /^Payment Voucher\s*·\s*(.+)$/i;
/** The live Busy reader sends every payment voucher as "Payment Voucher · Unknown" (29 Oct 2026). */
const UNKNOWN_PARTY = /^(unknown|—|-|)$/i;
const DAY_MS = 86_400_000;

/** Voucher day within [pay date − 1, pay date + 3] (they book the next morning). Unknown day: allowed. */
export function inPayWindow(voucherDay: string | null | undefined, payDay: string | null | undefined): boolean {
  if (!voucherDay || !payDay) return true;
  const v = Date.parse(`${voucherDay.slice(0, 10)}T00:00:00Z`);
  const p = Date.parse(`${payDay.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(v) || !Number.isFinite(p)) return true;
  return v >= p - DAY_MS && v <= p + 3 * DAY_MS;
}

/** Named party: the feed's own rounding. Unknown: that, plus 0.25% so ₹6,80,000 can match ₹6,78,767. */
function amountFits(want: number, amt: { value: number; tolerance: number }, unknown: boolean): boolean {
  const slack = unknown ? Math.max(amt.tolerance, 0.0025 * Math.max(want, amt.value)) : amt.tolerance;
  return Math.abs(amt.value - want) <= slack;
}

/**
 * A Busy payment voucher that is this payment. Read-only:
 * - a payment voucher of this company's feed (type purchase or payment),
 * - dated within the pay-date window,
 * - amount within the feed's rounding (Unknown also allows 0.25%),
 * - named party when Busy sends a name; when Busy sends "Unknown", only if
 *   this is the only voucher in the window that hits the amount (₹6.8 L is
 *   allowed when unique; two ₹6.8 L in the window → no tick).
 */
export function findBusyPayment(row: Pick<PaymentRow, 'beneficiary' | 'amount'> & { pay_date?: string | null }, feed: Movement[]): Movement | null {
  const want = Number(row.amount);
  const byParty: Movement[] = [];
  const byUnknownAmount: Movement[] = [];
  for (const mv of feed) {
    if (mv.type !== 'purchase' && (mv.type as string) !== 'payment') continue;
    const party = PAYMENT_TITLE.exec(mv.title || '')?.[1]?.trim();
    if (party == null) continue;
    if (!inPayWindow(mv.date, row.pay_date)) continue;
    const amt = parseFeedAmount(mv.amt);
    const unknown = UNKNOWN_PARTY.test(party);
    if (!amt || !amountFits(want, amt, unknown)) continue;
    if (!unknown) {
      if (personMatches(row.beneficiary, party) || personMatches(party, row.beneficiary)) byParty.push(mv);
    } else {
      byUnknownAmount.push(mv);
    }
  }
  if (byParty.length) return byParty[0];
  return byUnknownAmount.length === 1 ? byUnknownAmount[0] : null;
}

/** Full Indian figure for a table: 680000 → "₹ 6,80,000"; paise kept when stored. */
export function fmtINRFull(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const paise = Math.round(n * 100) % 100 !== 0;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: paise ? 2 : 0, maximumFractionDigits: 2 })}`;
}
