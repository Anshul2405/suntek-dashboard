/**
 * CPW batch-sheet yield (from plant workflow PDF).
 *
 * Oil CON ratio (g per kg CP) =
 *   paraffinWeightKg / netCpKg * 1000
 *
 * where netCpKg = (drumsFilled × 250) + closingBalance − openingBalance
 * One drum = 250 kg (workflow spec).
 */

export const KG_PER_DRUM_SHEET = 250;

export interface SheetYieldInput {
  paraffinWeightKg: number;
  drumsFilled: number;
  openingBalanceKg: number;
  closingBalanceKg: number;
  /** Drum size in kg — default 250 per plant workflow. */
  kgPerDrum?: number;
}

export interface SheetYieldResult {
  netCpKg: number;
  /** g oil consumed per kg of CP produced */
  oilConRatioGPerKg: number | null;
  /** paraffin / netCp (unitless) */
  oilPerCpRatio: number | null;
  ok: boolean;
  message: string;
}

export function computeSheetOilConRatio(input: SheetYieldInput): SheetYieldResult {
  const kgPerDrum = input.kgPerDrum ?? KG_PER_DRUM_SHEET;
  const netCpKg =
    input.drumsFilled * kgPerDrum + input.closingBalanceKg - input.openingBalanceKg;

  if (!(input.paraffinWeightKg > 0)) {
    return {
      netCpKg,
      oilConRatioGPerKg: null,
      oilPerCpRatio: null,
      ok: false,
      message: 'Paraffin weight is required to compute oil CON ratio.',
    };
  }
  if (!(netCpKg > 0)) {
    return {
      netCpKg,
      oilConRatioGPerKg: null,
      oilPerCpRatio: null,
      ok: false,
      message: `Net CP is ${netCpKg} kg — check drums (${input.drumsFilled}×${kgPerDrum}), opening (${input.openingBalanceKg}), closing (${input.closingBalanceKg}).`,
    };
  }

  const oilPerCpRatio = input.paraffinWeightKg / netCpKg;
  const oilConRatioGPerKg = oilPerCpRatio * 1000;

  return {
    netCpKg,
    oilConRatioGPerKg,
    oilPerCpRatio,
    ok: true,
    message: `Net CP ${netCpKg.toFixed(1)} kg · Oil CON ${oilConRatioGPerKg.toFixed(1)} g/kg CP`,
  };
}
