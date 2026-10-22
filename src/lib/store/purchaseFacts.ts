/**
 * What the purchase book knows about each register item: the date of its most
 * recent bill and the last unit price paid. Two screens need it —
 *  • Stock Register sorts / groups items by the day they last came in;
 *  • a store issue values the line (qty × last price) to decide whether a
 *    photo is mandatory (see issuePhoto.ts).
 *
 * Read-only and best-effort: the purchase tables arrive with migration 53, and
 * a register built only from uploaded workbooks has no purchase lines at all.
 */
import { supabase } from '../supabase';
import { fetchAllRows } from '../fetchAll';

export interface PurchaseFact {
  /** Bill date (receipt.purchase_date) or, failing that, when the line was recorded. */
  lastBillAt: string | null;
  /** Unit price on the newest line that carried one. */
  lastUnitPrice: number | null;
}

type LineRow = {
  store_item_id: string | null;
  created_at: string;
  unit_price: number | null;
  qty: number | null;
  amount: number | null;
  stock_purchase_receipts?: { purchase_date: string | null } | null;
};

/** Fold purchase lines into one fact per store item (pure — unit-tested). */
export function foldPurchaseLines(lines: LineRow[]): Map<string, PurchaseFact> {
  const out = new Map<string, PurchaseFact & { priceAt: string | null }>();
  for (const l of lines) {
    if (!l.store_item_id) continue;
    const billAt = l.stock_purchase_receipts?.purchase_date || l.created_at || null;
    const price = l.unit_price != null && Number(l.unit_price) > 0
      ? Number(l.unit_price)
      : (l.amount != null && l.qty ? Number(l.amount) / Number(l.qty) : null);
    const cur = out.get(l.store_item_id) ?? { lastBillAt: null, lastUnitPrice: null, priceAt: null };
    if (billAt && (!cur.lastBillAt || billAt > cur.lastBillAt)) cur.lastBillAt = billAt;
    if (price != null && Number.isFinite(price) && (!cur.priceAt || l.created_at > cur.priceAt)) {
      cur.lastUnitPrice = price;
      cur.priceAt = l.created_at;
    }
    out.set(l.store_item_id, cur);
  }
  return new Map([...out].map(([k, v]) => [k, { lastBillAt: v.lastBillAt, lastUnitPrice: v.lastUnitPrice }]));
}

/** Entry date for a register row: its newest bill, else when the row was created. */
export function stockEntryDate(createdAt: string | null | undefined, fact: PurchaseFact | undefined): string | null {
  const bill = fact?.lastBillAt ?? null;
  const created = createdAt ?? null;
  if (bill && created) return bill > created ? bill : created;
  return bill || created;
}

/** Load purchase facts, optionally limited to some store items. Never throws. */
export async function fetchPurchaseFacts(storeItemIds?: string[]): Promise<Map<string, PurchaseFact>> {
  const cols = 'store_item_id, created_at, unit_price, qty, amount';
  const run = (select: string) => fetchAllRows<LineRow>((from, to) => {
    let q = supabase.from('stock_purchase_lines').select(select).not('store_item_id', 'is', null);
    if (storeItemIds?.length) q = q.in('store_item_id', storeItemIds);
    return q.order('created_at', { ascending: true }).range(from, to).returns<LineRow[]>();
  });
  try {
    let res = await run(`${cols}, stock_purchase_receipts(purchase_date)`);
    if (res.error) res = await run(cols);
    if (res.error) return new Map();
    return foldPurchaseLines(res.data || []);
  } catch {
    return new Map();
  }
}
