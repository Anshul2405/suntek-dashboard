/**
 * Batch-wise stock ledger (batch_stock_movements, migration 0041).
 *
 * Every change to a batch's stock is one row with a SIGNED drum quantity:
 *   opening, production, transfer_in, return   → positive
 *   dispatch, transfer_out                      → negative
 *   adjustment                                  → either sign (never 0)
 * On hand for a batch = the sum of its rows. A batch number on a sheet is not
 * stock by itself — until something is posted the batch has "no movements yet".
 * Rows are append-only: a mistake is corrected with an adjustment, not an edit.
 */
export const MOVEMENT_TYPES = [
  'opening', 'production', 'dispatch', 'transfer_in', 'transfer_out', 'return', 'adjustment',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const IN: MovementType[] = ['opening', 'production', 'transfer_in', 'return'];
const OUT: MovementType[] = ['dispatch', 'transfer_out'];

export interface Movement {
  batch_no: string;
  plant_id: string | null;
  movement_type: MovementType;
  qty: number;            // signed drums
  qty_kg?: number | null; // signed, optional
  at?: string;
}

/**
 * The signed quantity for a movement typed as a positive number. For an
 * adjustment the user picks the direction (`sign`).
 */
export function signedQty(type: MovementType, qty: number, sign: 1 | -1 = 1): number {
  const n = Math.abs(Number(qty));
  if (!Number.isFinite(n) || n === 0) throw new Error('Quantity must be a number above 0');
  if (IN.includes(type)) return n;
  if (OUT.includes(type)) return -n;
  return sign * n;
}

/** Does this row's sign match its type? (same rule as the 0041 check constraint) */
export function signOk(type: MovementType, qty: number): boolean {
  if (!qty) return false;
  if (IN.includes(type)) return qty > 0;
  if (OUT.includes(type)) return qty < 0;
  return true;
}

export interface OnHand {
  batch_no: string;
  plant_id: string | null;
  drums: number;
  kg: number | null;
  movements: number;
  lastAt: string | null;
}

const key = (batchNo: string, plantId: string | null) => `${batchNo.trim().toUpperCase()}|${plantId ?? ''}`;

/** On hand per batch and plant = sum of movements. */
export function onHandByBatch(rows: Movement[]): Map<string, OnHand> {
  const out = new Map<string, OnHand>();
  for (const r of rows) {
    const k = key(r.batch_no, r.plant_id);
    const cur = out.get(k) ?? { batch_no: r.batch_no.trim().toUpperCase(), plant_id: r.plant_id, drums: 0, kg: null, movements: 0, lastAt: null };
    cur.drums += Number(r.qty) || 0;
    if (r.qty_kg != null) cur.kg = (cur.kg ?? 0) + Number(r.qty_kg);
    cur.movements += 1;
    if (r.at && (!cur.lastAt || r.at > cur.lastAt)) cur.lastAt = r.at;
    out.set(k, cur);
  }
  return out;
}

/** On hand for one batch at one plant; null when nothing has been posted. */
export function onHandFor(map: Map<string, OnHand>, batchNo: string, plantId: string | null): OnHand | null {
  return map.get(key(batchNo, plantId)) ?? null;
}

export interface ProductionSheet {
  id: string;
  batch_no: string;
  plant_id: string;
  reactor_id?: string | null;
  density?: number | null;
  stage: string;
}

/**
 * The one production row for a finished batch sheet. Posting is idempotent:
 * the table allows a single production row per sheet (unique index), so a
 * second post is refused by the database and treated as "already posted".
 */
export function productionMovement(sheet: ProductionSheet, drums: number, actor: string, kg?: number | null) {
  return {
    batch_no: sheet.batch_no.trim().toUpperCase(),
    plant_id: sheet.plant_id,
    reactor_id: sheet.reactor_id ?? null,
    batch_sheet_id: sheet.id,
    density: sheet.density ?? null,
    movement_type: 'production' as const,
    qty: signedQty('production', drums),
    qty_kg: kg != null && kg !== 0 ? Math.abs(kg) : null,
    actor_name: actor,
    note: null as string | null,
  };
}

/** Postgres unique violation → the movement was already posted. */
export function isAlreadyPosted(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!err && (err.code === '23505' || /duplicate key|unique/i.test(err.message || ''));
}

/** Should posting this production also move the sheet to in_stock? */
export function nextStageAfterProduction(stage: string): 'in_stock' | null {
  return stage === 'created' ? 'in_stock' : null;
}
