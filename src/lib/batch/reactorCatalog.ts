/**
 * Official Batch Sheet reactor catalogue (client note, Aug 2026 / meet Aug 2026).
 *
 *   SCPL (Rehla)        P1  – P12   (12)  → Reactor 1(P1) … Reactor 12(P12)
 *   SPPL (Rehla)        P13 – P28   (16)  → Reactor 1(P13) … Reactor 16(P28)
 *   SPPL (K) (Rehla)    P29 – P32   (4)   → Reactor 1(P29) … Reactor 4(P32)
 *   Madan Chemical      P33 – P43   (11)
 *   SCPL (Ganjam)       P44 – P49   (6)
 *
 * Drum Plant is excluded from Create Batch Sheet.
 */

export const BATCH_SHEET_EXCLUDED_FACTORY_CODES = new Set(['DRUM_REHLA']);

/** Inclusive P-number ranges keyed by plants.factory_code. */
export const REACTOR_RANGE_BY_FACTORY: Record<string, { from: number; to: number }> = {
  SCPL_REHLA: { from: 1, to: 12 },
  SPPL_REHLA: { from: 13, to: 28 },
  SPPLK_REHLA: { from: 29, to: 32 },
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

/**
 * Display name within a plant: Reactor 1(P33), Reactor 2(P34), …
 * Local index resets per plant (Madan P33–P43 → 1–11; Ganjam P44–P49 → 1–6).
 */
export function formatReactorLabel(localIndex: number, code: string): string {
  return `Reactor ${localIndex}(${code})`;
}

function localIndexForCode(code: string, range: { from: number; to: number }, fallback: number): number {
  const m = /^P(\d+)$/i.exec(code);
  if (!m) return fallback;
  const pNum = parseInt(m[1], 10);
  if (!Number.isFinite(pNum) || pNum < range.from || pNum > range.to) return fallback;
  return pNum - range.from + 1;
}

/** Synthetic reactor rows used when `reactors` table is missing or still on R-1…R-6. */
export function catalogReactorsForPlant(p: BatchSheetPlantRef): CatalogReactor[] {
  const range = reactorRangeForPlant(p);
  if (!range) return [];
  const rows: CatalogReactor[] = [];
  for (let n = range.from; n <= range.to; n++) {
    const code = `P${n}`;
    const localIndex = n - range.from + 1;
    rows.push({
      id: `fallback:${p.id}:${code}`,
      plant_id: p.id,
      code,
      name: formatReactorLabel(localIndex, code),
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
  const range = reactorRangeForPlant(plant)!;
  const dbLooksOfficial = dbRows.length > 0 && dbRows.every((r) => /^P\d+$/i.test(r.code));
  if (dbLooksOfficial) {
    return {
      rows: dbRows.map((r, i) => {
        const code = r.code;
        const localIndex = localIndexForCode(code, range, i + 1);
        return {
          id: (r as { id?: string }).id ?? `db:${plant.id}:${code}`,
          plant_id: plant.id,
          code,
          // Always use plant-local labels — DB may still have legacy "Reactor P33".
          name: formatReactorLabel(localIndex, code),
          sort_order: (r as { sort_order?: number }).sort_order ?? i + 1,
        };
      }),
      usingCatalog: false,
    };
  }
  return { rows: catalog, usingCatalog: true };
}

/** Client rule: batch no = reactor code + "-" + per-reactor sequence (P12-13). */
export function formatReactorBatchNo(reactorCode: string, seq: number): string {
  return `${reactorCode}-${seq}`;
}

/** Prefix auto-filled when a reactor is selected — user types digits after the hyphen. */
export function reactorBatchPrefix(reactorCode: string): string {
  return `${reactorCode.trim().toUpperCase()}-`;
}

/** True when batch no matches P{reactor}-digits (e.g. P33-04, P12-13). */
export function isValidReactorBatchNo(batchNo: string, reactorCode: string): boolean {
  const code = reactorCode.trim();
  if (!code) return false;
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}-\\d+$`, 'i').test(batchNo.trim());
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
