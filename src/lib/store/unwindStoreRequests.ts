import { supabase } from '../supabase';

/**
 * One maintenance_store_requests row as needed to reverse stock effects when the
 * request (or its ticket) is removed / replaced.
 */
export type UnwindStoreRequest = {
  id: string;
  plant_id: string | null;
  store_item_id: string | null;
  quantity: number | null;
  purchased_qty: number | null;
  reserved_qty: number | null;
  store_decision: 'available' | 'unavailable' | null;
  handover_confirmed_at: string | null;
  part_name: string | null;
  busy_transaction_ref: string | null;
};

export type UnwindResult = {
  released: number;
  unissued: number;
  procuredReversed: number;
  errors: string[];
};

type IssueRpcResult = {
  ok?: boolean;
  applied?: number;
  short?: number;
};

/**
 * Reverse every stock side-effect of the given store-request rows, BEFORE they
 * are deleted:
 *
 *   • Handed over from own store  → unissue (on_hand ↑, issued_qty ↓)
 *   • Approved / reserved only    → release (reserved_qty ↓)
 *   • Handed over from procurement → reverse ticket_procured_qty + any bulk
 *     excess that was added to on_hand
 *
 * Safe to call with an empty list. Best-effort per row: one failure is recorded
 * and the rest continue so a single bad link cannot strand the whole ticket.
 */
export async function unwindStoreRequests(
  reqs: UnwindStoreRequest[],
  opts: { actorName: string; ticketRef?: string },
): Promise<UnwindResult> {
  const result: UnwindResult = { released: 0, unissued: 0, procuredReversed: 0, errors: [] };
  if (!reqs.length) return result;

  for (const req of reqs) {
    if (!req.store_item_id) continue;
    const plantId = req.plant_id;
    if (!plantId) {
      result.errors.push(`${req.part_name || req.id}: missing plant_id`);
      continue;
    }
    const qty = Number(req.quantity) || 0;
    const reserved = Number(req.reserved_qty) || 0;
    const handedOver = !!req.handover_confirmed_at;
    const fromOwnStore = req.store_decision === 'available';
    const ref = opts.ticketRef || `ticket ${req.id.slice(0, 8)}`;

    try {
      if (handedOver && fromOwnStore && qty > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.rpc as any)('issue_store_item', {
          payload: {
            action: 'unissue',
            store_item_id: req.store_item_id,
            store_request_id: req.id,
            qty,
            requesting_plant_id: plantId,
            ref,
            justification: `Ticket undo · restored ${req.part_name || 'part'}`,
            actor_name: opts.actorName,
          },
        });
        if (error) throw error;
        result.unissued += Number((data as IssueRpcResult | null)?.applied ?? qty);
      } else if (handedOver && !fromOwnStore && qty > 0) {
        // Procurement track: undo ticket_procured_qty and any bulk excess on_hand.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: si, error: selErr } = await (supabase.from('store_items') as any)
          .select('id, on_hand, procured_qty, ticket_procured_qty')
          .eq('id', req.store_item_id)
          .single();
        if (selErr) throw selErr;
        if (si) {
          const bought = Number(req.purchased_qty) || qty;
          const excess = Math.max(0, bought - qty);
          const newTicketProcured = Math.max(0, Number(si.ticket_procured_qty || 0) - qty);
          const newProcured = Math.max(0, Number(si.procured_qty || 0) - excess);
          const newOnHand = Math.max(0, Number(si.on_hand || 0) - excess);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: updErr } = await (supabase.from('store_items') as any).update({
            ticket_procured_qty: newTicketProcured,
            procured_qty: newProcured,
            on_hand: newOnHand,
            updated_at: new Date().toISOString(),
          }).eq('id', req.store_item_id);
          if (updErr) throw updErr;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase.from('store_stock_events') as any).insert({
            item_id: req.store_item_id,
            plant_id: plantId,
            event_type: 'unissue',
            store_id: null,
            requesting_plant_id: plantId,
            qty_delta: -excess,
            on_hand_after: newOnHand,
            ref: req.busy_transaction_ref || ref,
            justification: `Ticket undo · reversed procurement for ${req.part_name || 'part'}`,
            actor_name: opts.actorName,
          });
          result.procuredReversed += qty + excess;
        }
      } else if (!handedOver && reserved > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.rpc as any)('issue_store_item', {
          payload: {
            action: 'release',
            store_item_id: req.store_item_id,
            store_request_id: req.id,
            qty: reserved,
            requesting_plant_id: plantId,
            ref,
            actor_name: opts.actorName,
          },
        });
        if (error) throw error;
        result.released += Number((data as IssueRpcResult | null)?.applied ?? reserved);
      } else if (!handedOver && qty > 0 && fromOwnStore && req.store_decision === 'available') {
        // Approved path may have reserved under reserved_qty=0 if RPC failed earlier;
        // still attempt release for the requested qty (RPC clamps to this request's claim).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.rpc as any)('issue_store_item', {
          payload: {
            action: 'release',
            store_item_id: req.store_item_id,
            store_request_id: req.id,
            qty,
            requesting_plant_id: plantId,
            ref,
            actor_name: opts.actorName,
          },
        });
        if (error) throw error;
        result.released += Number((data as IssueRpcResult | null)?.applied ?? 0);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${req.part_name || req.id}: ${msg}`);
      // eslint-disable-next-line no-console
      console.error('[unwindStoreRequests]', req.id, e);
    }
  }

  return result;
}

/** Load store-request rows for one or more tickets, then unwind stock. */
export async function unwindStoreRequestsForTickets(
  ticketIds: string[],
  opts: { actorName: string },
): Promise<UnwindResult> {
  if (!ticketIds.length) return { released: 0, unissued: 0, procuredReversed: 0, errors: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from('maintenance_store_requests') as any)
    .select('id, plant_id, store_item_id, quantity, purchased_qty, reserved_qty, store_decision, handover_confirmed_at, part_name, busy_transaction_ref')
    .in('ticket_id', ticketIds);
  if (error) {
    return { released: 0, unissued: 0, procuredReversed: 0, errors: [error.message] };
  }
  const ref = ticketIds.length === 1 ? `ticket ${ticketIds[0].slice(0, 8)}` : `tickets ×${ticketIds.length}`;
  return unwindStoreRequests((data as UnwindStoreRequest[] | null) ?? [], { actorName: opts.actorName, ticketRef: ref });
}
