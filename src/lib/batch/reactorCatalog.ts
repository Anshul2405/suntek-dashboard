/**
 * Official Batch Sheet reactor catalogue (client note, Aug 2026).
 *
 *   SCPL (Rehla)        P1  – P12
 *   SPPL (Rehla)        P13 – P27
 *   SPPL (K) (Rehla)    P28 – P32
 *   Madan Chemical      P33 – P43
 *   SCPL (Ganjam)       P44 – P49
 *
 * Drum Plant is excluded from Create Batch Sheet.
 */

export const BATCH_SHEET_EXCLUDED_FACTORY_CODES = new Set(['DRUM_REHLA']);

/** Inclusive P-number ranges keyed by plants.factory_code. */
export const REACTOR_RANGE_BY_FACTORY: Record<string, { from: number; to: number }> = {
  SCPL_REHLA: { from: 1, to: 12 },
  SPPL_REHLA: { from: 13, to: 27 },
  SPPLK_REHLA: { from: 28, to: 32 },
  MADAN_SIKANDRABAD: { from: 33, to: 43 },
  SCPL_GANJAM: { from: 44, to: 49 },
};

export interface BatchSheetPlantRef {
  id: string;
  name?: string | null;
  factory_code?: string | null;
}

export interface CatalogReactor {
  id: string;
  plant_id: string;
  code: string;
  name: string;
  sort_order: number;
}

/** True when this factory may appear on Create Batch Sheet. */
export function isBatchSheetPlant(p: BatchSheetPlantRef): boolean {
  if (p.factory_code && BATCH_SHEET_EXCLUDED_FACTORY_CODES.has(p.factory_code)) return false;
  if (/drum\s*plant/i.test(p.name || '')) return false;
  return true;
}

export function reactorRangeForPlant(p: BatchSheetPlantRef): { from: number; to: number } | null {
  if (p.factory_code && REACTOR_RANGE_BY_FACTORY[p.factory_code]) {
    return REACTOR_RANGE_BY_FACTORY[p.factory_code];
  }
  const n = (p.name || '').toLowerCase();
  if (/drum\s*plant/.test(n)) return null;
  if (/\bsppl\s*\(\s*k\s*\)/i.test(n) || /sppl\(k\)/i.test(n) || /spplk/i.test(n)) {
    return REACTOR_RANGE_BY_FACTORY.SPPLK_REHLA;
  }
  if (/\bsppl\b/i.test(n)) return REACTOR_RANGE_BY_FACTORY.SPPL_REHLA;
  if (n.includes('madan')) return REACTOR_RANGE_BY_FACTORY.MADAN_SIKANDRABAD;
  if (n.includes('ganjam')) return REACTOR_RANGE_BY_FACTORY.SCPL_GANJAM;
  if (n.includes('scpl') && n.includes('rehla')) return REACTOR_RANGE_BY_FACTORY.SCPL_REHLA;
  return null;
}

/** Synthetic reactor rows used when `reactors` table is missing or still on R-1…R-6. */
export function catalogReactorsForPlant(p: BatchSheetPlantRef): CatalogReactor[] {
  const range = reactorRangeForPlant(p);
  if (!range) return [];
  const rows: CatalogReactor[] = [];
  for (let n = range.from; n <= range.to; n++) {
    const code = `P${n}`;
    rows.push({
      id: `fallback:${p.id}:${code}`,
      plant_id: p.id,
      code,
      name: `Reactor ${code}`,
      sort_order: n,
    });
  }
  return rows;
}

/** Prefer DB rows only when they already use the official P-codes. */
export function preferCatalogIfDbStale<T extends { code: string }>(
  plant: BatchSheetPlantRef,
  dbRows: T[],
): { rows: CatalogReactor[]; usingCatalog: boolean } {
  const catalog = catalogReactorsForPlant(plant);
  if (!catalog.length) return { rows: [], usingCatalog: true };
  const dbLooksOfficial = dbRows.length > 0 && dbRows.every((r) => /^P\d+$/i.test(r.code));
  if (dbLooksOfficial) {
    return {
      rows: dbRows.map((r, i) => ({
        id: (r as { id?: string }).id ?? `db:${plant.id}:${r.code}`,
        plant_id: plant.id,
        code: r.code,
        name: (r as { name?: string }).name ?? `Reactor ${r.code}`,
        sort_order: (r as { sort_order?: number }).sort_order ?? i + 1,
      })),
      usingCatalog: false,
    };
  }
  return { rows: catalog, usingCatalog: true };
}

/** Client rule: batch no = reactor code + "-" + per-reactor sequence (P12-13). */
export function formatReactorBatchNo(reactorCode: string, seq: number): string {
  return `${reactorCode}-${seq}`;
}

export function parseReactorBatchSeq(batchNo: string, reactorCode?: string): number | null {
  if (reactorCode) {
    const esc = reactorCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^${esc}-(\\d+)$`, 'i').exec(batchNo);
    if (m) return parseInt(m[1], 10);
  }
  const m2 = /^P\d+-(\d+)$/i.exec(batchNo);
  return m2 ? parseInt(m2[1], 10) : null;
}

/** True for production-sheet style batch numbers (legacy PBS-* or P12-13). */
export function isProductionSheetBatchNo(batchNo: string): boolean {
  return /^PBS-/i.test(batchNo) || /^P\d+-\d+$/i.test(batchNo);
}
