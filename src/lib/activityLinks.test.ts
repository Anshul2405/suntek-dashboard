import { describe, it, expect } from 'vitest';
import { activityTarget, entityRoute, matchStockReceipt } from './activityLinks';

describe('Activity Log row → real entry', () => {
  it('tickets and incidents open as before', () => {
    expect(activityTarget({ type: 'raised', source: 'maintenance', ticketId: 't1' })).toEqual({ kind: 'route', to: '/dashboard/purchase/maint?ticket=t1' });
    expect(activityTarget({ type: 'incident', source: 'incident', incidentId: 'i1' })).toEqual({ kind: 'route', to: '/dashboard/purchase/maint?tab=incidents&incident=i1' });
  });

  it('a purchase opens the receipt it was saved with; without a match, its own panel', () => {
    expect(activityTarget({ type: 'stock_purchase', equipment: 'Purchase: 1 item(s)', receiptId: 'r1' }))
      .toEqual({ kind: 'route', to: '/dashboard/purchase/storereq?tab=stock&receipt=r1' });
    expect(activityTarget({ type: 'stock_purchase', equipment: 'Purchase: 1 item(s)' })).toEqual({ kind: 'panel' });
  });

  it('a purchase log row matches its receipt by invoice even when the clocks differ by a few ms', () => {
    const receipts = [
      { id: 'r-4113', plant_id: 'p1', created_at: '2026-10-29T10:00:00.120Z', invoice_no: '4113', vendor_name: 'Sanju Pal' },
      { id: 'r-other', plant_id: 'p1', created_at: '2026-10-29T10:00:00.000Z', invoice_no: '9999', vendor_name: 'Other' },
    ];
    expect(matchStockReceipt('p1', '2026-10-29T10:00:00.000Z', '4113 · Sanju Pal · ₹12000', receipts)).toBe('r-4113');
    expect(matchStockReceipt('p1', '2026-10-29T10:00:00.000Z', 'no-such · X · ₹1', receipts)).toBe('r-other');
    expect(matchStockReceipt('p2', '2026-10-29T10:00:00.000Z', '4113 · Sanju Pal · ₹12000', receipts)).toBeNull();
  });

  it('stock edits open the item in the Stock register; defective parts open Repair & scrap', () => {
    expect(activityTarget({ type: 'stock_edit', equipment: 'Stock: THINNER' }))
      .toEqual({ kind: 'route', to: '/dashboard/purchase/storereq?tab=stock&q=THINNER' });
    expect(activityTarget({ type: 'defective_disposition', equipment: 'Defective parts: HCP-09 ( HCP-09)' }))
      .toEqual({ kind: 'route', to: '/dashboard/purchase/storereq?tab=scrap&rsq=HCP-09' });
  });

  it('deleted entries stay and say deleted; a deleted upload opens its record', () => {
    expect(activityTarget({ type: 'stock_delete', equipment: 'Stock: saudas' })).toEqual({ kind: 'deleted' });
    expect(activityTarget({ type: 'batch_sheet_deleted', entityType: 'batch_sheet', entityId: 'P26-12' })).toEqual({ kind: 'deleted' });
    expect(activityTarget({ type: 'import_deleted', equipment: 'Upload deleted · Madan 26-27.xlsx' }))
      .toEqual({ kind: 'route', to: '/dashboard/admin/uploads?deleted=1&q=Madan%2026-27.xlsx' });
  });

  it('typed rows (migration 0042) open dispatch, payments, store req, batch, FAR', () => {
    expect(activityTarget({ type: 'dispatch', entityType: 'dispatch', entityId: 'd1' }))
      .toEqual({ kind: 'route', to: '/dashboard/purchase/book?tab=dispatch&dispatch=d1' });
    expect(entityRoute('payment', 'p1')).toBe('/dashboard/purchase/book?tab=payments&payment=p1');
    expect(entityRoute('store_req', 'q1')).toBe('/dashboard/purchase/storereq?req=q1');
    expect(entityRoute('batch_sheet', 'P26-12')).toBe('/dashboard/batches?highlight=P26-12');
    expect(entityRoute('far_asset', 'HCL AB10')).toBe('/dashboard/purchase/far?reg=1&q=HCL%20AB10');
    expect(entityRoute('nonsense', 'x')).toBe(null);
  });

  it('a hand-typed + Log activity row opens its own panel', () => {
    expect(activityTarget({ type: 'regular', source: 'manual', equipment: 'Paraffin tank no 2' })).toEqual({ kind: 'panel' });
  });

  it('defective parts open their ticket in Repair & scrap when it is known', () => {
    expect(activityTarget({ type: 'defective_disposition', equipment: 'Defective parts: HCP-09 ( HCP-09)', defectiveTicketId: 'abcdef12-3456' }))
      .toEqual({ kind: 'route', to: '/dashboard/purchase/storereq?tab=scrap&rsq=abcdef12' });
  });

  it('dispatch / payment rows without an entity id stay and say they need 0042', () => {
    expect(activityTarget({ type: 'dispatch', equipment: 'Dispatch: files' })).toEqual({ kind: 'needs0042' });
    expect(activityTarget({ type: 'payment', equipment: 'Payment: X' })).toEqual({ kind: 'needs0042' });
  });
});
