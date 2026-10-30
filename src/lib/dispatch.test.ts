import { describe, it, expect } from 'vitest';
import { billUrlFromRemarks, canReceive, dispatchFieldOrder, dispatchSaveProblems, groupInTransit, isStorePart, placesOrFilter, withBillRemark, type DispatchFormInput, type DispatchRow } from './dispatch';

const row = (over: Partial<DispatchRow>): DispatchRow => ({
  id: Math.random().toString(36).slice(2),
  destination: 'SCPL – Rehla',
  date: '2026-10-26',
  item: 'Files',
  document_ref: null,
  vehicle_no: null,
  sender: 'A',
  receiver: null,
  from_location: 'Delhi office',
  supplier: null,
  receive_date: null,
  remarks: null,
  created_at: '2026-10-26T05:00:00Z',
  ...over,
});

describe('dispatch', () => {
  it('groups dispatch items and store parts in the same vehicle on the same day', () => {
    const groups = groupInTransit([
      row({ id: 'a', vehicle_no: 'UP13 ET 7451' }),
      row({ id: 'b', vehicle_no: 'up13et7451', supplier: 'Group Tech', item: 'Seal kit' }),
      row({ id: 'c', vehicle_no: 'UP13ET7451', date: '2026-10-25' }),
      row({ id: 'd', vehicle_no: 'UP13ET7451', receive_date: '2026-10-26' }),
      row({ id: 'e' }),
    ]);
    const same = groups.find(g => g.rows.some(r => r.id === 'a'))!;
    expect(same.rows.map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(groups.some(g => g.rows.some(r => r.id === 'd'))).toBe(false);
    expect(groups.find(g => g.rows.some(r => r.id === 'e'))!.rows).toHaveLength(1);
    expect(groups).toHaveLength(3);
  });

  it('a row naming a supplier is a store part', () => {
    expect(isStorePart(row({ supplier: 'Group Tech' }))).toBe(true);
    expect(isStorePart(row({ supplier: '  ' }))).toBe(false);
  });

  it('only the receiving place (or admin) can receive, and only while in transit', () => {
    const mine = new Set(['SCPL – Rehla']);
    expect(canReceive(row({}), mine, false)).toBe(true);
    expect(canReceive(row({ destination: 'Madan Chemical – Sikandrabad' }), mine, false)).toBe(false);
    expect(canReceive(row({ destination: 'Madan Chemical – Sikandrabad' }), mine, true)).toBe(true);
    expect(canReceive(row({ receive_date: '2026-10-27' }), mine, true)).toBe(false);
  });

  it('keeps the purchaser bill URL in remarks', () => {
    const remarks = withBillRemark('Store req #12', 'https://res.cloudinary.com/x/bill.jpg');
    expect(billUrlFromRemarks(remarks)).toBe('https://res.cloudinary.com/x/bill.jpg');
    expect(billUrlFromRemarks(null)).toBe(null);
  });

  it('quotes place names for the PostgREST filter', () => {
    expect(placesOrFilter(['SPPL(K) – Rehla', 'A "B"'])).toBe(
      'from_location.in.("SPPL(K) – Rehla","A \\"B\\""),destination.in.("SPPL(K) – Rehla","A \\"B\\"")',
    );
  });

  const form = (over: Partial<DispatchFormInput> = {}): DispatchFormInput => ({
    kind: 'item', company: '', payee: '', manual: false, exceptionReason: '', ifsc: '',
    destination: 'SCPL – Rehla', date: '2026-10-30', item: 'Files', sender: 'Ravi', from: 'Madan Chemical – Sikandrabad',
    vehicle_no: '', supplier: '', ...over,
  });

  it('without 0042: no company / payee in the form, and today\'s form saves', () => {
    expect(dispatchFieldOrder(false)).not.toContain('company');
    expect(dispatchFieldOrder(false)).not.toContain('payee');
    expect(dispatchSaveProblems(form(), { payeeLive: false, hasBill: false })).toEqual([]);
  });

  it('with 0042: company → from → destination → payee, all required', () => {
    const order = dispatchFieldOrder(true);
    expect(order.slice(0, 4)).toEqual(['company', 'from', 'destination', 'payee']);
    expect(dispatchSaveProblems(form(), { payeeLive: true, hasBill: false })).toEqual(['company', 'payee']);
    expect(dispatchSaveProblems(form({ company: '0010', payee: 'NKG Plastochem Pvt Ltd (Howrah)' }), { payeeLive: true, hasBill: false })).toEqual([]);
  });

  it('IFSC: 5th character must be 0 (UTIB0000123 ok, UTIB1000123 blocks)', () => {
    const base = { company: '0007', payee: 'X' };
    expect(dispatchSaveProblems(form({ ...base, ifsc: 'UTIB0000123' }), { payeeLive: true, hasBill: false })).toEqual([]);
    expect(dispatchSaveProblems(form({ ...base, ifsc: 'UTIB1000123' }), { payeeLive: true, hasBill: false })).toEqual(['ifsc']);
    expect(dispatchSaveProblems(form({ ...base, ifsc: 'UTIBP000123' }), { payeeLive: true, hasBill: false })).toEqual(['ifsc']);
  });

  it('payee not in Busy needs a reason; a bad vehicle blocks; tomorrow is fine', () => {
    expect(dispatchSaveProblems(form({ company: '0007', payee: 'Y', manual: true }), { payeeLive: true, hasBill: false })).toEqual(['exceptionReason']);
    expect(dispatchSaveProblems(form({ vehicle_no: 'TRUCK 5' }), { payeeLive: false, hasBill: false })).toEqual(['vehicle']);
    expect(dispatchSaveProblems(form({ vehicle_no: 'DL 1C AB 1234', date: '2099-01-01' }), { payeeLive: false, hasBill: false })).toEqual([]);
  });
});
