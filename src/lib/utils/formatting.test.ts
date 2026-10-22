import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, istDayKey, inIstDayRange, normalizeDayRange, istRangeToIso } from './formatting';

describe('IST date formatting', () => {
  it('formats as 22 Oct 2026', () => {
    expect(formatDate('2026-10-22T06:00:00Z')).toBe('22 Oct 2026');
    expect(formatDate('2026-10-22')).toBe('22 Oct 2026');
  });
  it('uses the IST calendar day, not UTC', () => {
    // 20:00 UTC on the 21st is 01:30 IST on the 22nd.
    expect(formatDate('2026-10-21T20:00:00Z')).toBe('22 Oct 2026');
    expect(istDayKey('2026-10-21T20:00:00Z')).toBe('2026-10-22');
  });
  it('adds the time after the date', () => {
    expect(formatDateTime('2026-10-22T09:35:00Z')).toBe('22 Oct 2026, 3:05 pm');
  });
  it('degrades to a dash', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('nonsense')).toBe('—');
  });
});

describe('inclusive IST day range', () => {
  const lateNight = '2026-10-21T20:00:00Z'; // 22 Oct IST
  it('empty bounds mean no filter', () => {
    expect(inIstDayRange(lateNight, '', '')).toBe(true);
    expect(inIstDayRange(null, '', '')).toBe(true);
  });
  it('is inclusive of both ends in IST', () => {
    expect(inIstDayRange(lateNight, '2026-10-22', '2026-10-22')).toBe(true);
    expect(inIstDayRange(lateNight, '2026-10-21', '2026-10-21')).toBe(false);
    expect(inIstDayRange('2026-10-22T18:29:00Z', '', '2026-10-22')).toBe(true); // 23:59 IST
    expect(inIstDayRange('2026-10-22T18:31:00Z', '', '2026-10-22')).toBe(false); // 00:01 IST 23rd
  });
  it('swaps a To before From instead of emptying', () => {
    expect(normalizeDayRange('2026-10-25', '2026-10-20')).toEqual({ from: '2026-10-20', to: '2026-10-25', swapped: true });
    expect(inIstDayRange('2026-10-22T06:00:00Z', '2026-10-25', '2026-10-20')).toBe(true);
  });
  it('builds ISO bounds for server filters', () => {
    expect(istRangeToIso('2026-10-22', '2026-10-22')).toEqual({
      start: '2026-10-21T18:30:00.000Z', endExclusive: '2026-10-22T18:30:00.000Z',
    });
    expect(istRangeToIso('', '')).toEqual({});
  });
});
