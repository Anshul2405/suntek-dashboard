import { describe, expect, it } from 'vitest';
import { computeSheetOilConRatio, KG_PER_DRUM_SHEET } from './batchSheetYield';

describe('computeSheetOilConRatio', () => {
  it('uses 250 kg per drum from the workflow PDF', () => {
    expect(KG_PER_DRUM_SHEET).toBe(250);
  });

  it('matches the workflow example: 3000 / ((27×250)+70−0)', () => {
    const r = computeSheetOilConRatio({
      paraffinWeightKg: 3000,
      drumsFilled: 27,
      openingBalanceKg: 0,
      closingBalanceKg: 70,
    });
    expect(r.ok).toBe(true);
    expect(r.netCpKg).toBe(27 * 250 + 70);
    // 3000 / 6820 * 1000 ≈ 439.88
    expect(r.oilConRatioGPerKg!).toBeCloseTo((3000 / 6820) * 1000, 1);
  });

  it('matches dummy sheet numbers: 28 drums, open 40, close 60, paraffin 3000', () => {
    const r = computeSheetOilConRatio({
      paraffinWeightKg: 3000,
      drumsFilled: 28,
      openingBalanceKg: 40,
      closingBalanceKg: 60,
    });
    expect(r.netCpKg).toBe(28 * 250 + 60 - 40); // 7020
    expect(r.oilConRatioGPerKg!).toBeCloseTo((3000 / 7020) * 1000, 1);
  });

  it('fails when net CP is zero/negative', () => {
    const r = computeSheetOilConRatio({
      paraffinWeightKg: 3000,
      drumsFilled: 0,
      openingBalanceKg: 100,
      closingBalanceKg: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.oilConRatioGPerKg).toBeNull();
  });
});
