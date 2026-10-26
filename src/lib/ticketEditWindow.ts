/** Raised tickets can be corrected only within this window. */
export const TICKET_EDIT_WINDOW_MS = 60 * 60 * 1000;

export function ticketEditDeadline(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return t + TICKET_EDIT_WINDOW_MS;
}

export function canEditRaisedTicket(createdAt: string | null | undefined, now = Date.now()): boolean {
  const until = ticketEditDeadline(createdAt);
  return until != null && now < until;
}

export function ticketEditMinutesLeft(createdAt: string | null | undefined, now = Date.now()): number {
  const until = ticketEditDeadline(createdAt);
  if (until == null) return 0;
  return Math.max(0, Math.ceil((until - now) / 60_000));
}
