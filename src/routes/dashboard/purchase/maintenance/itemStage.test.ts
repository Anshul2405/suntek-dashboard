import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../lib/supabase', () => ({ supabase: {} }));

import { itemStageOf, rollupStatusOf } from './itemStage';
import type { Database } from '../../../../lib/database.types';

type StoreReqRow = Database['public']['Tables']['maintenance_store_requests']['Row'];

const req = (over: Partial<StoreReqRow>): StoreReqRow => ({
  id: 'r', ticket_id: 't', part_name: 'Seal', quantity: 1, unit: null, specification: null, plant_id: null,
  source_store_id: null, reserved_qty: 0, store_decision: null, purchase_required: null, qty_in_store: null,
  shelf_location: null, part_condition: null, unit_head_approval: null, busy_transaction_ref: null,
  unit_price: null, total_price: null, supplier_name: null, handover_invoice_url: null, handover_photo_url: null,
  handover_notes: null, handover_confirmed_at: null, bill_verified: null, store_item_id: null, split_group: null,
  purchased_qty: null, store_decided_by: null, store_decided_at: null, unit_head_approved_by: null,
  unit_head_approved_at: null, procured_by: null, procured_at: null, handover_confirmed_by: null,
  vijay_approval: null, vijay_approved_by: null, vijay_approved_at: null, buyer_name: null,
  created_at: '2026-10-27T00:00:00Z',
  ...over,
});

const notInStore = { store_decision: 'unavailable' as const, unit_head_approval: 'approved' as const };

describe('ticket part stages', () => {
  it('in store: unit head → handover, never Vijay', () => {
    expect(itemStageOf(req({ store_decision: 'available' }), true)).toBe('unit_head');
    expect(itemStageOf(req({ store_decision: 'available', unit_head_approval: 'approved' }), true)).toBe('handover');
  });

  it('not in store: unit head → Vijay → purchaser (BUSY ref + bill) → handover', () => {
    expect(itemStageOf(req({ store_decision: 'unavailable' }), true)).toBe('unit_head');
    expect(itemStageOf(req(notInStore), true)).toBe('vijay');
    expect(itemStageOf(req({ ...notInStore, vijay_approval: 'approved', buyer_name: 'Sagar sir' }), true)).toBe('purchase');
    expect(itemStageOf(req({ ...notInStore, vijay_approval: 'approved', busy_transaction_ref: 'P/1' }), true)).toBe('purchase');
    expect(itemStageOf(req({ ...notInStore, vijay_approval: 'approved', busy_transaction_ref: 'P/1', handover_invoice_url: 'https://bill' }), true)).toBe('handover');
    expect(itemStageOf(req({ ...notInStore, vijay_approval: 'approved', busy_transaction_ref: 'P/1', bill_verified: true }), true)).toBe('handover');
    expect(itemStageOf(req({ ...notInStore, vijay_approval: 'rejected' }), true)).toBe('rejected');
  });

  it('ticket status after unit head is Vijay, then the purchaser — no extra management step', () => {
    expect(rollupStatusOf([req(notInStore)], 'pending_unit_head', true)).toBe('pending_vijay');
    expect(rollupStatusOf([req({ ...notInStore, vijay_approval: 'approved' })], 'pending_vijay', true)).toBe('pending_buyer');
  });

  it('a part already bought before the migration is not sent back to Vijay', () => {
    expect(itemStageOf(req({ ...notInStore, busy_transaction_ref: 'P/1' }), true)).toBe('purchase');
  });

  it('without migration 0038 the old path still moves (unit head → purchase)', () => {
    expect(itemStageOf(req(notInStore), false)).toBe('purchase');
    expect(rollupStatusOf([req(notInStore)], 'pending_unit_head', false)).toBe('pending_purchase');
  });
});
