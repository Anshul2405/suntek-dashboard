import { describe, expect, it } from 'vitest';
import { canEditRaisedTicket, ticketEditMinutesLeft, TICKET_EDIT_WINDOW_MS } from './ticketEditWindow';

describe('ticket edit window', () => {
  const raised = '2026-10-22T08:00:00.000Z';
  const t0 = Date.parse(raised);

  it('allows a correction inside the first hour', () => {
    expect(canEditRaisedTicket(raised, t0 + 10 * 60_000)).toBe(true);
    expect(ticketEditMinutesLeft(raised, t0 + 10 * 60_000)).toBe(50);
  });

  it('locks the ticket after 1 hour', () => {
    expect(canEditRaisedTicket(raised, t0 + TICKET_EDIT_WINDOW_MS)).toBe(false);
    expect(canEditRaisedTicket(raised, t0 + TICKET_EDIT_WINDOW_MS + 1)).toBe(false);
    expect(ticketEditMinutesLeft(raised, t0 + TICKET_EDIT_WINDOW_MS)).toBe(0);
  });

  it('rejects a missing raise time', () => {
    expect(canEditRaisedTicket(null)).toBe(false);
    expect(canEditRaisedTicket('')).toBe(false);
  });
});
