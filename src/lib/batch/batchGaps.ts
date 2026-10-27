/**
 * Batch-number warnings for one reactor — warnings only, nothing is blocked or
 * renumbered. Catches a typed jump (P26-12 → P26-99) and earlier numbers that
 * are not on file (P38 starting at 084 with 001–083 missing).
 */
export type BatchWarning =
  | { kind: 'duplicate'; seq: number }
  | { kind: 'jump'; last: number; typed: number; skipped: [number, number] }
  | { kind: 'missing'; ranges: [number, number][]; more: number };

/** Ranges of whole numbers from 1 up to max(seqs) that are not in seqs. */
export function missingRanges(seqs: number[]): [number, number][] {
  const have = [...new Set(seqs.filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let expect = 1;
  for (const n of have) {
    if (n > expect) out.push([expect, n - 1]);
    expect = n + 1;
  }
  return out;
}

export function batchNumberWarnings(existing: number[], typed: number | null): BatchWarning[] {
  const warnings: BatchWarning[] = [];
  const have = existing.filter(n => Number.isInteger(n) && n > 0);
  const last = have.length ? Math.max(...have) : 0;
  if (typed != null && typed > 0) {
    if (have.includes(typed)) warnings.push({ kind: 'duplicate', seq: typed });
    else if (typed > last + 1) warnings.push({ kind: 'jump', last, typed, skipped: [last + 1, typed - 1] });
  }
  const gaps = missingRanges(have);
  if (gaps.length) warnings.push({ kind: 'missing', ranges: gaps.slice(0, 3), more: Math.max(0, gaps.length - 3) });
  return warnings;
}

/** "13–98" / "5". */
export function rangeText([a, b]: [number, number]): string {
  return a === b ? String(a) : `${a}–${b}`;
}
