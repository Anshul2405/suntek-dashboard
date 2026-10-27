// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { billBufferDays, daysBeforeToday, needsLateApproval } from './datePolicy';

describe('date policy', () => {
  const now = new Date(2026, 8, 30, 15, 0, 0);

  it('allows today and the two-day buffer', () => {
    expect(needsLateApproval('2026-09-30', 2, now)).toBe(false);
    expect(needsLateApproval('2026-09-28', 2, now)).toBe(false);
    expect(daysBeforeToday('2026-09-28', now)).toBe(2);
  });

  it('requires management approval after the buffer', () => {
    expect(needsLateApproval('2026-09-27', 2, now)).toBe(true);
    expect(needsLateApproval('2026-09-29', 1, now)).toBe(false);
    expect(needsLateApproval('2026-09-28', 1, now)).toBe(true);
  });

  it('uses each plant’s own late-bill days, and the tighter number when a row spans plants', () => {
    const byPlant = { jharkhand: 5, sikandrabad: 2 };
    expect(billBufferDays(['jharkhand'], byPlant, 2)).toBe(5);
    expect(billBufferDays(['sikandrabad'], byPlant, 2)).toBe(2);
    expect(billBufferDays(['ganjam'], byPlant, 2)).toBe(2);
    expect(billBufferDays(['jharkhand', 'sikandrabad'], byPlant, 2)).toBe(2);
    expect(needsLateApproval('2026-09-24', billBufferDays(['jharkhand'], byPlant, 2), now)).toBe(true);
    expect(needsLateApproval('2026-09-25', billBufferDays(['jharkhand'], byPlant, 2), now)).toBe(false);
  });

  it('counts the IST day — 01:30 IST is already the next day though UTC is not', () => {
    const earlyIst = new Date('2026-09-30T20:00:00Z'); // 1 Oct 01:30 IST
    expect(daysBeforeToday('2026-09-28', earlyIst)).toBe(3);
    expect(needsLateApproval('2026-09-28', 2, earlyIst)).toBe(true);
  });
});
