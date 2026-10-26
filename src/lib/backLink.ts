/**
 * "Open X from Y, close X, land on Y."
 *
 * A screen that opens a ticket / requisition / incident on another screen adds
 * `back=<its own URL, filters included>`; the target navigates there when the
 * item is closed. Only in-app dashboard paths are accepted, so a crafted link
 * cannot bounce the user to another site.
 */

/** The current screen as a `back` value (path + query, so filters survive). */
export function hereForBack(loc: { pathname: string; search: string }): string {
  return loc.pathname + loc.search;
}

/** `route` with `back=<here>` appended. */
export function withBack(route: string, here: string): string {
  return `${route}${route.includes('?') ? '&' : '?'}back=${encodeURIComponent(here)}`;
}

/** A `back` query value if it is a safe in-app dashboard path, else ''. */
export function safeBack(raw: string | null | undefined): string {
  const b = raw || '';
  if (b.startsWith('//')) return '';
  return b === '/dashboard' || b.startsWith('/dashboard/') || b.startsWith('/dashboard?') ? b : '';
}
