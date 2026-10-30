/**
 * Batch-number warnings for one reactor — warnings only, nothing is blocked or
 * renumbered.
 *
 * Plants started typing sheets into the dashboard late, and some reactors carry
 * stray numbers (P1-105, P1-128, P26-99) or restarted their count (P39 went back
 * to 1 on 23/09 while 87–99 are still on file). So:
 * - numbers more than BLOCK_BREAK apart form separate blocks;
 * - the reactor's current block is the one holding its most recently created
 *   sheet (else the biggest block);
 * - "missing" only looks at the last RECENT_WINDOW numbers of that block, so the
 *   leading run before the dashboard era (P1 01–49, P2 01–43, P38 001–083) is
 *   never reported;
 * - a typed number is checked for a duplicate, and for a jump past the current
 *   block's last number (P26-12 → P26-99).
 * No stored start number per reactor is needed.
 */
export type BatchWarning =
  | { kind: 'duplicate'; seq: number }
  | { kind: 'jump'; last: number; typed: number; skipped: [number, number] }
  | { kind: 'missing'; ranges: [number, number][]; more: number };

/** A gap wider than this starts a new block (a typo or a restarted count). */
export const BLOCK_BREAK = 10;
/** Only this many numbers below the current block's last are checked for holes. */
export const RECENT_WINDOW = 10;

function clean(seqs: number[]): number[] {
  return [...new Set(seqs.filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/** Sorted numbers split where two neighbours are more than BLOCK_BREAK apart. */
export function blocksOf(seqs: number[]): number[][] {
  const have = clean(seqs);
  const out: number[][] = [];
  for (const n of have) {
    const cur = out[out.length - 1];
    if (cur && n - cur[cur.length - 1] <= BLOCK_BREAK) cur.push(n);
    else out.push([n]);
  }
  return out;
}

/** The block the reactor is working in now. */
export function currentBlock(seqs: number[], latestSeq?: number | null): number[] {
  const blocks = blocksOf(seqs);
  if (!blocks.length) return [];
  if (latestSeq != null) {
    const hit = blocks.find(b => b.includes(latestSeq));
    if (hit) return hit;
  }
  return blocks.reduce((best, b) => (b.length > best.length || (b.length === best.length && b[0] > best[0]) ? b : best), blocks[0]);
}

/** Holes among the last RECENT_WINDOW numbers of the current block. */
export function missingRanges(seqs: number[], latestSeq?: number | null): [number, number][] {
  const block = currentBlock(seqs, latestSeq);
  if (!block.length) return [];
  const last = block[block.length - 1];
  const from = Math.max(block[0], last - RECENT_WINDOW);
  // Start from the last number before the window, so a hole right at its edge counts.
  const below = block.filter(n => n < from);
  const out: [number, number][] = [];
  let expect = below.length ? Math.max(from, below[below.length - 1] + 1) : from;
  for (const n of block.filter(x => x >= from)) {
    if (n > expect) out.push([expect, n - 1]);
    expect = n + 1;
  }
  return out;
}

export function batchNumberWarnings(existing: number[], typed: number | null, latestSeq?: number | null): BatchWarning[] {
  const warnings: BatchWarning[] = [];
  const have = clean(existing);
  const block = currentBlock(have, latestSeq);
  const last = block.length ? block[block.length - 1] : 0;
  if (typed != null && typed > 0) {
    if (have.includes(typed)) warnings.push({ kind: 'duplicate', seq: typed });
    // The first sheet of a reactor sets its start — nothing to jump from.
    else if (last && typed > last + 1) warnings.push({ kind: 'jump', last, typed, skipped: [last + 1, typed - 1] });
  }
  const gaps = missingRanges(have, latestSeq);
  if (gaps.length) warnings.push({ kind: 'missing', ranges: gaps.slice(0, 3), more: Math.max(0, gaps.length - 3) });
  return warnings;
}

/** "13–98" / "5". */
export function rangeText([a, b]: [number, number]): string {
  return a === b ? String(a) : `${a}–${b}`;
}
