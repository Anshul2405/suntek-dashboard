import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ClipboardCheck, Receipt, Package, Wrench, Undo2, CalendarClock,
  Moon, AlertTriangle, Siren, Inbox,
} from 'lucide-react';
import { WorkCard } from '../../components/v2';
import { useTodo } from '../../contexts/TodoContext';
import { useRoleContext } from '../../contexts/RoleContext';
import type { TodoTone, TodoItem, TodoCell } from '../../lib/todo/sections';

/**
 * To-Do / Personal Work Queue — a per-profile view of everything still awaiting
 * the logged-in user. Read-only aggregation (see TodoContext); each row deep-links
 * into the module that owns the work.
 *
 * Each section renders as a compact TABLE with real columns (Ticket #, Asset,
 * Opened, Status, …) — every fact in its own column, status shown once. A global
 * search, a global sort, and a per-section sort override are provided; every
 * section paginates independently.
 */

const TONE: Record<TodoTone, { bg: string; color: string }> = {
  red:    { bg: '#FEF2F2', color: '#DC2626' },
  amber:  { bg: '#FEF3C7', color: '#B45309' },
  blue:   { bg: '#DBEAFE', color: '#2563EB' },
  green:  { bg: '#DCFCE7', color: '#16A34A' },
  purple: { bg: '#EDE9FE', color: '#7C3AED' },
  slate:  { bg: '#F1F5F9', color: '#475569' },
};

/** Line icon per section, matching the Overview "Today's Work" card style. */
const SECTION_ICONS: Record<string, React.ReactNode> = {
  'approvals':         <ClipboardCheck />,
  'purchase-bill':     <Receipt />,
  'store-checks':      <Package />,
  'my-tickets':        <Wrench />,
  'changes-requested': <Undo2 />,
  'pm-due':            <CalendarClock />,
  'night-duty':        <Moon />,
  'anomalies':         <AlertTriangle />,
  'urgent-alerts':     <Siren />,
  'my-requests':       <Inbox />,
};

type SortMode = 'priority' | 'newest' | 'oldest' | 'az' | 'za';
type SectionSort = SortMode | '';
const PAGE_SIZE = 10;

/** All cell text (+ hidden search) for one row, lowercased, for filtering. */
function haystack(it: TodoItem): string {
  const cellText = Object.values(it.cells)
    .map((c) => (c && typeof c === 'object' && 'badge' in c ? c.badge.text : c ?? ''))
    .join(' ');
  return `${it.title} ${cellText} ${it.search ?? ''}`.toLowerCase();
}

const ts = (it: TodoItem) => (it.sortDate ? new Date(it.sortDate).getTime() : 0);

function sortItems(items: TodoItem[], mode: SortMode): TodoItem[] {
  switch (mode) {
    case 'az': return [...items].sort((a, b) => a.title.localeCompare(b.title));
    case 'za': return [...items].sort((a, b) => b.title.localeCompare(a.title));
    case 'newest': return [...items].sort((a, b) => ts(b) - ts(a));
    case 'oldest': return [...items].sort((a, b) => ts(a) - ts(b));
    default: return items; // priority = as fetched
  }
}

/** Render one cell value: a coloured chip for `{ badge }`, otherwise text. */
function Cell({ value }: { value: TodoCell }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-300">—</span>;
  }
  if (typeof value === 'object' && 'badge' in value) {
    const b = value.badge;
    return (
      <span className="badge" style={{ background: TONE[b.tone].bg, color: TONE[b.tone].color, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {b.text}
      </span>
    );
  }
  return <>{value}</>;
}

export function Todo() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { sections, totalCount, ready, refresh } = useTodo();
  const { activeProfile } = useRoleContext();

  // Provider is app-level; re-pull on open + tab focus so acting elsewhere (e.g.
  // the Maintenance page) is always reflected here.
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('priority');
  const [sectionSort, setSectionSort] = useState<Record<string, SectionSort>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const sectionSortKey = JSON.stringify(sectionSort);
  useEffect(() => { setPages({}); }, [query, sort, sectionSortKey]);

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sections
      .map((s) => {
        const filtered = q ? s.items.filter((it) => haystack(it).includes(q)) : s.items;
        const mode = (sectionSort[s.key] || sort) as SortMode;
        return { ...s, items: sortItems(filtered, mode) };
      })
      .filter((s) => s.items.length > 0);
  }, [sections, query, sort, sectionSort]);

  const matchCount = useMemo(() => view.reduce((n, s) => n + s.items.length, 0), [view]);

  if (!ready) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }

  const setPage = (key: string, p: number) => setPages((prev) => ({ ...prev, [key]: p }));

  const sortOptions = (
    <>
      <option value="priority">{t('todo.optPriority')}</option>
      <option value="newest">{t('todo.optNewest')}</option>
      <option value="oldest">{t('todo.optOldest')}</option>
      <option value="az">{t('todo.optAz')}</option>
      <option value="za">{t('todo.optZa')}</option>
    </>
  );

  return (
    <div>
      {/* Intro + global controls */}
      <div className="card2 p-5 mb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-base font-bold font-heading">{t('todo.heading')}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {t('todo.subheading', { name: activeProfile.name || activeProfile.roleLabel })}
            </div>
          </div>
          <span
            className="pill-count"
            style={{
              background: totalCount > 0 ? '#FFF7ED' : '#F0FDF4',
              color: totalCount > 0 ? '#EA580C' : '#16A34A',
              fontSize: 12, padding: '4px 12px',
            }}
          >
            {totalCount > 0 ? t('todo.pending', { count: totalCount }) : t('todo.allClear')}
          </span>
        </div>

        {totalCount > 0 && (
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <div className="relative flex-1" style={{ minWidth: 220 }}>
              <svg
                width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.2"
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}
              >
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('todo.searchPlaceholder')}
                className="w-full text-[13px] rounded-[10px] border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-300"
                style={{ padding: '9px 14px 9px 34px' }}
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="Clear"
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', fontSize: 16, lineHeight: 1 }}
                >
                  ×
                </button>
              )}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              title={t('todo.sortAll')}
              className="text-[13px] rounded-[10px] border border-slate-200 bg-white focus:outline-none focus:border-slate-300"
              style={{ padding: '9px 12px' }}
            >
              {sortOptions}
            </select>
          </div>
        )}
        {query && (
          <div className="text-[11px] text-slate-400 mt-2">{t('todo.matches', { count: matchCount })}</div>
        )}
      </div>

      {/* Empty states */}
      {totalCount === 0 ? (
        <div className="ops-surface overflow-hidden">
          <div className="ops-empty">
            <strong>{t('todo.emptyTitle')}</strong>
            <span>{t('todo.emptyBody')}</span>
          </div>
        </div>
      ) : view.length === 0 ? (
        <div className="ops-surface overflow-hidden">
          <div className="ops-empty">
            <strong>{t('todo.noMatch', { q: query })}</strong>
            <span>{t('todo.noMatchHint', 'Try another name, plant, or clear the search.')}</span>
          </div>
        </div>
      ) : (
        <>
        {/* ── Section tiles — one per work bucket; click jumps to its table.
               Format mirrors the Overview "Today's Work" WorkCard. ── */}
        <div className="flex gap-3 flex-wrap mb-4">
          {view.map((s) => (
            <WorkCard
              key={s.key}
              className="flex-1 min-w-[150px]"
              icon={SECTION_ICONS[s.key] ?? s.icon}
              label={t(s.titleKey)}
              value={s.items.length}
              onClick={() => document.getElementById(`todo-sec-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          ))}
        </div>

        <div className="flex flex-col gap-4">
          {view.map((s) => {
            const total = s.items.length;
            const pageCount = Math.ceil(total / PAGE_SIZE);
            const page = Math.min(pages[s.key] ?? 0, pageCount - 1);
            const start = page * PAGE_SIZE;
            const pageItems = s.items.slice(start, start + PAGE_SIZE);
            return (
              <div key={s.key} id={`todo-sec-${s.key}`} className="card2 overflow-hidden" style={{ scrollMarginTop: 16 }}>
                {/* Section header — tone icon square, title, per-section sort, count */}
                <div className="flex items-center gap-2.5 px-5 py-3" style={{ borderBottom: '1px solid #F1F5F9' }}>
                  <span className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-100 text-slate-500 inline-flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4 shrink-0">{SECTION_ICONS[s.key] ?? s.icon}</span>
                  <div className="font-bold text-[14px] text-slate-800 font-heading">{t(s.titleKey)}</div>
                  <div className="ml-auto flex items-center gap-2">
                    <select
                      value={sectionSort[s.key] ?? ''}
                      onChange={(e) => setSectionSort((prev) => ({ ...prev, [s.key]: e.target.value as SectionSort }))}
                      title={t('todo.sortSection')}
                      className="text-[11px] rounded-lg border border-slate-200 bg-white text-slate-500 focus:outline-none focus:border-slate-400"
                      style={{ padding: '3px 6px' }}
                    >
                      <option value="">{t('todo.optDefault')}</option>
                      {sortOptions}
                    </select>
                    <span className="pill-count bg-slate-100 text-slate-600">{total}</span>
                  </div>
                </div>

                {/* Table */}
                <div style={{ overflowX: 'auto' }}>
                  <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#F8FAFC' }}>
                        {s.columns.map((c) => (
                          <th
                            key={c.key}
                            style={{
                              textAlign: c.align === 'right' ? 'right' : 'left',
                              padding: '8px 16px', whiteSpace: 'nowrap',
                              fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
                              textTransform: 'uppercase', color: '#94A3B8',
                              borderBottom: '1px solid #F1F5F9',
                            }}
                          >
                            {t(c.labelKey)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pageItems.map((it) => (
                        <tr
                          key={it.id}
                          onClick={() => navigate(it.route)}
                          className="hover:bg-slate-50"
                          style={{ cursor: 'pointer', borderBottom: '1px solid #F8FAFC' }}
                        >
                          {s.columns.map((c) => (
                            <td
                              key={c.key}
                              style={{
                                padding: '10px 16px',
                                textAlign: c.align === 'right' ? 'right' : 'left',
                                whiteSpace: c.grow ? 'normal' : 'nowrap',
                                maxWidth: c.grow ? 320 : undefined,
                                overflow: c.grow ? 'hidden' : undefined,
                                textOverflow: c.grow ? 'ellipsis' : undefined,
                                fontWeight: c.grow ? 600 : 400,
                                color: c.grow ? '#0F172A' : '#475569',
                              }}
                              title={c.grow && typeof it.cells[c.key] === 'string' ? (it.cells[c.key] as string) : undefined}
                            >
                              <Cell value={it.cells[c.key]} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination footer */}
                {pageCount > 1 && (
                  <div className="flex items-center justify-between px-5 py-2.5" style={{ borderTop: '1px solid #F1F5F9' }}>
                    <div className="text-[11px] text-slate-400">
                      {t('todo.showing', { from: start + 1, to: start + pageItems.length, total })}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setPage(s.key, page - 1)}
                        disabled={page === 0}
                        className="w-7 h-7 rounded-lg border border-slate-200 bg-white flex items-center justify-center disabled:opacity-40 hover:bg-slate-50"
                        aria-label="Previous"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m15 18-6-6 6-6" /></svg>
                      </button>
                      <span className="text-[11px] font-semibold text-slate-500" style={{ minWidth: 42, textAlign: 'center' }}>
                        {page + 1} / {pageCount}
                      </span>
                      <button
                        onClick={() => setPage(s.key, page + 1)}
                        disabled={page >= pageCount - 1}
                        className="w-7 h-7 rounded-lg border border-slate-200 bg-white flex items-center justify-center disabled:opacity-40 hover:bg-slate-50"
                        aria-label="Next"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6" /></svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
