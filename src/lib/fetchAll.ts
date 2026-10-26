/**
 * Page through a Supabase query that can exceed the server's row cap.
 *
 * PostgREST returns at most `db-max-rows` per request — 1000 on Supabase by
 * default — and it does so SILENTLY. There is no error and no flag; you simply
 * get 1000 rows and a truncated view of reality.
 *
 * That has already bitten this app twice:
 *   • Maintenance holds ~1,300 tickets, so the OVERDUE card could never read
 *     above 1000 and the oldest ~300 tickets were invisible. A To-Do deep link
 *     to one of them silently failed, because the id was not in the loaded page.
 *   • store_stock_months holds ~1,791 rows, so the anomaly reconciler was
 *     comparing months it had only partially loaded.
 *
 * Anything that can plausibly grow past a thousand rows — tickets, schedules,
 * monthly stock snapshots, assets — must page. Use a plain query only where the
 * row count is bounded by something real (one factory's users, one file's
 * batches).
 *
 *   const rows = await fetchAllRows<TicketRow>(
 *     (from, to) => supabase.from('maintenance_tickets').select('*').range(from, to),
 *   );
 *
 * The callback is invoked once per page with an inclusive range, exactly as
 * PostgREST expects. Ordering is the caller's job: an unordered paged read can
 * repeat or skip rows between pages, so ALWAYS order by something stable.
 */
const PAGE = 1000;
/** Refuse to loop forever if a query returns a full page indefinitely. */
const MAX_PAGES = 50;

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<{ data: T[]; error: { message?: string } | null; truncated: boolean }> {
  return fetchAllRowsProgressive(page);
}

/**
 * Same paging as fetchAllRows, but `onPage` runs after every page with the
 * rows gathered so far. Screens use it to draw the first thousand rows
 * instead of waiting for the rest of the table.
 */
export async function fetchAllRowsProgressive<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
  onPage?: (rowsSoFar: T[]) => void,
): Promise<{ data: T[]; error: { message?: string } | null; truncated: boolean }> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const from = i * PAGE;
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: out, error, truncated: true };
    const rows = data ?? [];
    out.push(...rows);
    onPage?.(out.slice());
    // A short page means the end. Equal-to-PAGE means there is probably more.
    if (rows.length < PAGE) return { data: out, error: null, truncated: false };
  }
  // Hit the page ceiling: >50,000 rows. Return what we have and say so, rather
  // than pretending the set is complete — the whole point of this module.
  return { data: out, error: null, truncated: true };
}
