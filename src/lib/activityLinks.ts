/**
 * Where an Activity Log row opens. Every row either opens the real entry, opens
 * its own detail panel (a hand-typed + Log activity row), or — when the entry
 * was deleted — stays and says so. Never a dead click.
 *
 * Rows written after migration 0042 carry entity_type + entity_id. Older rows
 * (and rows written by database functions) are matched by what they already
 * hold: the ticket id, the item name in "Stock: …", the purchase receipt saved
 * in the same transaction, the file name of a deleted upload.
 */

export type ActivityEntityType =
  | 'stock_item' | 'stock_receipt' | 'store_req' | 'dispatch' | 'payment'
  | 'batch_sheet' | 'far_asset' | 'repair_return' | 'maintenance_ticket' | 'incident';

export type ActivityTarget =
  | { kind: 'route'; to: string }
  | { kind: 'panel' }
  | { kind: 'deleted' }
  /** The entry exists but the row cannot point at it until migration 0042. */
  | { kind: 'needs0042' }
  | { kind: 'none' };

export interface ActivityLinkInput {
  type: string | null | undefined;
  source?: 'manual' | 'maintenance' | 'incident' | 'system' | string;
  equipment?: string | null;
  note?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ticketId?: string | null;
  incidentId?: string | null;
  /** Purchase receipt this stock_purchase row opens (invoice/vendor, not the same millisecond). */
  receiptId?: string | null;
  /** Ticket of the defective part saved in the same transaction (matched by created_at). */
  defectiveTicketId?: string | null;
}

const STORE = '/dashboard/purchase/storereq';
const enc = encodeURIComponent;

export function entityRoute(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  switch (type as ActivityEntityType) {
    case 'stock_item': return `${STORE}?tab=stock&item=${enc(id)}`;
    case 'stock_receipt': return `${STORE}?tab=stock&receipt=${enc(id)}`;
    case 'store_req': return `${STORE}?req=${enc(id)}`;
    case 'dispatch': return `/dashboard/purchase/book?tab=dispatch&dispatch=${enc(id)}`;
    case 'payment': return `/dashboard/purchase/book?tab=payments&payment=${enc(id)}`;
    case 'batch_sheet': return `/dashboard/batches?highlight=${enc(id)}`;
    case 'far_asset': return `/dashboard/purchase/far?reg=1&q=${enc(id)}`;
    case 'repair_return': return `${STORE}?tab=scrap&rhq=${enc(id.slice(0, 8))}`;
    case 'maintenance_ticket': return `/dashboard/purchase/maint?ticket=${enc(id)}`;
    case 'incident': return `/dashboard/purchase/maint?tab=incidents&incident=${enc(id)}`;
    default: return null;
  }
}

export type StockReceiptHint = {
  id: string;
  plant_id: string | null;
  created_at: string;
  invoice_no?: string | null;
  vendor_name?: string | null;
};

/** apply_stock_purchase writes the log a few ms after the receipt, so exact timestamps miss. */
const RECEIPT_WINDOW_MS = 15_000;

/**
 * The receipt for a stock_purchase Activity Log row: invoice · vendor in the
 * note (what the RPC writes), else the nearest receipt at that plant within 15s.
 */
export function matchStockReceipt(
  plantId: string | null | undefined,
  at: string | null | undefined,
  note: string | null | undefined,
  receipts: StockReceiptHint[],
): string | null {
  const plant = plantId ?? '';
  const same = receipts.filter((r) => (r.plant_id ?? '') === plant);
  const bits = (note || '').split('·').map((s) => s.trim()).filter(Boolean);
  const invoice = bits[0] && !/^₹/.test(bits[0]) ? bits[0] : '';
  const vendor = bits[1] && !/^₹/.test(bits[1]) ? bits[1] : '';
  if (invoice) {
    const byInv = same.filter((r) => (r.invoice_no || '').trim().toLowerCase() === invoice.toLowerCase());
    if (byInv.length === 1) return byInv[0].id;
    if (vendor) {
      const byBoth = byInv.filter((r) => (r.vendor_name || '').trim().toLowerCase() === vendor.toLowerCase());
      if (byBoth.length === 1) return byBoth[0].id;
    }
  }
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;
  let best: { id: string; d: number } | null = null;
  for (const r of same) {
    const d = Math.abs(Date.parse(r.created_at) - t);
    if (!Number.isFinite(d) || d > RECEIPT_WINDOW_MS) continue;
    if (!best || d < best.d) best = { id: r.id, d };
  }
  return best?.id ?? null;
}

/** "Stock: THINNER" → "THINNER"; "Defective parts: HCP-09 ( HCP-09)" → "HCP-09". */
function afterColon(text: string | null | undefined): string {
  const m = /^[^:]+:\s*(.+)$/.exec((text || '').trim());
  return (m ? m[1] : '').replace(/\s*\(.*\)\s*$/, '').trim();
}

/** Types whose entry no longer exists. */
const DELETED_TYPES = new Set(['stock_delete', 'ticket_deleted', 'batch_sheet_deleted', 'repair_return_reversed']);

export function activityTarget(row: ActivityLinkInput): ActivityTarget {
  const type = (row.type || '').toLowerCase();
  if (row.source === 'incident' && row.incidentId) return { kind: 'route', to: entityRoute('incident', row.incidentId)! };
  if (row.ticketId && !DELETED_TYPES.has(type)) return { kind: 'route', to: entityRoute('maintenance_ticket', row.ticketId)! };
  const typed = entityRoute(row.entityType, row.entityId);
  if (typed && !DELETED_TYPES.has(type)) return { kind: 'route', to: typed };
  if (DELETED_TYPES.has(type)) return { kind: 'deleted' };

  switch (type) {
    case 'stock_purchase':
      return row.receiptId
        ? { kind: 'route', to: entityRoute('stock_receipt', row.receiptId)! }
        : { kind: 'panel' };
    case 'stock_edit':
    case 'stock_check_override': {
      const name = afterColon(row.equipment);
      return name ? { kind: 'route', to: `${STORE}?tab=stock&q=${enc(name)}` } : { kind: 'panel' };
    }
    case 'defective_disposition':
    case 'repair_return': {
      // Best: the ticket the parts were decided on (Repair & scrap searches the
      // ticket's short id). Else the part name.
      if (row.defectiveTicketId) return { kind: 'route', to: `${STORE}?tab=scrap&rsq=${enc(row.defectiveTicketId.slice(0, 8))}` };
      const name = afterColon(row.equipment);
      return name ? { kind: 'route', to: `${STORE}?tab=scrap&rsq=${enc(name)}` } : { kind: 'panel' };
    }
    case 'dispatch':
    case 'payment':
      // Typed rows (0042) already returned above. Without the entity id there is
      // no safe single row to open — say so instead of a click that finds nothing.
      return { kind: 'needs0042' };
    case 'import_deleted': {
      // The upload record stays in Upload History, shown under "already deleted".
      const file = (row.equipment || '').split('·').slice(1).join('·').trim();
      return { kind: 'route', to: `/dashboard/admin/uploads?deleted=1${file ? `&q=${enc(file)}` : ''}` };
    }
    default:
      // A hand-typed + Log activity row (regular, repair, …): its own panel.
      return { kind: 'panel' };
  }
}
