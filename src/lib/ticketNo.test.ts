// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ticketNoLabel, ticketSearchTerms, reqNoLabel } from './ticketNo';

describe('ticketNoLabel', () => {
  it('shows STK0001 from the database as is', () => {
    expect(ticketNoLabel({ id: 'abc', ticket_no: 'STK0001' })).toBe('STK0001');
  });
  it('falls back to a short id when there is no number yet', () => {
    expect(ticketNoLabel({ id: 'f855d730-1111-2222-3333-444444444444' }).startsWith('f855d730')).toBe(true);
  });
  it('matches a search by digits of STK0001', () => {
    const terms = ticketSearchTerms({ id: 'x', ticket_no: 'STK0001' });
    expect(terms.some(t => t.includes('0001') || t.includes('1'))).toBe(true);
  });
  it('shows a requisition id until req_no exists', () => {
    expect(reqNoLabel({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).toBe('aaaaaaaa');
  });
});
