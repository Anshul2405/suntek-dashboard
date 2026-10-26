import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { useRoleContext } from '../../contexts/RoleContext';
import { profileCanAccess } from '../../lib/profiles';
import { useDirectory } from '../../lib/mentions';
import { searchEntities, GROUP_KEY, type SearchResult, type SearchType } from '../../lib/globalSearch';
import { displayLocationName } from '../../lib/plantLabels';

/** Stable display order for the result groups. */
const TYPE_ORDER: SearchType[] = [
  'ticket', 'schedule', 'note', 'user', 'customer', 'plant',
  'storereq', 'stock', 'asset', 'part', 'activity', 'blacklist',
  'batch', 'po', 'supplier', 'sales', 'marine', 'cpm', 'upload',
];

const TYPE_ICON: Record<SearchType, string> = {
  ticket: '🔧', schedule: '🗓️', note: '💬', user: '👤', customer: '🤝', plant: '🏭',
  storereq: '📦', stock: '📋', asset: '🏷️', part: '🔩', activity: '📝',
  blacklist: '🚫', batch: '⚗️', po: '🛒', sales: '💵', marine: '🚢', cpm: '🛢️', upload: '📁', supplier: '🏢',
};

/**
 * Global Cmd+K quick-search palette. Spotlight-style: type a few characters and
 * see matching tickets, people, customers, etc. across the app; ↑/↓ to move,
 * ↵ to open, esc to close. Access-aware — only shows records the role can reach.
 */
export function CommandPalette({ open, onClose, initialQuery = '' }: { open: boolean; onClose: () => void; initialQuery?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeProfile } = useRoleContext();
  const directory = useDirectory();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const canAccess = useMemo(() => (route: string) => profileCanAccess(activeProfile, route), [activeProfile]);

  // Reset + focus whenever the palette opens (seed from initialQuery, e.g. voice).
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setResults([]);
    setActive(0);
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open, initialQuery]);

  // Debounced search. A request id guards against out-of-order responses.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      const dbResults = await searchEntities(q, canAccess);
      if (cancelled) return;

      // Merge in-memory people (mock directory) — covers role archetypes that
      // aren't provisioned DB users — deduped against DB user hits by name.
      const merged = [...dbResults];
      if (canAccess('/dashboard/users')) {
        const seen = new Set(dbResults.filter((r) => r.type === 'user').map((r) => r.title.trim().toLowerCase()));
        const ql = q.toLowerCase();
        for (const p of directory) {
          const hay = `${p.name} ${p.roleLabel} ${p.plant ?? ''} ${displayLocationName(p.plant)}`.toLowerCase();
          if (!hay.includes(ql)) continue;
          const key = p.name.trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ id: p.id, type: 'user', title: p.name, subtitle: [p.roleLabel, displayLocationName(p.plant)].filter(Boolean).join(' · '), route: '/dashboard/users' });
        }
      }
      setResults(merged);
      setActive(0);
      setLoading(false);
    }, 220);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, open, canAccess, directory]);

  // Group results in a stable order; keep a flat list for keyboard navigation.
  const groups = useMemo(() => {
    const byType = new Map<SearchType, SearchResult[]>();
    for (const r of results) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type)!.push(r);
    }
    return TYPE_ORDER.filter((tp) => byType.has(tp)).map((tp) => ({ type: tp, items: byType.get(tp)! }));
  }, [results]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  function choose(r: SearchResult | undefined) {
    if (!r) return;
    onClose();
    navigate(r.route);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]); }
  }

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const q = query.trim();
  let flatIdx = -1;

  return createPortal(
    <div
      onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 400, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 16px 16px' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ width: '100%', maxWidth: 600, background: '#fff', borderRadius: 16, boxShadow: '0 24px 70px rgba(0,0,0,0.30)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '70vh' }}
      >
        {/* Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #F1F5F9' }}>
          <Search size={18} color="#94A3B8" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 16, color: '#0F172A', fontFamily: 'inherit', background: 'transparent' }}
          />
          {loading && <span className="animate-spin" style={{ width: 14, height: 14, border: '2px solid #E2E8F0', borderTopColor: '#F47651', borderRadius: '50%', display: 'inline-block' }} />}
          <kbd style={{ fontSize: 10, color: '#94A3B8', background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 6, padding: '2px 6px' }}>esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
          {q.length < 2 ? (
            <div style={{ padding: '28px 18px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>{t('palette.hint')}</div>
          ) : !loading && flat.length === 0 ? (
            <div style={{ padding: '28px 18px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>{t('palette.noResults', { q })}</div>
          ) : (
            groups.map((g) => (
              <div key={g.type}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', padding: '10px 18px 4px' }}>
                  {t(GROUP_KEY[g.type])}
                </div>
                {g.items.map((r) => {
                  flatIdx += 1;
                  const idx = flatIdx;
                  const isActive = idx === active;
                  return (
                    <div
                      key={`${r.type}-${r.id}`}
                      data-idx={idx}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => choose(r)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', cursor: 'pointer', background: isActive ? '#F1F5F9' : 'transparent' }}
                    >
                      <span style={{ fontSize: 16, width: 22, textAlign: 'center', flexShrink: 0 }}>{TYPE_ICON[r.type]}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
                        {r.subtitle && <div style={{ fontSize: 11.5, color: '#94A3B8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.subtitle}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div style={{ display: 'flex', gap: 14, padding: '8px 18px', borderTop: '1px solid #F1F5F9', fontSize: 11, color: '#94A3B8' }}>
          <span>↑↓ {t('palette.navigate')}</span>
          <span>↵ {t('palette.openHint')}</span>
          <span>esc {t('palette.closeHint')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
