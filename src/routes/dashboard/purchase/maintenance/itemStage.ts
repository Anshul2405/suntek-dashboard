import { useEffect, useState } from 'react';
import { supabase } from '../../../../lib/supabase';
import type { Database } from '../../../../lib/database.types';

type StoreReqRow = Database['public']['Tables']['maintenance_store_requests']['Row'];
type TicketStatus = Database['public']['Tables']['maintenance_tickets']['Row']['status'];

// ── Per-item workflow ──────────────────────────────────────────────────────────
// Each store-request row (item) moves through its own lifecycle. The ticket's
// single status is a roll-up of the least-advanced open item.
//
// In store:      store → unit_head → handover → done
// Not in store:  store → unit_head → vijay → purchase (named purchaser:
//                BUSY ref + supplier bill on the same form) → handover → done
//
// The purchaser has the bill, so there is no Purchase Manager bill step.
// Vijay ji IS management — there is no further management step. The vijay step
// needs migration 0038 (columns on maintenance_store_requests + the ticket
// statuses). Until it is applied `vijayLive` is false and a not-in-store item
// goes unit_head → purchase exactly as before, so no ticket gets stuck.

export type ItemStage = 'store' | 'unit_head' | 'vijay' | 'purchase' | 'purchase_manager' | 'handover' | 'done' | 'rejected';

/** Derive an item's current stage from its own fields. */
export function itemStageOf(r: StoreReqRow, vijayLive: boolean): ItemStage {
  const decision = (r.store_decision as string | null) ?? 'pending';
  if (r.unit_head_approval === 'rejected') return 'rejected';
  if (!decision || decision === 'pending') return 'store';
  if (r.unit_head_approval !== 'approved') return 'unit_head';
  if (decision === 'available') {
    return r.handover_confirmed_at ? 'done' : 'handover';
  }
  // Not in stock + unit head approved → external procurement.
  if (!r.busy_transaction_ref) {
    if (vijayLive) {
      if (r.vijay_approval === 'rejected') return 'rejected';
      if (r.vijay_approval !== 'approved') return 'vijay';
    }
    return 'purchase';
  }
  // Purchaser still has to attach the bill on this same step.
  if (!r.bill_verified && !r.handover_invoice_url) return 'purchase';
  return r.handover_confirmed_at ? 'done' : 'handover';
}

const STAGE_RANK: Record<ItemStage, number> = {
  store: 0, unit_head: 1, vijay: 2, purchase: 3, purchase_manager: 4, handover: 5, done: 6, rejected: 6,
};

export function stageToTicket(stage: ItemStage, vijayLive: boolean): TicketStatus | undefined {
  switch (stage) {
    case 'store': return 'pending_store';
    case 'unit_head': return 'pending_unit_head';
    case 'vijay': return 'pending_vijay';
    case 'purchase': return vijayLive ? 'pending_buyer' : 'pending_purchase';
    case 'purchase_manager': return vijayLive ? 'pending_buyer' : 'pending_purchase';
    case 'handover': return 'pending_handover';
    default: return undefined;
  }
}

/** Roll the item stages up to a single ticket status (least-advanced open item). */
export function rollupStatusOf(reqs: StoreReqRow[], current: TicketStatus, vijayLive: boolean): TicketStatus {
  if (!reqs.length) return current;
  const stage = (r: StoreReqRow) => itemStageOf(r, vijayLive);
  const open = reqs.filter(r => { const s = stage(r); return s !== 'done' && s !== 'rejected'; });
  if (!open.length) {
    // Everything resolved. If any item was actually delivered → defective return;
    // if all were rejected → back to the technician to re-assess.
    return reqs.some(r => stage(r) === 'done') ? 'pending_defective_return' : 'open';
  }
  const least = open.reduce((a, r) => STAGE_RANK[stage(r)] < STAGE_RANK[stage(a)] ? r : a, open[0]);
  return stageToTicket(stage(least), vijayLive) ?? current;
}

// ── Is migration 0038 applied? ─────────────────────────────────────────────────
// A read-only probe for the new column. Any error (missing column, offline)
// keeps the old path.

let live = false;
let probe: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export function vijayStepLive(): boolean {
  return live;
}

export function probeVijayStep(): Promise<boolean> {
  if (!probe) {
    probe = (async () => {
      try {
        const { error } = await supabase.from('maintenance_store_requests').select('vijay_approval').limit(1);
        live = !error;
      } catch {
        live = false;
      }
      listeners.forEach(fn => fn());
      return live;
    })();
  }
  return probe;
}

/** Re-renders when the probe settles. */
export function useVijayStepLive(): boolean {
  const [value, setValue] = useState(live);
  useEffect(() => {
    const fn = () => setValue(live);
    listeners.add(fn);
    void probeVijayStep().then(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return value;
}
