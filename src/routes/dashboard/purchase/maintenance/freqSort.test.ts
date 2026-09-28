import { describe, expect, it } from 'vitest';
import { FREQ_OPTIONS, freqSortRank } from './shared';

describe('freqSortRank', () => {
  it('puts daily before weekly and monthly', () => {
    expect(freqSortRank('daily')).toBeLessThan(freqSortRank('weekly'));
    expect(freqSortRank('weekly')).toBeLessThan(freqSortRank('monthly'));
    expect(freqSortRank('monthly')).toBeLessThan(freqSortRank('annual'));
  });

  it('follows FREQ_OPTIONS order, not alphabetical', () => {
    const alpha = [...FREQ_OPTIONS].sort((a, b) => a.localeCompare(b));
    expect(alpha[0]).not.toBe('daily');
    expect(FREQ_OPTIONS[0]).toBe('daily');
    expect([...FREQ_OPTIONS].sort((a, b) => freqSortRank(a) - freqSortRank(b))).toEqual(FREQ_OPTIONS);
  });
});
