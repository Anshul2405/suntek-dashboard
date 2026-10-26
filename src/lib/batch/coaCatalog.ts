/**
 * Certificate of Analysis (COA) parameter catalogue.
 *
 * Standard column values are derived from the same NP / HNP TDS grade tables
 * used for printing TDS (A1–A5 / H1–H5), keyed by batch density — so COA
 * Spec-1300 matches TDS grade A2, not always Spec-1200.
 */

import {
  gradeCodeFor,
  nearestOilRatioBand,
  tdsCell,
  type TdsFamily,
} from './tdsCatalog';

export type CoaParamKey =
  | 'color_hazen'
  | 'chlorine_content'
  | 'specific_gravity'
  | 'viscosity_35c'
  | 'free_mineral_acidity'
  | 'free_chlorine'
  | 'volatile_loss'
  | 'thermal_stability'
  | 'heat_stability'
  | 'ph'
  | 'refractive_index';

export interface CoaParamDef {
  key: CoaParamKey;
  sno: number;
  /** Display label matching the printed COA. */
  parameter: string;
  /** Printed STANDARD for this gravity band. */
  standard: string;
  /** Prefer numeric vs free-text result entry. */
  resultKind: 'number' | 'text';
}

/** COA row → TDS particulars row index (see tdsCatalog.TDS_PARTICULARS). */
const COA_TDS_ROW: Record<CoaParamKey, number> = {
  color_hazen: 0,
  chlorine_content: 1,
  specific_gravity: 2,
  viscosity_35c: 3,
  free_mineral_acidity: 4,
  free_chlorine: 5,
  volatile_loss: 6,
  thermal_stability: 7,
  heat_stability: 8,
  ph: 9,
  refractive_index: 10,
};

const COA_PARAM_TEMPLATE: Omit<CoaParamDef, 'standard'>[] = [
  { key: 'color_hazen', sno: 1, parameter: 'Color, Hazen Unit, Max', resultKind: 'number' },
  { key: 'chlorine_content', sno: 2, parameter: 'Chlorine Contents %, m/m', resultKind: 'number' },
  { key: 'specific_gravity', sno: 3, parameter: 'Specific Gravity at 30°C, By Hydrometer', resultKind: 'number' },
  { key: 'viscosity_35c', sno: 4, parameter: 'Viscosity at 30°C, Ford Cup 4mm, Poise', resultKind: 'number' },
  { key: 'free_mineral_acidity', sno: 5, parameter: 'Free Mineral Acidity, % by weight, Max', resultKind: 'number' },
  { key: 'free_chlorine', sno: 6, parameter: 'Free Chlorine, PPM', resultKind: 'text' },
  { key: 'volatile_loss', sno: 7, parameter: 'Volatile Loss at 130°C/3Hrs, % by mass, Max', resultKind: 'number' },
  { key: 'thermal_stability', sno: 8, parameter: 'Thermal Stability as % HCL after 4 hr at 175°C, Max', resultKind: 'number' },
  { key: 'heat_stability', sno: 9, parameter: 'Heat Stability at 200°C/20 min', resultKind: 'text' },
  { key: 'ph', sno: 10, parameter: 'pH', resultKind: 'number' },
  { key: 'refractive_index', sno: 11, parameter: 'Refractive Index', resultKind: 'number' },
];

/** Legacy export — Spec-1200 defaults (grade A1 / H1). Prefer coaParamsForGravity(). */
export const COA_PARAMS_1200: CoaParamDef[] = coaParamsForGravity(1200, 'NP');

/**
 * Resolve the gravity band for COA standards.
 * Uses typed oil_ratio when numeric; otherwise batch density (same rule as TDS).
 */
export function resolveCoaGravity(density: number, oilRatio?: number | string | null): number {
  if (oilRatio != null && oilRatio !== '') {
    const cleaned = String(oilRatio).trim().replace(/,/g, '').replace(/%/g, '');
    if (!/[a-zA-Z]/.test(cleaned)) {
      const n = Number(cleaned);
      if (Number.isFinite(n) && n > 0) {
        const ratio = n < 10 ? Math.round(n * 1000) : Math.round(n);
        return nearestOilRatioBand(ratio);
      }
    }
  }
  return nearestOilRatioBand(density);
}

export function coaFamilyFromGrade(oilGrade?: string | null): TdsFamily {
  return oilGrade?.trim().toUpperCase() === 'HNP' ? 'HNP' : 'NP';
}

/**
 * Printed STANDARD column on the plant COA for NP 1.20 (grade A1).
 * Taken from the SPPL Rehla certificate — several limits differ from the TDS sheet.
 */
const COA_NP_1200_STANDARD: Partial<Record<CoaParamKey, string>> = {
  color_hazen: '30',
  chlorine_content: '42 ± 2',
  specific_gravity: '1.2 ± 0.02',
  viscosity_35c: '1 - 5',
  free_mineral_acidity: '0.01',
  free_chlorine: 'NIL',
  volatile_loss: '1.5',
  thermal_stability: '0.10',
  heat_stability: 'Light yellow',
  ph: '6 - 7',
  refractive_index: '>1.49',
};

/** Standard column for COA — one row per parameter for the given gravity + family. */
export function coaParamsForGravity(gravity: number, family: TdsFamily = 'NP'): CoaParamDef[] {
  const band = nearestOilRatioBand(gravity);
  const grade = gradeCodeFor(family, band);
  const letter = family === 'NP' && grade === 'A1' ? COA_NP_1200_STANDARD : null;
  return COA_PARAM_TEMPLATE.map((p) => ({
    ...p,
    standard: letter?.[p.key] ?? presentCoaStandard(p.key, tdsCell(family, grade, COA_TDS_ROW[p.key])),
  }));
}

/** Certificate writes chlorine as "42 ± 2", and puts spaces around ±. */
function presentCoaStandard(key: CoaParamKey, raw: string): string {
  const trimmed = raw.trim();
  if (key === 'chlorine_content') {
    const m = /^±\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
    if (m) return `${m[1]} ± 2`;
  }
  return trimmed.replace(/±/g, ' ± ').replace(/\s+/g, ' ').trim();
}

export function coaSpecLabel(gravity: number, family: TdsFamily = 'NP'): string {
  const band = nearestOilRatioBand(gravity);
  const grade = gradeCodeFor(family, band);
  return `Spec-${band} · grade ${grade}`;
}

/** Printed COA product name — oil ratio is internal only, not shown on the certificate. */
export function coaProductName(): string {
  return 'CHLORINATED PARAFFIN PLASTICIZER';
}
