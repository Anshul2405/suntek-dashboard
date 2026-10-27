import { describe, it, expect } from 'vitest';
import { batchNumberWarnings, missingRanges, rangeText } from './batchGaps';

describe('batch number warnings', () => {
  it('warns on a jump (P26-12 then P26-99)', () => {
    const seqs = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(batchNumberWarnings(seqs, 99)).toEqual([{ kind: 'jump', last: 12, typed: 99, skipped: [13, 98] }]);
    expect(batchNumberWarnings(seqs, 13)).toEqual([]);
  });

  it('warns that earlier numbers are not on file (P38 starts at 084)', () => {
    const seqs = [84, 85, 86];
    const w = batchNumberWarnings(seqs, 87);
    expect(w).toEqual([{ kind: 'missing', ranges: [[1, 83]], more: 0 }]);
    expect(rangeText([1, 83])).toBe('1–83');
  });

  it('flags a number already used', () => {
    expect(batchNumberWarnings([1, 2, 3], 2)[0]).toEqual({ kind: 'duplicate', seq: 2 });
  });

  it('lists gaps in order, at most three', () => {
    expect(missingRanges([2, 4, 7, 9, 12])).toEqual([[1, 1], [3, 3], [5, 6], [8, 8], [10, 11]]);
    expect(batchNumberWarnings([2, 4, 7, 9, 12], 13)[0]).toMatchObject({ kind: 'missing', more: 2 });
  });
});
