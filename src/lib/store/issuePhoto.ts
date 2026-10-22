/** Own-store issues above this rupee value need a part photo. */
export const STORE_ISSUE_PHOTO_THRESHOLD = 1000;

export function issueLineValue(
  total: number | null | undefined,
  unitPrice: number | null | undefined,
  qty: number | null | undefined,
): number | null {
  if (total != null && Number.isFinite(Number(total))) return Number(total);
  if (unitPrice != null && Number.isFinite(Number(unitPrice))) {
    return Number(unitPrice) * (Number(qty) > 0 ? Number(qty) : 1);
  }
  return null;
}

/** Photo is mandatory when the line is worth more than ₹1,000, or the value is unknown. */
export function storeIssueNeedsPhoto(value: number | null | undefined): boolean {
  if (value == null || !Number.isFinite(value)) return true;
  return value > STORE_ISSUE_PHOTO_THRESHOLD;
}
