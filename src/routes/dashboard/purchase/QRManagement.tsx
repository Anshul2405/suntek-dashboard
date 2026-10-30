import React, { useState, useEffect, useMemo } from 'react';
import { formatDateTime } from '../../../lib/utils/formatting';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, Plus, Check, Building2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { withEmbedFallback } from '../../../lib/scopedList';
import { useUrlFilters } from '../../../lib/urlFilters';
import { useUrlTable } from '../../../lib/urlTable';
import { hereNow, withBack } from '../../../lib/backLink';
import { usePagination } from '../../../components/ui/usePagination';
import { ErrorState } from '../../../components/ui/states';
import { FilterBar, FilterSelect, ButtonV2, StatusPill, TablePaginationV2 } from '../../../components/v2';
import { normMark } from '../../../lib/far/assets';
import type { Database } from '../../../lib/database.types';
import { fetchAllRows } from '../../../lib/fetchAll';
import { displayLocationName } from '../../../lib/plantLabels';

type AssetRow = Database['public']['Tables']['fixed_assets']['Row'] & { plants?: { name: string | null } | null };
type SortKey = 'name' | 'mark' | 'plant' | 'status' | 'generated';

function fmtDT(d: string | null | undefined) {
  return d
    ? formatDateTime(d)
    : '—';
}

/**
 * QR Management — the hub for generating, printing and downloading asset QR codes.
 * QR is opt-in per asset (no code until generated); this lists every asset in
 * scope with its QR status. "View QR" / "Generate QR" open the full-page QR
 * detail (/dashboard/purchase/qr/:qrKey); generation itself remains gated by
 * `generate_asset_qr` inside that page.
 */
export function QRManagement() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { scopeQuery } = usePlantScope();
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Search, filters, sort and page live in the URL: QR Detail's Back used to
  // land on a fresh list (page 1, no search).
  const filters = useUrlFilters(['q', 'plant', 'status'] as const);
  const search = filters.values.q;
  const setSearch = (q: string) => filters.set({ q });
  const plantFilter = filters.values.plant || 'all';
  const setPlantFilter = (v: string) => filters.set({ plant: v === 'all' ? '' : v });
  const statusFilter = filters.values.status || 'all';
  const setStatusFilter = (v: string) => filters.set({ status: v === 'all' ? '' : v });
  const url = useUrlTable({ key: 'name', dir: 'asc' });
  const sort = { key: (url.sort?.key ?? 'name') as SortKey, dir: url.sort?.dir ?? 'asc' };
  const setSort = (f: (s: typeof sort) => typeof sort) => url.onSort(f(sort));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(false);
      // PAGED: >1,000 assets; an unpaged select silently stopped at 1000.
      const { data, error } = await withEmbedFallback(
        fetchAllRows<AssetRow>((from, to) =>
          scopeQuery(supabase.from('fixed_assets').select('*, plants(name)')).order('name').order('id').range(from, to).returns<AssetRow[]>()),
        () => fetchAllRows<AssetRow>((from, to) =>
          scopeQuery(supabase.from('fixed_assets').select('*')).order('name').order('id').range(from, to).returns<AssetRow[]>()),
        'QR.assets',
      );
      if (cancelled) return;
      if (error) { setError(true); setLoading(false); return; }
      setAssets(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [scopeQuery]);

  const plantNames = useMemo(
    () => [...new Set(assets.map(a => a.plants?.name).filter(Boolean) as string[])].sort(),
    [assets],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const nq = normMark(search);
    return assets.filter(a => {
      if (plantFilter !== 'all' && a.plants?.name !== plantFilter) return false;
      if (statusFilter === 'generated' && !a.qr_token) return false;
      if (statusFilter === 'not' && a.qr_token) return false;
      if (!q) return true;
      return (a.name || '').toLowerCase().includes(q)
        || (a.identification_mark || '').toLowerCase().includes(q)
        || (!!nq && normMark(a.identification_mark).includes(nq))
        || (a.make || '').toLowerCase().includes(q);
    });
  }, [assets, search, plantFilter, statusFilter]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (a: AssetRow): string => {
      switch (sort.key) {
        case 'mark':      return normMark(a.identification_mark);
        case 'plant':     return (a.plants?.name || '').toLowerCase();
        case 'status':    return a.qr_token ? '1' : '0';
        case 'generated': return a.qr_generated_at || '';
        default:          return (a.name || '').toLowerCase();
      }
    };
    return [...filtered].sort((a, b) => val(a).localeCompare(val(b)) * dir);
  }, [filtered, sort]);

  const { pageRows, controls } = usePagination(sorted, { resetKey: `${search}|${plantFilter}|${statusFilter}|${sort.key}|${sort.dir}`, ...url.paging, ready: !loading });

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  }
  const SortTh = ({ k, children }: { k: SortKey; children: React.ReactNode }) => {
    const on = sort.key === k;
    return (
      <th onClick={() => toggleSort(k)} title={t('common.sort', 'Sort')} style={{ cursor: 'pointer', userSelect: 'none' }}>
        {children}
        <span aria-hidden style={{ marginLeft: 4, fontSize: 9, opacity: on ? 0.9 : 0.35 }}>
          {on ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </th>
    );
  };

  const openDetail = (a: AssetRow) => navigate(withBack(`/dashboard/purchase/qr/${a.qr_token ?? a.id}`, hereNow()));

  return (
    <>
      {/* Filters */}
      <FilterBar
        className="mb-4"
        search={search} onSearch={setSearch} searchPlaceholder={t('far.qrSearchPlaceholder', 'Search asset name or mark…')}
        onReset={filters.reset}
      >
        <FilterSelect
          label={t('common.plant', 'Plant')} icon={<Building2 />}
          value={plantFilter} onChange={setPlantFilter}
          options={[{ value: 'all', label: t('common.allPlants', 'All Plants') }, ...plantNames.map(p => ({ value: p, label: displayLocationName(p) }))]}
        />
        <FilterSelect
          label={t('far.qrStatus', 'QR Status')}
          value={statusFilter} onChange={setStatusFilter}
          options={[
            { value: 'all', label: t('common.allStatus', 'All Status') },
            { value: 'generated', label: t('far.qrGenerated', 'Generated') },
            { value: 'not', label: t('far.qrNotGenerated', 'Not Generated') },
          ]}
        />
      </FilterBar>

      {/* Table */}
      <div className="card2 overflow-hidden">
        {error ? (
          <div className="p-5"><ErrorState title={t('far.qrErrLoadTitle', "Couldn't load assets")} message={t('far.qrErrLoadMessage', 'The fixed asset register failed to load.')} /></div>
        ) : loading ? (
          <div className="py-8 text-center text-slate-400 text-[13px]">{t('far.qrLoadingAssets', 'Loading assets…')}</div>
        ) : (
          <>
            <div className="overflow-x-auto scroll-x">
              <table className="dt2">
                <thead>
                  <tr>
                    <SortTh k="name">{t('far.qrThAssetName', 'Asset Name')}</SortTh>
                    <SortTh k="mark">{t('far.qrThAssetIdMark', 'Asset ID / Mark')}</SortTh>
                    <SortTh k="plant">{t('common.plant', 'Plant')}</SortTh>
                    <SortTh k="status">{t('far.qrStatus', 'QR Status')}</SortTh>
                    <SortTh k="generated">{t('far.qrThGeneratedOn', 'Generated On')}</SortTh>
                    <th>{t('far.qrThAction', 'Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 && (
                    <tr><td colSpan={6} className="text-center text-slate-400 py-8 text-sm">{t('far.qrNoAssetsMatch', 'No assets match your search.')}</td></tr>
                  )}
                  {pageRows.map(a => (
                    <tr key={a.id} onClick={() => openDetail(a)} style={{ cursor: 'pointer' }}>
                      <td className="font-semibold text-slate-700">{a.name}</td>
                      <td className="text-slate-500">{a.identification_mark || '—'}</td>
                      <td className="text-slate-500">{displayLocationName(a.plants?.name) || '—'}</td>
                      <td>
                        {a.qr_token
                          ? <StatusPill tone="green" icon={<Check strokeWidth={3} />} label={t('far.qrGenerated', 'Generated')} />
                          : <StatusPill tone="orange" dot label={t('far.qrNotGenerated', 'Not Generated')} />}
                      </td>
                      <td className="text-slate-500">{a.qr_token ? fmtDT(a.qr_generated_at) : '—'}</td>
                      <td>
                        {a.qr_token ? (
                          <ButtonV2 size="sm" variant="outline" icon={<Eye />} onClick={(e) => { e.stopPropagation(); openDetail(a); }}>
                            {t('far.qrViewQr', 'View QR')}
                          </ButtonV2>
                        ) : (
                          <ButtonV2 size="sm" variant="outline" icon={<Plus />} onClick={(e) => { e.stopPropagation(); openDetail(a); }}>
                            {t('far.qrGenerateQr', 'Generate QR')}
                          </ButtonV2>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePaginationV2 controls={controls} label={t('far.qrAssetsNoun', 'assets')} />
          </>
        )}
      </div>
    </>
  );
}
