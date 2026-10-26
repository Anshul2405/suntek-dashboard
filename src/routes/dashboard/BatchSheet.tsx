import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileSpreadsheet, FileText, Plus } from 'lucide-react';
import { useToast } from '../../components/ui/toast';
import { SkeletonRows } from '../../components/ui/states';
import { formatDateTime, inIstDayRange } from '../../lib/utils/formatting';
import { useUrlFilters } from '../../lib/urlFilters';
import { plantsForPicker } from '../../lib/access/pickerPlants';
import { DateRangeFilter, FilterBar, FilterSelect, TablePaginationV2 } from '../../components/v2';
import { Building2, FlaskConical, Layers } from 'lucide-react';
import { useRoleContext } from '../../contexts/RoleContext';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { canViewBatchFacet, canViewBatchOilRatio, canViewBatchRegister, isAdminProfile } from '../../lib/profiles';
import { canViewPhoto, useOpsSettings } from '../../lib/opsControls';
import { fetchAllRows } from '../../lib/fetchAll';
import { parseTypedOilRatio } from '../../components/ProductionBatchSheetForm';
import { isProductionSheetBatchNo, parseReactorBatchSeq } from '../../lib/batch/reactorCatalog';
import { printTds } from '../../lib/batch/printDocs';
import type { CoaResultMap } from '../../lib/batch/printDocs';
import type { TdsFamily } from '../../lib/batch/tdsCatalog';
import { CoaEntryPanel, type CoaSheetTarget } from '../../components/batch/CoaEntryPanel';
import { useTextFilter } from '../../components/ui/TableSearch';
import { usePagination } from '../../components/ui/usePagination';
import { patchUrlParams } from '../../lib/urlParams';
import { displayLocationName } from '../../lib/plantLabels';

interface ProductionSheetRow {
  id: string;
  batch_no: string;
  reactor_seq: number;
  density: number;
  oil_grade?: string | null;
  oil_ratio?: number | string | null;
  coa_results?: CoaResultMap | null;
  stage: 'created' | 'in_stock' | 'dispatched';
  sheet_photo_urls: string[] | null;
  bucket_photo_urls: string[] | null;
  heat_sample_photo_urls: string[] | null;
  colour_note: string | null;
  created_by_name: string | null;
  created_at: string;
  plant_id?: string | null;
  plants?: { name?: string | null } | null;
  reactors?: { code?: string | null; name?: string | null } | null;
  /** native = production_batch_sheets; legacy = active_batches fallback until migration 0009 */
  source?: 'native' | 'legacy';
  /** For legacy stage updates — full sheet_details blob */
  legacyDetails?: Record<string, unknown> | null;
}

type LegacySheetDetails = {
  stage?: string;
  density?: number;
  colourNote?: string | null;
  reactorCode?: string | null;
  reactor_seq?: number;
  oil_grade?: string | null;
  oil_ratio?: number | string | null;
  coa_results?: CoaResultMap | null;
  created_by_name?: string | null;
  sheet_photo_urls?: string[];
  bucket_photo_urls?: string[];
  heat_sample_photo_urls?: string[];
};

function mapLegacyActiveBatch(row: {
  id: string;
  batch_no: string;
  started_at: string;
  final_gravity?: number | null;
  operator_name?: string | null;
  sheet_details?: LegacySheetDetails | null;
  plant_id?: string | null;
  plants?: { name?: string | null } | null;
}): ProductionSheetRow {
  const d = row.sheet_details ?? {};
  const stage = (d.stage === 'in_stock' || d.stage === 'dispatched' ? d.stage : 'created') as ProductionSheetRow['stage'];
  const reactorCode = d.reactorCode ?? null;
  const seqFromNo = parseReactorBatchSeq(row.batch_no, reactorCode ?? undefined);
  return {
    id: row.id,
    batch_no: row.batch_no,
    reactor_seq: typeof d.reactor_seq === 'number' ? d.reactor_seq : (seqFromNo ?? 0),
    density: Number(d.density ?? row.final_gravity ?? 0),
    oil_grade: d.oil_grade ?? null,
    oil_ratio: d.oil_ratio == null || d.oil_ratio === '' ? null : d.oil_ratio,
    coa_results: d.coa_results ?? null,
    stage,
    sheet_photo_urls: d.sheet_photo_urls ?? null,
    bucket_photo_urls: d.bucket_photo_urls ?? null,
    heat_sample_photo_urls: d.heat_sample_photo_urls ?? null,
    colour_note: d.colourNote ?? null,
    created_by_name: d.created_by_name ?? row.operator_name ?? null,
    created_at: row.started_at,
    plant_id: row.plant_id ?? null,
    plants: row.plants,
    reactors: reactorCode ? { code: reactorCode, name: reactorCode } : null,
    source: 'legacy',
    legacyDetails: (row.sheet_details as Record<string, unknown>) ?? {},
  };
}

export function BatchSheet() {
  const { t } = useTranslation();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeProfile } = useRoleContext();
  const ops = useOpsSettings();
  const seeSheetPhoto = canViewPhoto(ops, activeProfile, 'sheet');
  const seeBucketPhoto = canViewPhoto(ops, activeProfile, 'bucket');
  const seeHeatPhoto = canViewPhoto(ops, activeProfile, 'heat');
  const { scopeQuery, allowedPlants, ready: scopeReady, inScope } = usePlantScope();
  const role = activeProfile.id;
  const canCreateSheet = canViewBatchFacet(activeProfile, 'sheet');
  const isFactoryAccountant = role === 'accountant_delhi' || role === 'accountant_other'
    || isAdminProfile(activeProfile);
  // Cleanup of dummy / wrong sheets — admin, accountants, unit heads, Technical.
  const canDeleteSheet = isFactoryAccountant
    || role === 'unit_head'
    || role === 'factory_operator'
    || activeProfile.baseRoleId === 'unit_head'
    || activeProfile.baseRoleId === 'factory_operator';
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [prodSheets, setProdSheets] = useState<ProductionSheetRow[]>([]);
  // False until the first load returns — the empty state must not flash meanwhile.
  const [sheetsLoaded, setSheetsLoaded] = useState(false);
  const [coaTarget, setCoaTarget] = useState<CoaSheetTarget | null>(null);
  const [detailRow, setDetailRow] = useState<ProductionSheetRow | null>(null);
  const highlightBatchNo = searchParams.get('highlight');
  // Filters live in the URL so a refresh / back= restores them; Reset clears all.
  const filters = useUrlFilters(['q', 'plant', 'reactor', 'grade', 'from', 'to'] as const);
  const { q: search, plant: plantFilter, reactor: reactorFilter, grade: gradeFilter, from: fromDate, to: toDate } = filters.values;

  // Only factories this user can access — never the full list as a fallback.
  const plantOptions = useMemo(
    () => [...plantsForPicker(allowedPlants, scopeReady)].sort((a, b) => a.name.localeCompare(b.name)),
    [allowedPlants, scopeReady],
  );
  const reactorOf = (r: ProductionSheetRow) => (r.reactors?.code || r.reactors?.name || '').trim();
  const reactorOptions = useMemo(
    () => [...new Set(prodSheets.map(reactorOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [prodSheets],
  );
  const gradeOptions = useMemo(
    () => [...new Set(prodSheets.map(r => (r.oil_grade || '').trim()).filter(Boolean))].sort(),
    [prodSheets],
  );

  const facetFilteredSheets = useMemo(() => prodSheets.filter((r) =>
    (!plantFilter || r.plant_id === plantFilter)
    && (!reactorFilter || reactorOf(r) === reactorFilter)
    && (!gradeFilter || (r.oil_grade || '').trim() === gradeFilter)
    && inIstDayRange(r.created_at, fromDate, toDate),
  ), [prodSheets, plantFilter, reactorFilter, gradeFilter, fromDate, toDate]);
  const filteredSheets = useTextFilter(facetFilteredSheets, search, r => [
    r.batch_no,
    r.plants?.name,
    r.reactors?.code,
    r.reactors?.name,
    r.oil_grade,
    r.colour_note,
    r.created_by_name,
    r.density != null ? String(r.density) : '',
    r.oil_ratio != null ? String(r.oil_ratio) : '',
  ]);

  // Paged — ~800 sheets painted at once made the page ~81,000px tall on a phone.
  // Page / size live in the URL (?p=&ps=) like the Activity Log, so back= and a
  // refresh land on the same page; a filter change snaps back to page 1.
  const { pageRows: pageSheets, controls: sheetPager } = usePagination(filteredSheets, {
    resetKey: `${search}|${plantFilter}|${reactorFilter}|${gradeFilter}|${fromDate}|${toDate}`,
    initialPage: Number(searchParams.get('p')) || 1,
    initialPageSize: Number(searchParams.get('ps')) || 10,
    onChange: (page, size) => patchUrlParams(setSearchParams, {
      p: page > 1 ? String(page) : '',
      ps: size !== 10 ? String(size) : '',
    }),
  });

  const loadProductionSheets = useCallback(async () => {
    // Page through every in-scope sheet. A hard .limit(100) under a global Admin
    // scope returned only the newest 100 across ALL plants — so filtering to one
    // factory (e.g. SPPL(K)) looked empty/short vs a Unit Head whose query is
    // already plant-scoped and therefore fills that same budget with their sheets.
    const native = await fetchAllRows<ProductionSheetRow>((from, to) =>
      scopeQuery(
        supabase
          .from('production_batch_sheets')
          .select('id, batch_no, reactor_seq, density, oil_grade, oil_ratio, coa_results, stage, sheet_photo_urls, bucket_photo_urls, heat_sample_photo_urls, colour_note, created_by_name, created_at, plant_id, plants(name), reactors(code, name)')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      ).returns<ProductionSheetRow[]>());

    if (!native.error && native.data) {
      setProdSheets(
        native.data
          .filter((r) => inScope(r.plant_id))
          .map((r) => ({ ...r, source: 'native' as const })),
      );
      setSheetsLoaded(true);
      return;
    }

    // Live DB may not have production_batch_sheets yet (migration 0009). Sheets are
    // stored on active_batches as PBS-* (old) or P12-13 (reactor-seq format).
    console.warn('[BatchSheet] production sheets unavailable — loading legacy active_batches', native.error?.message);
    type LegacyRow = {
      id: string;
      batch_no: string;
      started_at: string;
      final_gravity?: number | null;
      operator_name?: string | null;
      sheet_details?: LegacySheetDetails | null;
      plant_id?: string | null;
      plants?: { name?: string | null } | null;
    };
    const legacy = await fetchAllRows<LegacyRow>((from, to) =>
      scopeQuery(
        supabase
          .from('active_batches')
          .select('id, batch_no, started_at, final_gravity, operator_name, sheet_details, plant_id, plants(name)')
          .or('batch_no.like.PBS-%,batch_no.like.P%-%')
          .order('started_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      ).returns<LegacyRow[]>());
    if (legacy.error) {
      console.warn('[BatchSheet] legacy sheets:', legacy.error.message);
      setProdSheets([]);
      setSheetsLoaded(true);
      return;
    }
    setProdSheets(
      (legacy.data ?? [])
        .filter((row) => isProductionSheetBatchNo(row.batch_no) || !!row.sheet_details?.stage)
        .filter((row) => inScope(row.plant_id))
        .map(mapLegacyActiveBatch),
    );
    setSheetsLoaded(true);
  }, [scopeQuery, inScope]);

  useEffect(() => {
    if (!scopeReady) return;
    loadProductionSheets();
  }, [scopeReady, loadProductionSheets]);

  useEffect(() => {
    if (!highlightBatchNo || prodSheets.length === 0) return;
    const rowId = `prod-sheet-${highlightBatchNo.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    // Paged list: open the page that holds the new sheet before scrolling to it.
    const idx = filteredSheets.findIndex(r => r.batch_no === highlightBatchNo);
    if (idx >= 0) sheetPager.setPage(Math.floor(idx / sheetPager.pageSize) + 1);
    const scrollTmr = window.setTimeout(() => {
      document.getElementById(rowId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    const tmr = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.delete('highlight');
      setSearchParams(next, { replace: true });
    }, 3500);
    return () => { clearTimeout(tmr); clearTimeout(scrollTmr); };
    // Only re-run when the highlight target or sheet list identity changes — not on every searchParams mutate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightBatchNo, prodSheets.length]);

  useEffect(() => {
    if (!scopeReady) return;
    const prodSub = supabase.channel('production_batch_sheets_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'production_batch_sheets' }, () => {
        loadProductionSheets();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(prodSub);
    };
  }, [scopeReady, loadProductionSheets]);

  async function deleteSheet(row: ProductionSheetRow) {
    if (!canDeleteSheet) {
      toast.error(t('batchProd.deleteForbidden', 'You do not have permission to delete batch sheets.'));
      return;
    }
    if (!window.confirm(t('batchProd.confirmDelete', {
      defaultValue: 'Delete batch sheet {{batchNo}}? This cannot be undone.',
      batchNo: row.batch_no,
    }))) return;

    setDeletingId(row.id);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const table = row.source === 'legacy' ? 'active_batches' : 'production_batch_sheets';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from(table) as any).delete().eq('id', row.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      setProdSheets((prev) => prev.filter((r) => r.id !== row.id));
      toast.success(t('batchProd.deleted', 'Batch sheet deleted'));
    } finally {
      setDeletingId(null);
    }
  }

  function openTds(row: ProductionSheetRow) {
    const family = (row.oil_grade === 'HNP' ? 'HNP' : 'NP') as TdsFamily;
    printTds({
      family,
      oilRatio: parseTypedOilRatio(String(row.oil_ratio ?? '')) ?? row.density,
      oilRatioLabel: row.oil_ratio != null ? String(row.oil_ratio) : null,
      batchNo: row.batch_no,
      plantName: row.plants?.name ?? null,
    });
  }

  function openCoa(row: ProductionSheetRow) {
    setCoaTarget({
      id: row.id,
      batch_no: row.batch_no,
      oil_ratio: row.oil_ratio ?? null,
      oil_grade: row.oil_grade ?? null,
      density: row.density,
      plantName: row.plants?.name ?? null,
      source: row.source,
      legacyDetails: row.legacyDetails,
      coa_results: row.coa_results ?? null,
    });
  }

  if (!canViewBatchRegister(activeProfile)) {
    return <Navigate to="/dashboard/batch-entry?tab=reading" replace />;
  }

  return (
    <>
      <div className="card2 p-6 mb-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div className="text-base font-bold font-heading">{t('batchProd.registerTitle', 'Batch sheet record')}</div>
            <div className="text-xs text-slate-500">
              {t('batchProd.registerSub', 'Completed production sheets — generate TDS / COA and keep photo evidence.')}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {canCreateSheet && (
            <Link
              data-tour="create-sheet-btn"
              to="/dashboard/batch-entry?tab=create-sheet"
              className="btn-accent rounded-lg px-4 py-2 font-semibold text-[13px] no-underline inline-flex items-center gap-1.5"
            >
              <Plus size={14} aria-hidden /> {t('nav.createBatchSheet', 'Create Batch Sheet')}
            </Link>
            )}
          </div>
        </div>
        <FilterBar
          className="mb-3 !p-0 !border-0 !shadow-none !bg-transparent"
          search={search}
          onSearch={(q) => filters.set({ q })}
          searchPlaceholder={t('batchProd.searchPh', 'Search batch no, plant, reactor, grade, or name…')}
          onReset={filters.reset}
        >
          {plantOptions.length > 1 && (
            <FilterSelect icon={<Building2 />} value={plantFilter || 'all'} onChange={(v) => filters.set({ plant: v === 'all' ? '' : v })}
              options={[{ value: 'all', label: t('common.allPlants') }, ...plantOptions.map(p => ({ value: p.id, label: displayLocationName(p.name) }))]} />
          )}
          <FilterSelect icon={<FlaskConical />} value={reactorFilter || 'all'} onChange={(v) => filters.set({ reactor: v === 'all' ? '' : v })}
            options={[{ value: 'all', label: t('common.allReactors', 'All reactors') }, ...reactorOptions.map(r => ({ value: r, label: r }))]} />
          <FilterSelect icon={<Layers />} value={gradeFilter || 'all'} onChange={(v) => filters.set({ grade: v === 'all' ? '' : v })}
            options={[{ value: 'all', label: t('common.allGrades', 'All grades') }, ...gradeOptions.map(g => ({ value: g, label: g }))]} />
          <DateRangeFilter from={fromDate} to={toDate} onChange={({ from, to }) => filters.set({ from, to })} />
        </FilterBar>
        {filters.active && sheetsLoaded && (
          <div className="text-[11px] text-slate-500 mb-2">
            {t('batchProd.plantFilterCount', { defaultValue: '{{count}} sheet(s)', count: filteredSheets.length })}
          </div>
        )}
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <th>{t('batchProd.thBatchNo', 'Batch no')}</th>
                <th>{t('batchProd.thPlant', 'Plant')}</th>
                <th>{t('batchProd.thReactor', 'Reactor')}</th>
                <th className="num">{t('batchProd.thDensity', 'Density')}</th>
                <th>{t('batchProd.thGrade', 'Grade')}</th>
                <th>{t('batchProd.detailPhotos', 'Photos')}</th>
                <th>{t('batchProd.thCreated', 'Created')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!sheetsLoaded && (
                <tr><td colSpan={8}><SkeletonRows rows={4} /></td></tr>
              )}
              {sheetsLoaded && prodSheets.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-12 px-4">
                    <div className="mx-auto max-w-sm">
                      <div className="text-sm font-heading font-semibold text-slate-700">
                        {t('batchProd.emptyTitle', 'No production batch sheets yet')}
                      </div>
                      <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
                        {t('batchProd.empty', 'Create one with + Create Batch Sheet, or upload a sheet photo for OCR review.')}
                      </p>
                      {canCreateSheet && (
                      <Link
                        to="/dashboard/batch-entry?tab=create-sheet"
                        className="btn-accent inline-flex items-center gap-1.5 mt-4 rounded-lg px-4 py-2 font-semibold text-[13px] no-underline"
                      >
                        <Plus size={14} aria-hidden /> {t('nav.createBatchSheet', 'Create Batch Sheet')}
                      </Link>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {sheetsLoaded && prodSheets.length > 0 && filteredSheets.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-10 px-4 text-sm text-slate-500">
                    {t('common.noRowsMatchFilters', 'No rows match these filters')}
                  </td>
                </tr>
              )}
              {pageSheets.map(row => {
                const sheetUrls = seeSheetPhoto ? (row.sheet_photo_urls ?? []) : [];
                const bucketUrls = seeBucketPhoto ? (row.bucket_photo_urls ?? []) : [];
                const heatUrls = seeHeatPhoto ? (row.heat_sample_photo_urls ?? []) : [];
                const photoCount = sheetUrls.length + bucketUrls.length + heatUrls.length;
                const isHighlight = !!highlightBatchNo && row.batch_no === highlightBatchNo;
                const rowDomId = `prod-sheet-${row.batch_no.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                const gradeLabel = row.oil_grade?.trim() || '—';
                return (
                  <tr
                    key={row.id}
                    id={rowDomId}
                    className={`${isHighlight ? 'bg-amber-50 ring-2 ring-inset ring-amber-400' : ''} cursor-pointer hover:bg-slate-50`}
                    onClick={() => setDetailRow(row)}
                  >
                    <td className="font-bold font-mono">{row.batch_no}</td>
                    <td>{row.plants?.name ?? '—'}</td>
                    <td>{row.reactors?.code ?? '—'}</td>
                    <td className="num">{row.density}</td>
                    <td className="text-xs font-semibold">{gradeLabel}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-0.5">
                        {sheetUrls[0] && <a href={sheetUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Sheet ×{sheetUrls.length}</a>}
                        {bucketUrls[0] && <a href={bucketUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Bucket ×{bucketUrls.length}</a>}
                        {heatUrls[0] && <a href={heatUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Heat ×{heatUrls.length}</a>}
                        {row.colour_note && <span className="text-[10px] text-slate-500">{row.colour_note}</span>}
                        {!photoCount && <span className="text-slate-400 text-xs">—</span>}
                      </div>
                    </td>
                    <td className="text-slate-500 text-xs">
                      <div>{row.created_by_name ?? '—'}</div>
                      <div className="text-[10px] text-slate-400">
                        {row.created_at ? formatDateTime(row.created_at) : ''}
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2 justify-end flex-wrap">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openTds(row); }}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-700 hover:text-amber-700"
                          title={t('batchProd.tdsHint', 'Generate Technical Data Sheet')}
                        >
                          <FileSpreadsheet size={12} /> TDS
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openCoa(row); }}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-700 hover:text-amber-700"
                          title={t('batchProd.coaHintBtn', 'Enter / print Certificate of Analysis')}
                        >
                          <FileText size={12} /> COA
                        </button>
                        {canDeleteSheet && (
                          <button
                            type="button"
                            disabled={deletingId === row.id}
                            onClick={(e) => { e.stopPropagation(); deleteSheet(row); }}
                            className="text-[11px] font-bold text-red-600 hover:underline disabled:opacity-50"
                          >
                            {deletingId === row.id
                              ? t('batchProd.deleting', 'Deleting…')
                              : t('batchProd.delete', 'Delete')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Paging footer only once loaded — never a "0 of 0" while the first page loads. */}
        {sheetsLoaded && filteredSheets.length > 0 && (
          <TablePaginationV2 controls={sheetPager} label={t('batchProd.nounSheets', 'sheets')} />
        )}
      </div>

      {detailRow && (
        <div
          onClick={() => setDetailRow(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 270, display: 'flex', justifyContent: 'flex-end' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 420, background: '#fff', height: '100%', overflow: 'auto', boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' }}
          >
            <div style={{ padding: '16px 18px', borderBottom: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>{detailRow.batch_no}</div>
                <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
                  {detailRow.plants?.name ?? '—'} · {detailRow.reactors?.code ?? '—'}
                </div>
              </div>
              <button type="button" onClick={() => setDetailRow(null)} style={{ border: 'none', background: '#F1F5F9', width: 32, height: 32, borderRadius: 999, cursor: 'pointer' }}>✕</button>
            </div>
            <dl style={{ padding: 16, margin: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', fontSize: 13 }}>
              <div>
                <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8', marginBottom: 4 }}>{t('batchProd.detailDensity', 'Density')}</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{detailRow.density}</dd>
              </div>
              <div>
                <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8', marginBottom: 4 }}>{t('batchProd.detailGrade', 'Grade')}</dt>
                <dd style={{ margin: 0, fontWeight: 700 }}>{detailRow.oil_grade?.trim() || '—'}</dd>
              </div>
              {canViewBatchOilRatio(activeProfile, detailRow.created_by_name) && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8', marginBottom: 4 }}>{t('batchProd.oilRatio', 'Oil ratio')}</dt>
                  <dd style={{ margin: 0, fontWeight: 700 }}>{detailRow.oil_ratio ?? '—'}</dd>
                </div>
              )}
              <div style={{ gridColumn: '1 / -1' }}>
                <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8', marginBottom: 4 }}>{t('batchProd.detailCreated', 'Created')}</dt>
                <dd style={{ margin: 0 }}>
                  {detailRow.created_by_name ?? '—'}
                  {detailRow.created_at && (
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                      {formatDateTime(detailRow.created_at)}
                    </div>
                  )}
                </dd>
              </div>
              {(detailRow.colour_note || (seeSheetPhoto && (detailRow.sheet_photo_urls?.length ?? 0) > 0) || (seeBucketPhoto && (detailRow.bucket_photo_urls?.length ?? 0) > 0) || (seeHeatPhoto && (detailRow.heat_sample_photo_urls?.length ?? 0) > 0)) && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8', marginBottom: 6 }}>{t('batchProd.detailPhotos', 'Photos')}</dt>
                  <dd style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {seeSheetPhoto && detailRow.sheet_photo_urls?.[0] && (
                      <a href={detailRow.sheet_photo_urls[0]} target="_blank" rel="noreferrer" className="text-xs font-bold text-[var(--accent-deep)]">
                        {t('batchProd.photoSheet', 'Sheet')} ×{detailRow.sheet_photo_urls.length}
                      </a>
                    )}
                    {seeBucketPhoto && detailRow.bucket_photo_urls?.[0] && (
                      <a href={detailRow.bucket_photo_urls[0]} target="_blank" rel="noreferrer" className="text-xs font-bold text-[var(--accent-deep)]">
                        {t('batchProd.photoBucket', 'Bucket')} ×{detailRow.bucket_photo_urls.length}
                      </a>
                    )}
                    {seeHeatPhoto && detailRow.heat_sample_photo_urls?.[0] && (
                      <a href={detailRow.heat_sample_photo_urls[0]} target="_blank" rel="noreferrer" className="text-xs font-bold text-[var(--accent-deep)]">
                        {t('batchProd.photoHeat', 'Heat sample')} ×{detailRow.heat_sample_photo_urls.length}
                      </a>
                    )}
                    {detailRow.colour_note && <span style={{ fontSize: 11, color: '#64748B' }}>{detailRow.colour_note}</span>}
                  </dd>
                </div>
              )}
            </dl>
            <div style={{ padding: '12px 16px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #E2E8F0' }}>
              <button type="button" onClick={() => { openTds(detailRow); }} className="inline-flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg border border-slate-200">
                <FileSpreadsheet size={12} /> TDS
              </button>
              <button type="button" onClick={() => { openCoa(detailRow); setDetailRow(null); }} className="inline-flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg border border-slate-200">
                <FileText size={12} /> COA
              </button>
            </div>
          </div>
        </div>
      )}

      {coaTarget && (
        <CoaEntryPanel
          sheet={coaTarget}
          onClose={() => setCoaTarget(null)}
          onSaved={(results) => {
            setProdSheets((prev) => prev.map((r) =>
              r.id === coaTarget.id
                ? {
                    ...r,
                    coa_results: results,
                    legacyDetails: r.source === 'legacy'
                      ? { ...(r.legacyDetails ?? {}), coa_results: results }
                      : r.legacyDetails,
                  }
                : r,
            ));
          }}
        />
      )}
    </>
  );
}
