/**
 * Static Technical Data Sheet (TDS) catalogues for Suntek CPW.
 * Sourced from client NP Grade / HNP Grade PDFs (Aug 2026).
 *
 * Gravity mapping (Specific Gravity × 1000 → oil_ratio / grade column):
 *   1.20 → 1200 → A1 / H1
 *   1.30 → 1300 → A2 / H2
 *   1.35 → 1350 → A3 / H3
 *   1.40 → 1400 → A4 / H4
 *   1.45 → 1450 → A5 / H5
 */

export type TdsFamily = 'NP' | 'HNP';
export type NpGrade = 'A1' | 'A2' | 'A3' | 'A4' | 'A5';
export type HnpGrade = 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
export type TdsGradeCode = NpGrade | HnpGrade;

export const TDS_PARTICULARS = [
  'Color Hazen (HU)',
  'Chlorine contents wt%',
  'Specific Gravity at 27°C by Hydrometer',
  'Viscosity (at 27°C) Poise',
  'Free Mineral Acidity % (KOH/mg)',
  'Free Chlorine, ppm',
  'Volatile Loss (130°C/3Hours) Percentage by mass',
  'Thermal stability (as Hcl w/w%)',
  'Heat Stability (180°C/20 min)',
  'pH value',
  'Refractive Index',
] as const;

/** NP grades A1–A5 — values per particular (row order = TDS_PARTICULARS). */
export const NP_GRADE_VALUES: Record<NpGrade, string[]> = {
  A1: ['30', '±42', '1.2±0.02', '1-3', '0.01', 'NIL', '3', '0.2', 'Light yellow', '6', '1.5±0.02'],
  A2: ['30', '±52', '1.3±0.02', '5-15', '0.01', 'NIL', '1.5', '0.2', 'Light yellow', '6', '1.5±0.02'],
  A3: ['50', '±58', '1.35±0.02', '20-35', '0.01', 'NIL', '1.2', '0.2', 'Yellow', '6', '1.5±0.02'],
  A4: ['40', '±62', '1.4±0.02', '50-150', '0.01', 'NIL', '0.8', '0.2', 'Yellow', '6', '1.5±0.02'],
  A5: ['50', '±68', '1.45±0.02', '180-700', '0.01', 'NIL', '0.58', '0.2', 'Brown', '6', '1.5±0.02'],
};

/** HNP grades H1–H5. */
export const HNP_GRADE_VALUES: Record<HnpGrade, string[]> = {
  H1: ['50', '±42', '1.2±0.02', '2-5', '0.01', 'NIL', '1.8', '0.1', 'Light yellow', '6', '1.5±0.02'],
  H2: ['60', '±52', '1.3±0.02', '12-35', '0.01', 'NIL', '1.2', '0.1', 'Light yellow', '6', '1.5±0.02'],
  H3: ['60', '±58', '1.35±0.02', '50-200', '0.01', 'NIL', '1', '0.1', 'Light yellow', '6', '1.5±0.02'],
  H4: ['70', '±62', '1.4±0.02', '300-700', '0.01', 'NIL', '0.7', '0.1', 'Yellow', '6', '1.5±0.02'],
  H5: ['100', '±68', '1.45±0.02', '500-2000', '0.01', 'NIL', '0.5', '0.1', 'Light Brown', '6', '1.5±0.02'],
};

export const OIL_RATIO_BANDS = [1200, 1300, 1350, 1400, 1450] as const;

const GRAVITY_TO_INDEX: { ratio: number; idx: number }[] = [
  { ratio: 1200, idx: 0 },
  { ratio: 1300, idx: 1 },
  { ratio: 1350, idx: 2 },
  { ratio: 1400, idx: 3 },
  { ratio: 1450, idx: 4 },
];

/** Nearest reference gravity band (1200 … 1450) for a measured density / ratio. */
export function nearestOilRatioBand(oilRatio: number | null | undefined): number {
  const idx = oilRatioToGradeIndex(oilRatio);
  return OIL_RATIO_BANDS[idx] ?? 1200;
}

export function oilRatioToGradeIndex(oilRatio: number | null | undefined): number {
  if (oilRatio == null || !Number.isFinite(oilRatio)) return 0;
  let best = 0;
  let bestDiff = Infinity;
  for (const g of GRAVITY_TO_INDEX) {
    const d = Math.abs(g.ratio - oilRatio);
    if (d < bestDiff) { bestDiff = d; best = g.idx; }
  }
  return best;
}

export function gradeCodeFor(family: TdsFamily, oilRatio: number | null | undefined): TdsGradeCode {
  const idx = oilRatioToGradeIndex(oilRatio);
  if (family === 'HNP') return (['H1', 'H2', 'H3', 'H4', 'H5'] as HnpGrade[])[idx];
  return (['A1', 'A2', 'A3', 'A4', 'A5'] as NpGrade[])[idx];
}

export function tdsGradeColumns(family: TdsFamily): TdsGradeCode[] {
  return family === 'HNP'
    ? (['H1', 'H2', 'H3', 'H4', 'H5'] as HnpGrade[])
    : (['A1', 'A2', 'A3', 'A4', 'A5'] as NpGrade[]);
}

export function tdsCell(family: TdsFamily, grade: TdsGradeCode, rowIdx: number): string {
  const table = family === 'HNP' ? HNP_GRADE_VALUES : NP_GRADE_VALUES;
  return (table as Record<string, string[]>)[grade]?.[rowIdx] ?? '—';
}

export const TDS_BLURB =
  'Suntek CPW (Chlorinated Paraffin Wax) is a chlorinated hydrocarbon used primarily as a secondary plasticizer and flame retardant in PVC compounds, rubber products, paints, sealants, adhesives, and other polymer-based applications. It enhances flexibility, chemical resistance, and flame-retardant properties of end-use materials.';

export const TDS_APPEARANCE = 'Appearance: Clear to pale yellow viscous liquid';
