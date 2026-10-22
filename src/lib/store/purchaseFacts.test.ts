import { describe, it, expect } from 'vitest';
import { foldPurchaseLines, stockEntryDate } from './purchaseFacts';

describe('purchase facts', () => {
  it('keeps the newest bill date and newest unit price per item', () => {
    const m = foldPurchaseLines([
      { store_item_id: 'a', created_at: '2026-09-01T10:00:00Z', unit_price: 100, qty: 2, amount: 200, stock_purchase_receipts: { purchase_date: '2026-08-30' } },
      { store_item_id: 'a', created_at: '2026-10-05T10:00:00Z', unit_price: null, qty: 4, amount: 600, stock_purchase_receipts: { purchase_date: '2026-10-04' } },
      { store_item_id: 'b', created_at: '2026-10-01T10:00:00Z', unit_price: null, qty: null, amount: null },
    ]);
    expect(m.get('a')).toEqual({ lastBillAt: '2026-10-04', lastUnitPrice: 150 });
    expect(m.get('b')).toEqual({ lastBillAt: '2026-10-01T10:00:00Z', lastUnitPrice: null });
  });
  it('entry date = newer of bill and created_at', () => {
    expect(stockEntryDate('2026-10-01T00:00:00Z', { lastBillAt: '2026-10-04', lastUnitPrice: null })).toBe('2026-10-04');
    expect(stockEntryDate('2026-10-05T00:00:00Z', { lastBillAt: '2026-10-04', lastUnitPrice: null })).toBe('2026-10-05T00:00:00Z');
    expect(stockEntryDate('2026-10-05T00:00:00Z', undefined)).toBe('2026-10-05T00:00:00Z');
    expect(stockEntryDate(null, undefined)).toBeNull();
  });
});
