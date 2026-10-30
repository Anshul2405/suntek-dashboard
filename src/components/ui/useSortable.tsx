import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * useSortable — click-to-sort for any table already built as `<table className="dt">`.
 *
 * Integration is minimal: give it the rows + a map of column-key → accessor, map
 * over `sorted` instead of the raw rows, and swap each `<th>Label</th>` for
 * `<Th sortKey="..." s={sortable}>Label</Th>`. Accessors return the raw value to
 * compare — a number, a Date, an ISO string, or plain text. Numbers/dates sort
 * numerically; everything else sorts case-insensitively. Empty/null values always
 * sort last, regardless of direction.
 *
 * First click on a text column sorts A→Z; first click on a numeric/date column
 * sorts high→low (so "latest first" is one click). Clicking the active column
 * flips the direction.
 */

export type SortDir = 'asc' | 'desc';
export type SortVal = string | number | Date | null | undefined;

export interface Sortable {
  sort: { key: string | null; dir: SortDir };
  onSort: (key: string, firstDir?: SortDir) => void;
}

function asNum(v: SortVal): number | null {
  if (v instanceof Date) { const n = v.getTime(); return isFinite(n) ? n : null; }
  if (typeof v === 'number') return isFinite(v) ? v : null;
  return null;
}

function isBlank(v: SortVal): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

function compare(a: SortVal, b: SortVal): number {
  const aB = isBlank(a), bB = isBlank(b);
  if (aB && bB) return 0;
  if (aB) return 1;   // blanks always last
  if (bB) return -1;
  const an = asNum(a), bn = asNum(b);
  if (an != null && bn != null) return an - bn;
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase(), undefined, { numeric: true });
}

export function useSortable<T>(
  rows: T[],
  accessors: Record<string, (row: T) => SortVal>,
  initial?: { key: string; dir: SortDir },
  /** Called after the user changes the sort (not on mount) — e.g. to keep it in the URL. */
  onChange?: (sort: { key: string | null; dir: SortDir }) => void,
): { sorted: T[]; sort: { key: string | null; dir: SortDir }; onSort: Sortable['onSort'] } {
  const [sort, setSort] = useState<{ key: string | null; dir: SortDir }>(initial ?? { key: null, dir: 'asc' });
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const firstSort = useRef(true);
  useEffect(() => {
    if (firstSort.current) { firstSort.current = false; return; }
    onChangeRef.current?.(sort);
  }, [sort]);
  // Accessors are recreated each render; keep them in a ref so the memo depends
  // only on the rows + sort state, not object identity.
  const accRef = useRef(accessors);
  accRef.current = accessors;

  const onSort = useCallback((key: string, firstDir: SortDir = 'asc') => {
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir }));
  }, []);

  const sorted = useMemo(() => {
    const acc = sort.key ? accRef.current[sort.key] : null;
    if (!acc) return rows;
    const f = sort.dir === 'asc' ? 1 : -1;
    // Blanks stay last regardless of direction, so factor is applied to the
    // value comparison only (blank handling inside compare returns ±1 unscaled).
    return [...rows].sort((a, b) => {
      const av = acc(a), bv = acc(b);
      if (isBlank(av) || isBlank(bv)) return compare(av, bv);
      return f * compare(av, bv);
    });
  }, [rows, sort]);

  return { sorted, sort, onSort };
}

/** Sortable header cell — drop-in replacement for `<th>`. */
export function Th({ children, sortKey, s, firstDir = 'asc', className, style }: {
  children: React.ReactNode;
  sortKey: string;
  s: Sortable;
  /** direction applied on the FIRST click (default 'asc'; pass 'desc' for dates/amounts). */
  firstDir?: SortDir;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const active = s.sort.key === sortKey;
  return (
    <th
      className={className}
      onClick={() => s.onSort(sortKey, firstDir)}
      title={t('common.sort', 'Sort')}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
    >
      {children}
      <span aria-hidden style={{ marginLeft: 4, fontSize: 9, opacity: active ? 0.9 : 0.3 }}>
        {active ? (s.sort.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}
