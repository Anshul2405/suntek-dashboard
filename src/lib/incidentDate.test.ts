import { describe, it, expect } from 'vitest';
import { incidentWhenWarning } from './incidentDate';

describe('incident When warning', () => {
  const now = new Date('2026-10-13T13:16:00+05:30').getTime();
  it('flags a day/month swap (2 Oct saved as 10 Feb)', () => {
    expect(incidentWhenWarning('2026-02-10T00:00', now)).toBe('old');
  });
  it('flags a date after now', () => {
    expect(incidentWhenWarning('2026-12-10T09:00', now)).toBe('future');
  });
  it('accepts a recent date and an empty box', () => {
    expect(incidentWhenWarning('2026-10-02T10:30', now)).toBeNull();
    expect(incidentWhenWarning('', now)).toBeNull();
  });
});
