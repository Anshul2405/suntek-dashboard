import { describe, it, expect } from 'vitest';
import { canReceive, groupInTransit, isStorePart, placesOrFilter, type DispatchRow } from './dispatch';

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

  it('quotes place names for the PostgREST filter', () => {
    expect(placesOrFilter(['SPPL(K) – Rehla', 'A "B"'])).toBe(
      'from_location.in.("SPPL(K) – Rehla","A \\"B\\""),destination.in.("SPPL(K) – Rehla","A \\"B\\"")',
    );
  });
});
