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

/**
 * A Busy payment voucher that looks like this payment: same party (every word
 * of the beneficiary is in the Busy party name, or the other way round) and
 * the amount within the feed's rounding. Read-only, best effort.
 */
export function findBusyPayment(row: Pick<PaymentRow, 'beneficiary' | 'amount'>, feed: Movement[]): Movement | null {
  for (const mv of feed) {
    if (mv.type !== 'purchase') continue;
    const party = PAYMENT_TITLE.exec(mv.title || '')?.[1];
    if (!party) continue;
    if (!personMatches(row.beneficiary, party) && !personMatches(party, row.beneficiary)) continue;
    const amt = parseFeedAmount(mv.amt);
    if (!amt) continue;
    if (Math.abs(amt.value - Number(row.amount)) <= amt.tolerance) return mv;
  }
  return null;
}
