import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Client-side pagination for the app's many bespoke `<table className="dt">` lists.
 *
 * Every table already builds a filtered/sorted array before `.map()`, so adoption is:
 *   const { pageRows, controls } = usePagination(sortedRows, { resetKey: search });
 *   {pageRows.map(...)}
 *   <TablePagination controls={controls} />
 *
 * `resetKey` should be whatever drives the row set (search text, active filter…) so the
 * view snaps back to page 1 when the underlying list changes rather than stranding the
 * user on an empty high page.
 */

export interface PaginationControls {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  /** 1-indexed first row on the current page (0 when empty). */
  from: number;
  /** 1-indexed last row on the current page (0 when empty). */
  to: number;
  canPrev: boolean;
  canNext: boolean;
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
  prev: () => void;
  next: () => void;
  /** Windowed page numbers with '…' gaps for the numbered buttons. */
  pageNumbers: (number | 'gap')[];
}

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function windowedPages(page: number, pageCount: number): (number | 'gap')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | 'gap')[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pageCount - 1, page + 1);
  if (lo > 2) out.push('gap');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < pageCount - 1) out.push('gap');
  out.push(pageCount);
  return out;
}

export function usePagination<T>(
  rows: T[],
  opts?: {
    initialPageSize?: number;
    resetKey?: unknown;
    /** Restore a page (e.g. from the URL) — kept until the row set really changes. */
    initialPage?: number;
    /** Called when page or page size changes, so a screen can keep them in the URL. */
    onChange?: (page: number, pageSize: number) => void;
    /**
     * When false the row set is still filling (first logs, then tickets). Do not
     * clamp a restored page down to 1 just because the list is still short.
     */
    ready?: boolean;
  },
): { pageRows: T[]; controls: PaginationControls } {
  const [pageSize, setPageSizeRaw] = useState(opts?.initialPageSize ?? 10);
  const [page, setPage] = useState(Math.max(1, opts?.initialPage ?? 1));

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Snap to page 1 when the row set changes (new filter/search) or page size
  // changes — but not on mount, or a restored page would be thrown away.
  const prevReset = useRef<{ key: unknown; size: number } | null>(null);
  useEffect(() => {
    const prev = prevReset.current;
    prevReset.current = { key: opts?.resetKey, size: pageSize };
    if (prev && (prev.key !== opts?.resetKey || prev.size !== pageSize)) setPage(1);
  }, [opts?.resetKey, pageSize]);
  // Keep the page in range if the list shrinks underneath us (not while it is
  // still empty from loading, and not while a parent says the set is still
  // filling — Activity Log paints manuals first, then tickets, and clamping
  // there threw a restored page 3 back to 1).
  const ready = opts?.ready;
  useEffect(() => {
    if (ready === false) return;
    if (total > 0 && page > pageCount) setPage(pageCount);
  }, [page, pageCount, total, ready]);

  const onChange = opts?.onChange;
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => { onChangeRef.current?.(page, pageSize); }, [page, pageSize]);

  const current = Math.min(page, pageCount);
  const start = (current - 1) * pageSize;
  const pageRows = useMemo(() => rows.slice(start, start + pageSize), [rows, start, pageSize]);

  const from = total === 0 ? 0 : start + 1;
  const to = Math.min(start + pageSize, total);

  const controls: PaginationControls = {
    page: current,
    pageSize,
    pageCount,
    total,
    from,
    to,
    canPrev: current > 1,
    canNext: current < pageCount,
    setPage: (p: number) => setPage(Math.min(Math.max(1, p), pageCount)),
    setPageSize: (n: number) => setPageSizeRaw(n),
    prev: () => setPage(p => Math.max(1, p - 1)),
    next: () => setPage(p => Math.min(pageCount, p + 1)),
    pageNumbers: windowedPages(current, pageCount),
  };

  return { pageRows, controls };
}
