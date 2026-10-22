/**
 * Photo rule for issuing a part out of the store's own stock.
 *
 *   line worth > ₹1000   → photo mandatory
 *   line worth ≤ ₹1000   → photo optional
 *   worth unknown        → photo mandatory (we cannot prove it is cheap)
 *
 * "Line worth" = issued qty × last unit price on the purchase book
 * (see purchaseFacts.ts). A register built from uploaded workbooks has no
 * prices, so most lines start "unknown" — that is deliberate: the rule fails
 * towards evidence, not towards convenience.
 */

export const ISSUE_PHOTO_THRESHOLD_INR = 1000;

export type IssuePhotoRule = 'required' | 'optional';

/** qty × unit price, or null when either is missing / not a positive number. */
export function issueLineValue(qty: number | string | null | undefined, unitPrice: number | null | undefined): number | null {
  const q = Number(qty);
  const p = unitPrice == null ? NaN : Number(unitPrice);
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p <= 0) return null;
  return Math.round(q * p * 100) / 100;
}

export function issuePhotoRule(lineValue: number | null): IssuePhotoRule {
  if (lineValue == null) return 'required';
  return lineValue > ISSUE_PHOTO_THRESHOLD_INR ? 'required' : 'optional';
}

/** Can this issue be confirmed with (or without) a photo? */
export function canConfirmIssue(lineValue: number | null, hasPhoto: boolean): boolean {
  return hasPhoto || issuePhotoRule(lineValue) === 'optional';
}
