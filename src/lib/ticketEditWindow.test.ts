import { describe, it, expect } from 'vitest';
import { ticketEditMode, raiserWindowRemainingMs, diffTicketEdit, backdatedCreatedAt, auditLineForEdit } from './ticketEditWindow';

const created = '2026-10-22T04:00:00Z';
const at = (min: number) => new Date(created).getTime() + min * 60_000;
const raiser = { name: 'Madan Tech', isAdmin: false, canBackdate: false };
const other = { name: 'Someone Else', isAdmin: false, canBackdate: false };
const admin = { name: 'Owner', isAdmin: true, canBackdate: true };
const tk = { created_at: created, raised_by: 'Madan Tech', status: 'open' };

describe('raiser 1-hour edit window', () => {
  it('raiser can edit inside the hour', () => {
    expect(ticketEditMode(tk, raiser, at(59))).toBe('raiser');
  });
  it('raiser cannot edit after the hour', () => {
    expect(ticketEditMode(tk, raiser, at(61))).toBeNull();
    expect(raiserWindowRemainingMs(tk, at(61))).toBe(0);
  });
  it('someone else cannot edit even inside the hour', () => {
    expect(ticketEditMode(tk, other, at(5))).toBeNull();
  });
  it('raiser cannot edit a closed ticket', () => {
    expect(ticketEditMode({ ...tk, status: 'closed' }, raiser, at(5))).toBeNull();
  });
  it('admin can always edit, closed too', () => {
    expect(ticketEditMode({ ...tk, status: 'closed' }, admin, at(60 * 24 * 30))).toBe('admin');
  });
});

describe('edit audit', () => {
  it('lists old → new per field', () => {
    const ch = diffTicketEdit(
      { equipment: 'Pump A', description: 'leak', plant_id: 'p1', created_at: created },
      { equipment: 'Pump B', description: 'leak', plant_id: 'p2', backdate: '2026-10-20' },
      id => (id === 'p1' ? 'Madan' : 'Rehla'),
    );
    expect(ch).toEqual([
      { field: 'equipment', from: 'Pump A', to: 'Pump B' },
      { field: 'plant', from: 'Madan', to: 'Rehla' },
      { field: 'raised on', from: '2026-10-22', to: '2026-10-20' },
    ]);
    expect(auditLineForEdit('Owner', 'admin', ch)).toContain('equipment: Pump A → Pump B');
  });
  it('back date keeps the IST time of day', () => {
    expect(backdatedCreatedAt('2026-10-22T04:00:00Z', '2026-10-20')).toBe('2026-10-20T04:00:00.000Z');
  });
});
