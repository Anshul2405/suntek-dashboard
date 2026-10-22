/**
 * Helpers for mapping maintenance notifications ↔ ticket lifecycle.
 * Kept framework-free so To-Do / bell completion logic can be unit-tested.
 */

/** A maintenance notification deep-links via `?ticket=<id>`. */
export function ticketIdFromRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  const q = route.indexOf('?');
  if (q === -1) return null;
  try { return new URLSearchParams(route.slice(q + 1)).get('ticket'); }
  catch { return null; }
}

/**
 * Ticket ids that should drop out of To-Do / show as done in the bell:
 * closed in DB, or absent (hard-deleted). Open tickets stay actionable.
 */
export function resolvedTicketIdsFromLookup(
  requestedIds: string[],
  rows: { id: string; status: string }[],
): Set<string> {
  const found = new Map(rows.map((r) => [r.id, r.status]));
  const resolved = new Set<string>();
  for (const id of requestedIds) {
    const status = found.get(id);
    if (status === undefined || status === 'closed') resolved.add(id);
  }
  return resolved;
}
