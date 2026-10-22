import { describe, it, expect } from 'vitest';
import { resolvedTicketIdsFromLookup, ticketIdFromRoute } from './ticketResolution';

describe('resolvedTicketIdsFromLookup', () => {
  it('marks closed tickets resolved', () => {
    const r = resolvedTicketIdsFromLookup(
      ['a', 'b'],
      [{ id: 'a', status: 'closed' }, { id: 'b', status: 'open' }],
    );
    expect([...r]).toEqual(['a']);
  });

  it('marks missing (deleted) tickets resolved so To-Do drops them', () => {
    // Admin deleted the ticket — lookup returns no row for that id.
    const r = resolvedTicketIdsFromLookup(
      ['alive', 'deleted-dummy'],
      [{ id: 'alive', status: 'pending_unit_head' }],
    );
    expect(r.has('deleted-dummy')).toBe(true);
    expect(r.has('alive')).toBe(false);
  });

  it('keeps open tickets actionable', () => {
    const r = resolvedTicketIdsFromLookup(
      ['t1'],
      [{ id: 't1', status: 'repair_in_progress' }],
    );
    expect(r.size).toBe(0);
  });
});

describe('ticketIdFromRoute', () => {
  it('reads ?ticket=', () => {
    expect(ticketIdFromRoute('/dashboard/purchase/maint?ticket=abc-123')).toBe('abc-123');
  });

  it('returns null without a ticket query', () => {
    expect(ticketIdFromRoute('/dashboard/purchase/maint')).toBeNull();
  });
});
