import { describe, it, expect } from 'vitest';
import { ticketNoLabel, ticketNoForId, matchesTicketNo, formatTicketNo, reqNoLabel } from './ticketNo';

describe('ticket numbers', () => {
  const tk = { id: '3f2a9c10-1111-2222-3333-444455556666', ticket_no: 42 };
  it('formats MT-0042', () => {
    expect(formatTicketNo(42)).toBe('MT-0042');
    expect(ticketNoLabel(tk)).toBe('MT-0042');
  });
  it('resolves by id once primed', () => {
    ticketNoLabel(tk);
    expect(ticketNoForId(tk.id)).toBe('MT-0042');
  });
  it('falls back to a stable code, never the raw uuid slice', () => {
    const label = ticketNoLabel({ id: 'abcdef12-0000-0000-0000-000000000000', ticket_no: null });
    expect(label).toBe('MT-ABCDEF');
  });
  it('search matches MT-0042, 0042, 42, mt42', () => {
    for (const q of ['MT-0042', '0042', '42', 'mt42', 'mt-42', ' mt 0042 ']) expect(matchesTicketNo(tk, q)).toBe(true);
    expect(matchesTicketNo(tk, 'MT-0042')).toBe(true);
    expect(matchesTicketNo(tk, '0043')).toBe(false);
  });
  it('shows a DB text code verbatim and searches its digits', () => {
    const tk2 = { id: 'aaaa0000-0000-0000-0000-000000000000', ticket_no: 'STK0007' };
    expect(ticketNoLabel(tk2)).toBe('STK0007');
    expect(ticketNoForId(tk2.id)).toBe('STK0007');
    for (const q of ['STK0007', 'stk0007', '0007', '7']) expect(matchesTicketNo(tk2, q)).toBe(true);
  });
  it('requisition numbers', () => {
    expect(reqNoLabel({ id: 'x', req_no: 7 })).toBe('SR-0007');
  });
});
