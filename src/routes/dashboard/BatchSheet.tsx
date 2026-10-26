import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileSpreadsheet, FileText } from 'lucide-react';
import { useToast } from '../../components/ui/toast';
import { useRoleContext } from '../../contexts/RoleContext';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { canViewBatchFacet, canViewBatchOilRatio, canViewBatchRegister } from '../../lib/profiles';
import { canDeleteModule, canViewPhoto, useOpsSettings } from '../../lib/opsControls';
import { fetchAllRows } from '../../lib/fetchAll';
import { displayLocationName } from '../../lib/plantLabels';
import { parseTypedOilRatio } from '../../components/ProductionBatchSheetForm';
import { describeMissingRanges, formatPaddedBatchNo, isProductionSheetBatchNo, missingReactorBatches, parseReactorBatchSeq } from '../../lib/batch/reactorCatalog';
import { printTds } from '../../lib/batch/printDocs';
import type { CoaResultMap } from '../../lib/batch/printDocs';
import type { TdsFamily } from '../../lib/batch/tdsCatalog';
import { CoaEntryPanel, type CoaSheetTarget } from '../../components/batch/CoaEntryPanel';
import { TableSearch, useTextFilter } from '../../components/ui/TableSearch';

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
  const { activeProfile, activePersonId } = useRoleContext();
  const { scopeQuery, allowedPlants, isGlobal, ready: scopeReady, inScope } = usePlantScope();
  const ops = useOpsSettings();
  const canCreateSheet = canViewBatchFacet(activeProfile, 'sheet');
  const canDeleteSheet = canDeleteModule(ops, activeProfile, 'batch', activePersonId);
  const seeSheet = canViewPhoto(ops, activeProfile, 'sheet');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [prodSheets, setProdSheets] = useState<ProductionSheetRow[]>([]);
  const [coaTarget, setCoaTarget] = useState<CoaSheetTarget | null>(null);
  const [detailRow, setDetailRow] = useState<ProductionSheetRow | null>(null);
  const [plantFilter, setPlantFilter] = useState('');
  const [search, setSearch] = useState('');
  const highlightBatchNo = searchParams.get('highlight');

  const seeBucket = canViewPhoto(ops, activeProfile, 'bucket');
  const seeHeat = canViewPhoto(ops, activeProfile, 'heat');

  const plantOptions = useMemo(() => {
    // Prefer the scope plant list so Admin "All plants" / a selected plant is not
    // limited to whatever happened to land in a truncated fetch.
    if (allowedPlants.length > 0) {
      return allowedPlants.map((p) => displayLocationName(p.name)).sort((a, b) => a.localeCompare(b));
    }
    const names = new Set<string>();
    for (const row of prodSheets) {
      const n = displayLocationName(row.plants?.name).trim();
      if (n) names.add(n);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [allowedPlants, prodSheets]);

  const showPlantFilter = isGlobal ? plantOptions.length > 1 : allowedPlants.length > 1;

  useEffect(() => {
    if (!isGlobal && allowedPlants.length === 1) {
      setPlantFilter(displayLocationName(allowedPlants[0].name));
    }
  }, [isGlobal, allowedPlants]);

  const plantFilteredSheets = useMemo(() => {
    if (!plantFilter) return prodSheets;
    return prodSheets.filter((r) => displayLocationName(r.plants?.name) === plantFilter);
  }, [prodSheets, plantFilter]);

  const missingSheets = useMemo(() => {
    const byPlant = new Map<string, string[]>();
    for (const row of plantFilteredSheets) {
      const plant = displayLocationName(row.plants?.name) || '—';
      const list = byPlant.get(plant) ?? [];
      list.push(row.batch_no);
      byPlant.set(plant, list);
    }
    const rows: { plant: string; gap: ReturnType<typeof missingReactorBatches>[number] }[] = [];
    for (const [plant, nos] of byPlant) {
      for (const gap of missingReactorBatches(nos)) rows.push({ plant, gap });
    }
    return rows.sort((a, b) => a.plant.localeCompare(b.plant) || parseInt(a.gap.code.slice(1), 10) - parseInt(b.gap.code.slice(1), 10));
  }, [plantFilteredSheets]);

  const filteredSheets = useTextFilter(plantFilteredSheets, search, r => [
    r.batch_no,
    displayLocationName(r.plants?.name),
    r.reactors?.code,
    r.reactors?.name,
    r.oil_grade,
    r.colour_note,
    r.created_by_name,
    r.density != null ? String(r.density) : '',
    r.oil_ratio != null ? String(r.oil_ratio) : '',
  ]);

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
      return;
    }
    setProdSheets(
      (legacy.data ?? [])
        .filter((row) => isProductionSheetBatchNo(row.batch_no) || !!row.sheet_details?.stage)
        .filter((row) => inScope(row.plant_id))
        .map(mapLegacyActiveBatch),
    );
  }, [scopeQuery, inScope]);

  useEffect(() => {
    if (!scopeReady) return;
    loadProductionSheets();
  }, [scopeReady, loadProductionSheets]);

  useEffect(() => {
    if (!highlightBatchNo || prodSheets.length === 0) return;
    const match = prodSheets.find((r) => r.batch_no === highlightBatchNo);
    if (match) setDetailRow(match);
    const rowId = `prod-sheet-${highlightBatchNo.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const el = document.getElementById(rowId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const tmr = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.delete('highlight');
      setSearchParams(next, { replace: true });
    }, 3500);
    return () => clearTimeout(tmr);
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
      <div className="card2 p-6 mb-5" data-tour="prod-register">
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
              className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm no-underline inline-block text-center"
            >
              + {t('nav.createBatchSheet', 'Create Batch Sheet')}
            </Link>
            )}
          </div>
        </div>
        <div className="flex items-end gap-3 mb-3 flex-wrap">
          {showPlantFilter && (
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <span>{t('common.plant', 'Plant')}</span>
              <select
                value={plantFilter}
                onChange={(e) => setPlantFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 min-w-[200px] cursor-pointer"
              >
                {isGlobal && <option value="">{t('batchProd.allPlants', 'All plants')}</option>}
                {plantOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex-1 min-w-[220px]">
            <TableSearch
              value={search}
              onChange={setSearch}
              placeholder={t('batchProd.searchPh', 'Search batch no, plant, reactor, grade, or name…')}
              style={{ marginBottom: 0 }}
            />
          </div>
          {(plantFilter || search.trim()) && (
            <span className="text-[11px] text-slate-500 pb-2">
              {t('batchProd.plantFilterCount', {
                defaultValue: '{{count}} sheet(s)',
                count: filteredSheets.length,
              })}
            </span>
          )}
        </div>
        {missingSheets.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50">
            <div className="flex items-baseline justify-between gap-3 px-3 pt-3 pb-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-900">
                Batch numbers not uploaded{plantFilter ? ` · ${plantFilter}` : ''}
              </div>
              <div className="text-[11px] text-amber-800">{missingSheets.length} reactor{missingSheets.length === 1 ? '' : 's'}</div>
            </div>
            <div className="overflow-auto scroll-x" style={{ maxHeight: 280 }}>
              <table className="dt2 text-sm" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    {!plantFilter && <th style={{ position: 'sticky', top: 0, background: '#FFFBEB' }}>Plant</th>}
                    <th style={{ position: 'sticky', top: 0, background: '#FFFBEB' }}>Reactor</th>
                    <th style={{ position: 'sticky', top: 0, background: '#FFFBEB' }}>Latest</th>
                    <th className="num" style={{ position: 'sticky', top: 0, background: '#FFFBEB' }}>Missing</th>
                    <th style={{ position: 'sticky', top: 0, background: '#FFFBEB' }}>Numbers not on file</th>
                  </tr>
                </thead>
                <tbody>
                  {missingSheets.map(({ plant, gap }) => (
                    <tr key={`${plant}-${gap.code}`} onClick={() => setSearch(gap.code)} style={{ cursor: 'pointer' }} title={`Show ${gap.code} sheets`}>
                      {!plantFilter && <td>{plant}</td>}
                      <td className="font-mono font-bold">{gap.code}</td>
                      <td className="font-mono">{formatPaddedBatchNo(gap.code, gap.highest, gap.pad)}</td>
                      <td className="num font-bold">{gap.missing.length}</td>
                      <td className="font-mono text-xs">{describeMissingRanges(gap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <th>Batch no</th>
                <th>Plant</th>
                <th>Reactor</th>
                <th className="num">Density</th>
                <th>Grade</th>
                <th>Photos</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {prodSheets.length === 0 && (
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
                        className="btn-accent inline-block mt-4 rounded-[10px] px-4 py-2 font-semibold text-sm no-underline"
                      >
                        + {t('nav.createBatchSheet', 'Create Batch Sheet')}
                      </Link>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {prodSheets.length > 0 && filteredSheets.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-10 px-4 text-sm text-slate-500">
                    {search.trim()
                      ? t('batchProd.noSearchMatch', 'No batch sheets match that search.')
                      : t('batchProd.noPlantSheets', {
                          defaultValue: 'No batch sheets for {{plant}}.',
                          plant: plantFilter,
                        })}
                  </td>
                </tr>
              )}
              {filteredSheets.map(row => {
                const sheetUrls = row.sheet_photo_urls ?? [];
                const bucketUrls = row.bucket_photo_urls ?? [];
                const heatUrls = row.heat_sample_photo_urls ?? [];
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
                    <td>{displayLocationName(row.plants?.name) || '—'}</td>
                    <td>{row.reactors?.code ?? '—'}</td>
                    <td className="num">{row.density}</td>
                    <td className="text-xs font-semibold">{gradeLabel}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-0.5">
                        {seeSheet && sheetUrls[0] && <a href={sheetUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Sheet ×{sheetUrls.length}</a>}
                        {seeBucket && bucketUrls[0] && <a href={bucketUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Bucket ×{bucketUrls.length}</a>}
                        {seeHeat && heatUrls[0] && <a href={heatUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Heat ×{heatUrls.length}</a>}
                        {row.colour_note && <span className="text-[10px] text-slate-500">{row.colour_note}</span>}
                        {!photoCount && <span className="text-slate-400 text-xs">—</span>}
                      </div>
                    </td>
                    <td className="text-sm font-bold text-slate-800">
                      <div>{row.created_by_name ?? '—'}</div>
                      <div>
                        {row.created_at ? new Date(row.created_at).toLocaleString('en-IN') : ''}
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
                  {displayLocationName(detailRow.plants?.name) || '—'} · {detailRow.reactors?.code ?? '—'}
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
                <dd style={{ margin: 0, fontWeight: 800 }}>
                  {detailRow.created_by_name ?? '—'}
                  {detailRow.created_at && (
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                      {new Date(detailRow.created_at).toLocaleString('en-IN')}
                    </div>
                  )}
                </dd>
              </div>
              {(detailRow.colour_note || (detailRow.sheet_photo_urls?.length ?? 0) > 0) && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8', marginBottom: 6 }}>{t('batchProd.detailPhotos', 'Photos')}</dt>
                  <dd style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {seeSheet && detailRow.sheet_photo_urls?.[0] && (
                      <a href={detailRow.sheet_photo_urls[0]} target="_blank" rel="noreferrer" className="text-xs font-bold text-[var(--accent-deep)]">
                        {t('batchProd.photoSheet', 'Sheet')} ×{detailRow.sheet_photo_urls.length}
                      </a>
                    )}
                    {seeBucket && detailRow.bucket_photo_urls?.[0] && (
                      <a href={detailRow.bucket_photo_urls[0]} target="_blank" rel="noreferrer" className="text-xs font-bold text-[var(--accent-deep)]">
                        {t('batchProd.photoBucket', 'Bucket')} ×{detailRow.bucket_photo_urls.length}
                      </a>
                    )}
                    {seeHeat && detailRow.heat_sample_photo_urls?.[0] && (
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
