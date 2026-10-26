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
/** Pages requested at once after the first full page. */
const PARALLEL = 3;

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<{ data: T[]; error: { message?: string } | null; truncated: boolean }> {
  const out: T[] = [];
  // Page 0 alone (most tables fit in one page); once a page comes back full, the
  // next PARALLEL pages are fetched together — ~1.5 s per 1000 tickets made a
  // strictly sequential read of 2–3k rows take 5 s+. Results stay in page order.
  for (let i = 0; i < MAX_PAGES; ) {
    const n = i === 0 ? 1 : Math.min(PARALLEL, MAX_PAGES - i);
    const batch = await Promise.all(
      Array.from({ length: n }, (_, k) => page((i + k) * PAGE, (i + k) * PAGE + PAGE - 1)),
    );
    for (const { data, error } of batch) {
      if (error) return { data: out, error, truncated: true };
      const rows = data ?? [];
      out.push(...rows);
      // A short page means the end. Equal-to-PAGE means there is probably more.
      if (rows.length < PAGE) return { data: out, error: null, truncated: false };
    }
    i += n;
  }
  // Hit the page ceiling: >50,000 rows. Return what we have and say so, rather
  // than pretending the set is complete — the whole point of this module.
  return { data: out, error: null, truncated: true };
}

/** UUIDs per `.in()` request — ~150 × 37 chars keeps the URL near 6 kB. */
const ID_CHUNK = 150;

/**
 * Run an `.in('col', ids)` read in chunks. Thousands of UUIDs in one GET make a
 * ~90 kB URL that the gateway rejects; the request fails, supabase-js retries
 * with back-off, and the caller silently gets nothing (Activity Log lost every
 * parts event and waited ~10 s for it). Chunks run in parallel.
 */
export async function fetchByIds<T>(
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<{ data: T[]; error: { message?: string } | null }> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) chunks.push(unique.slice(i, i + ID_CHUNK));
  const results = await Promise.all(chunks.map(c => query(c)));
  const error = results.find(r => r.error)?.error ?? null;
  return { data: results.flatMap(r => r.data ?? []), error };
}
