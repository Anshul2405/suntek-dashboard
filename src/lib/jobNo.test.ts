import { describe, it, expect } from 'vitest';
import {
  assignSequentialJobNos,
  formatJobNo,
  isPlaceholderMark,
  nextJobNo,
  parseJobSeq,
  stripPlaceholderParen,
} from './jobNo';

describe('placeholder marks', () => {
  it('treats xxx / n-a / dashes as placeholders', () => {
    expect(isPlaceholderMark('xxx')).toBe(true);
    expect(isPlaceholderMark('(xxx)')).toBe(false);
    expect(isPlaceholderMark('n/a')).toBe(true);
    expect(isPlaceholderMark('HCL AB10')).toBe(false);
  });

  it('strips (xxx) from PM titles', () => {
    expect(stripPlaceholderParen('Cooling Tower (xxx) — Daily')).toBe('Cooling Tower — Daily');
    expect(stripPlaceholderParen('Pump (HPT 1)')).toBe('Pump (HPT 1)');
  });
});

describe('sequential job nos', () => {
  it('formats FAR-001 / STK-012', () => {
    expect(formatJobNo('FAR', 1)).toBe('FAR-001');
    expect(formatJobNo('STK', 12)).toBe('STK-012');
    expect(parseJobSeq('far-7')).toEqual({ prefix: 'FAR', n: 7 });
  });

  it('honours persisted numbers and fills the rest in created_at order', () => {
    const map = assignSequentialJobNos([
      { id: 'b', created_at: '2026-02-01', job_no: null },
      { id: 'a', created_at: '2026-01-01', job_no: null },
      { id: 'c', created_at: '2026-03-01', job_no: 'FAR-010' },
    ], 'FAR');
    expect(map.get('a')).toBe('FAR-001');
    expect(map.get('c')).toBe('FAR-010');
    expect(map.get('b')).toBe('FAR-011');
  });

  it('nextJobNo continues after the highest existing code', () => {
    expect(nextJobNo(['FAR-001', 'FAR-004', 'skip'], 'FAR')).toBe('FAR-005');
    expect(nextJobNo([], 'STK')).toBe('STK-001');
  });

  it('does not truncate numbers past 999', () => {
    expect(formatJobNo('FAR', 1000)).toBe('FAR-1000');
    expect(parseJobSeq('FAR-1056')).toEqual({ prefix: 'FAR', n: 1056 });
  });
});
