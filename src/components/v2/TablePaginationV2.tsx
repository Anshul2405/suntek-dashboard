import React from 'react';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PAGE_SIZE_OPTIONS, type PaginationControls } from '../ui/usePagination';
import { cn } from '../../lib/utils/cn';

/**
 * v2 pagination bar — "Showing 1 to 8 of 62 assets" + chevrons + navy numbered
 * squares + "10 / page" select (per mockups).
 *
 * Props are IDENTICAL to ui/TablePagination so each migration is a one-line
 * import swap.
 */
export function TablePaginationV2({
  controls,
  alwaysShow = false,
  label = 'rows',
}: {
  controls: PaginationControls;
  alwaysShow?: boolean;
  /** Noun for the "Showing …" text, e.g. "rows", "assets", "tasks". */
  label?: string;
}) {
  const { t } = useTranslation();
  const { page, pageSize, total, from, to, canPrev, canNext, setPage, setPageSize, prev, next, pageNumbers } = controls;

  if (!alwaysShow && total === 0) return null;

  const sqBtn =
    'min-w-[32px] h-8 max-sm:min-w-[44px] max-sm:h-11 px-2 rounded-lg border text-[13px] inline-flex items-center justify-center transition-colors';

  return (
    <div className="flex items-center justify-between flex-wrap gap-2.5 px-4 py-3 border-t border-slate-100">
      <div className="text-[12.5px] text-slate-500">
        {total === 0
          ? t('common.noRows')
          : t('common.showingRange', { from, to, total, noun: label })}
      </div>

      {/* Wraps on a phone: with "… 82" and the page-size select the row is wider than 390px. */}
      <div className="flex items-center flex-wrap gap-1.5">
        <button
          type="button"
          onClick={prev}
          disabled={!canPrev}
          aria-label="Previous page"
          className={cn(sqBtn, 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed')}
        >
          <ChevronLeft size={14} />
        </button>

        {pageNumbers.map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="px-1 text-slate-400 text-[13px]">…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => setPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={cn(
                sqBtn,
                p === page
                  ? 'bg-slate-900 border-slate-900 text-white font-bold'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          onClick={next}
          disabled={!canNext}
          aria-label="Next page"
          className={cn(sqBtn, 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed')}
        >
          <ChevronRight size={14} />
        </button>

        <div className="relative ml-1.5">
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            aria-label={`${label} per page`}
            className="appearance-none h-8 max-sm:h-11 pl-3 pr-8 rounded-lg border border-slate-200 bg-white text-[12.5px] text-slate-600 cursor-pointer hover:bg-slate-50 focus:outline-none"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>{n} {t('common.perPage')}</option>
            ))}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        </div>
      </div>
    </div>
  );
}
