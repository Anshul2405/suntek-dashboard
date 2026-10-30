import { describe, it, expect } from 'vitest';
import { batchNumberWarnings, blocksOf, currentBlock, missingRanges, rangeText } from './batchGaps';

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('batch number warnings', () => {
  it('warns on a jump (P26-12 then P26-99)', () => {
    const seqs = range(1, 12);
    expect(batchNumberWarnings(seqs, 99)).toEqual([{ kind: 'jump', last: 12, typed: 99, skipped: [13, 98] }]);
    expect(batchNumberWarnings(seqs, 13)).toEqual([]);
  });

  it('a reactor starts at its first number on file (P38 from 084: 001–083 are not missing)', () => {
    expect(batchNumberWarnings(range(84, 112), 113)).toEqual([]);
  });

  it('reactor 01: leading 08–49 run and stray P1-105 / P1-128 do not nag', () => {
    // Live P1 on 29/10/2026: 8–11, 15–50, plus 105 and 128 typed by mistake.
    const p1 = [...range(8, 11), ...range(15, 50), 105, 128];
    expect(currentBlock(p1)).toEqual([...range(8, 11), ...range(15, 50)]);
    expect(missingRanges(p1)).toEqual([]);
    expect(batchNumberWarnings(p1, 51)).toEqual([]);
  });

  it('reactor 02: leading 07–43 with holes is not reported', () => {
    const p2 = [7, 8, ...range(12, 22), ...range(24, 45)];
    expect(batchNumberWarnings(p2, 46)).toEqual([]);
  });

  it('every reactor: a hole in the recent ten is still reported', () => {
    // P15 on live: 21–40 without 30.
    const p15 = [...range(21, 29), ...range(31, 40)];
    expect(batchNumberWarnings(p15, 41)).toEqual([{ kind: 'missing', ranges: [[30, 30]], more: 0 }]);
    expect(rangeText([30, 30])).toBe('30');
    expect(rangeText([86, 87])).toBe('86–87');
  });

  it('a restarted count follows the newest sheet (P39 back at 1 while 87–99 remain)', () => {
    const p39 = [...range(1, 20), ...range(87, 99)];
    expect(blocksOf(p39)).toHaveLength(2);
    expect(batchNumberWarnings(p39, 21, 20)).toEqual([]);
    expect(batchNumberWarnings(p39, 23, 20)[0]).toMatchObject({ kind: 'jump', last: 20 });
  });

  it('a stray number on file (P26-99) is not the "last" for the next sheet', () => {
    const p26 = [...range(28, 52), 99];
    expect(batchNumberWarnings(p26, 53)).toEqual([]);
    expect(batchNumberWarnings(p26, 99)[0]).toEqual({ kind: 'duplicate', seq: 99 });
  });

  it('the first sheet of a reactor sets its start (no jump from 0)', () => {
    expect(batchNumberWarnings([], 84)).toEqual([]);
  });

  it('flags a number already used', () => {
    expect(batchNumberWarnings([1, 2, 3], 2)[0]).toEqual({ kind: 'duplicate', seq: 2 });
  });
});
