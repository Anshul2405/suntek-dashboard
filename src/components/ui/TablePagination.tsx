import React from 'react';
import { useTranslation } from 'react-i18next';
import { PAGE_SIZE_OPTIONS, type PaginationControls } from './usePagination';

/**
 * Footer control bar for a paginated table. Renders "Showing 1–10 of 254", a
 * page-size selector, prev/next, and numbered page buttons. Matches the purchase
 * pages' inline-style idiom (accent #F47651, slate greys).
 *
 * Hidden entirely when there is a single page AND the default page size — no chrome
 * for small lists — unless `alwaysShow` is set.
 */
export function TablePagination({
  controls,
  alwaysShow = false,
  label = 'rows',
}: {
  controls: PaginationControls;
  alwaysShow?: boolean;
  /** Noun for the page-size selector, e.g. "rows", "items". */
  label?: string;
}) {
  const { t } = useTranslation();
  const { page, pageSize, pageCount, total, from, to, canPrev, canNext, setPage, setPageSize, prev, next, pageNumbers } = controls;

  // Show the control whenever there's data so users can always change the page size
  // (10/25/50/100), even on short lists. Only hidden for a genuinely empty table.
  if (!alwaysShow && total === 0) return null;

  const btn: React.CSSProperties = {
    minWidth: 40, height: 40, padding: '0 10px', borderRadius: 8, border: '1px solid #E2E8F0',
    background: '#fff', color: '#334155', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };
  const disabled: React.CSSProperties = { opacity: 0.4, cursor: 'not-allowed' };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
        gap: 10, marginTop: 12, paddingTop: 12, borderTop: '1px solid #F1F5F9',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#64748B' }}>
        <span>
          {total === 0 ? t('common.noRows', 'No rows') : <>{t('common.showing', 'Showing')} <strong style={{ color: '#334155' }}>{from}–{to}</strong> {t('common.of', 'of')} <strong style={{ color: '#334155' }}>{total}</strong></>}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            aria-label={`${label} per page`}
            style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: '4px 6px', fontSize: 12.5, fontFamily: 'inherit', color: '#334155', background: '#fff', cursor: 'pointer' }}
          >
            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>{t('common.perPage', '/ page')}</span>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button type="button" onClick={prev} disabled={!canPrev} style={{ ...btn, ...(canPrev ? {} : disabled) }} aria-label="Previous page">‹</button>
        {pageNumbers.map((p, i) =>
          p === 'gap'
            ? <span key={`gap-${i}`} style={{ padding: '0 4px', color: '#94A3B8', fontSize: 13 }}>…</span>
            : (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                aria-current={p === page ? 'page' : undefined}
                style={{
                  ...btn,
                  ...(p === page
                    ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff', fontWeight: 700 }
                    : {}),
                }}
              >
                {p}
              </button>
            ),
        )}
        <button type="button" onClick={next} disabled={!canNext} style={{ ...btn, ...(canNext ? {} : disabled) }} aria-label="Next page">›</button>
      </div>
    </div>
  );
}
