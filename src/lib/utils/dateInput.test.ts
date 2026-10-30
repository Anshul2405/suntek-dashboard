import { describe, it, expect } from 'vitest';
import { dayInRange, isoToDmy, parseDmy } from './dateInput';

describe('dd/mm/yyyy date box', () => {
  it('shows ISO as dd/mm/yyyy', () => {
    expect(isoToDmy('2026-10-02')).toBe('02/10/2026');
    expect(isoToDmy('')).toBe('');
  });

  it('reads day first, never month first', () => {
    expect(parseDmy('02/10/2026')).toBe('2026-10-02');
    expect(parseDmy('2/10/2026')).toBe('2026-10-02');
    expect(parseDmy('02-10-26')).toBe('2026-10-02');
    expect(parseDmy('02.10.2026')).toBe('2026-10-02');
    expect(parseDmy('02102026')).toBe('2026-10-02');
    expect(parseDmy('2026-10-02')).toBe('2026-10-02');
  });

  it('refuses impossible days', () => {
    expect(parseDmy('31/02/2026')).toBe(null);
    expect(parseDmy('13/13/2026')).toBe(null);
    expect(parseDmy('10/2026')).toBe(null);
    expect(parseDmy('')).toBe(null);
    expect(parseDmy('29/02/2028')).toBe('2028-02-29');
  });

  it('checks min / max on days', () => {
    expect(dayInRange('2026-10-30', '', '2026-10-29')).toBe(false);
    expect(dayInRange('2026-10-30')).toBe(true);
  });
});
