import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import { useSortable } from '../../components/ui/useSortable';
import { ThV2 as Th } from '../../components/v2';
import { updateRows } from '../../lib/db';
import { useToast } from '../../components/ui/toast';
import { useRoleContext } from '../../contexts/RoleContext';
import { isProductionSheetBatchNo, parseReactorBatchSeq } from '../../lib/batch/reactorCatalog';
import { markTourSeen, tourWasSeen } from '../../components/tour/GuidedTour';
import { launchBatchFlowTour, BATCH_FLOW_TOUR_ID } from '../../components/tour/BatchFlowTourHost';

const QC_BADGE: Record<string, { bg: string; color: string }> = {
  pending:  { bg: '#FEF3C7', color: '#D97706' },
  awaiting: { bg: '#F1F5F9', color: '#475569' },
};

const STAGE_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  created:    { bg: '#FEF3C7', color: '#B45309', label: 'Created' },
  in_stock:   { bg: '#DBEAFE', color: '#1D4ED8', label: 'In stock' },
  dispatched: { bg: '#DCFCE7', color: '#15803D', label: 'Dispatched' },
};

/** Shape consumed by formatBatch — an active_batches row with its joined relations. */
interface BatchSource {
  id: string;
  batch_no?: string;
  recipe?: string | null;
  target_qty?: number | null;
  plants?: { name?: string | null } | null;
  profiles?: { name?: string | null } | null;
  batch_readings?: { id: string }[] | null;
}

interface ProductionSheetRow {
  id: string;
  batch_no: string;
  reactor_seq: number;
  density: number;
  stage: 'created' | 'in_stock' | 'dispatched';
  sheet_photo_urls: string[] | null;
  bucket_photo_urls: string[] | null;
  heat_sample_photo_urls: string[] | null;
  colour_note: string | null;
  created_by_name: string | null;
  created_at: string;
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
    stage,
    sheet_photo_urls: d.sheet_photo_urls ?? null,
    bucket_photo_urls: d.bucket_photo_urls ?? null,
    heat_sample_photo_urls: d.heat_sample_photo_urls ?? null,
    colour_note: d.colourNote ?? null,
    created_by_name: d.created_by_name ?? row.operator_name ?? null,
    created_at: row.started_at,
    plants: row.plants,
    reactors: reactorCode ? { code: reactorCode, name: reactorCode } : null,
    source: 'legacy',
    legacyDetails: (row.sheet_details as Record<string, unknown>) ?? {},
  };
}

function formatBatch(b: BatchSource) {
  const readingsCount = b.batch_readings ? b.batch_readings.length : 0;
  const computedCurrent = readingsCount * 10;
  const computedDrums = readingsCount;

  return {
    id: b.id,
    num: b.batch_no,
    plant: b.plants?.name || 'Live Plant',
    recipe: b.recipe || 'N/A',
    target: b.target_qty || 1000,
    current: computedCurrent,
    drums: computedDrums,
    elapsed: 'Live',
    op: b.profiles?.name || 'Operator',
    qc: 'pending',
    editCount: readingsCount
  };
}

type BatchDisplay = ReturnType<typeof formatBatch>;

export function BatchSheet() {
  const { t } = useTranslation();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeProfile } = useRoleContext();
  const role = activeProfile.id;
  const isFactoryAccountant = role === 'accountant_delhi' || role === 'accountant_other' || role === 'admin'
    || activeProfile.baseRoleId === 'admin'
    || activeProfile.allowedDashboardRoutes.includes('*');
  // Cleanup of dummy / wrong sheets — admin, accountants, unit heads, Technical.
  const canDeleteSheet = isFactoryAccountant
    || role === 'unit_head'
    || role === 'factory_operator'
    || activeProfile.baseRoleId === 'unit_head'
    || activeProfile.baseRoleId === 'factory_operator';
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [liveBatches, setLiveBatches] = useState<BatchDisplay[]>([]);
  const [prodSheets, setProdSheets] = useState<ProductionSheetRow[]>([]);
  const [updateFlash, setUpdateFlash] = useState<string | null>(null);
  const [tourOffer, setTourOffer] = useState(false);
  const highlightBatchNo = searchParams.get('highlight');

  useEffect(() => {
    if (tourWasSeen(BATCH_FLOW_TOUR_ID)) return;
    const tmr = window.setTimeout(() => setTourOffer(true), 600);
    return () => window.clearTimeout(tmr);
  }, []);

  function openTour() {
    setTourOffer(false);
    launchBatchFlowTour();
  }
  const batchSort = useSortable(liveBatches, {
    num: b => b.num,
    plant: b => b.plant,
    recipe: b => b.recipe,
    target: b => b.target,
    current: b => b.current,
    drums: b => b.drums,
    op: b => b.op,
    qc: b => b.qc,
  });

  async function loadProductionSheets() {
    const { data, error } = await supabase
      .from('production_batch_sheets')
      .select('id, batch_no, reactor_seq, density, stage, sheet_photo_urls, bucket_photo_urls, heat_sample_photo_urls, colour_note, created_by_name, created_at, plants(name), reactors(code, name)')
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<ProductionSheetRow[]>();

    if (!error && data) {
      setProdSheets(data.map(r => ({ ...r, source: 'native' as const })));
      return;
    }

    // Live DB may not have production_batch_sheets yet (migration 0009). Sheets are
    // stored on active_batches as PBS-* (old) or P12-13 (reactor-seq format).
    console.warn('[BatchSheet] production sheets unavailable — loading legacy active_batches', error?.message);
    const { data: legacy, error: legacyErr } = await supabase
      .from('active_batches')
      .select('id, batch_no, started_at, final_gravity, operator_name, sheet_details, plants(name)')
      .or('batch_no.like.PBS-%,batch_no.like.P%-%')
      .order('started_at', { ascending: false })
      .limit(200)
      .returns<{
        id: string;
        batch_no: string;
        started_at: string;
        final_gravity?: number | null;
        operator_name?: string | null;
        sheet_details?: LegacySheetDetails | null;
        plants?: { name?: string | null } | null;
      }[]>();
    if (legacyErr) {
      console.warn('[BatchSheet] legacy sheets:', legacyErr.message);
      setProdSheets([]);
      return;
    }
    setProdSheets(
      (legacy ?? [])
        .filter((row) => isProductionSheetBatchNo(row.batch_no) || !!row.sheet_details?.stage)
        .map(mapLegacyActiveBatch),
    );
  }

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('active_batches')
        .select('*, profiles(name), plants(name), batch_readings(id)')
        .eq('status', 'active')
        .returns<BatchSource[]>();
      if (data) {
        setLiveBatches(data.map(formatBatch));
      }
    }
    load();
    loadProductionSheets();

    // After Create Batch Sheet → land here with ?highlight=PBS-… so the new row is obvious.
    // Clear the query once sheets are in and we've had a moment to flash the row.
  }, []);

  useEffect(() => {
    if (!highlightBatchNo || prodSheets.length === 0) return;
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
    const readingsSub = supabase.channel('batch_readings_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'batch_readings' }, (payload) => {
        const bId = payload.new.batch_id;
        setUpdateFlash(bId);
        setLiveBatches(prev => prev.map(b => {
          if (b.id === bId) {
            return {
              ...b,
              current: b.current + 10,
              drums: b.drums + 1,
              editCount: b.editCount + 1
            };
          }
          return b;
        }));
        setTimeout(() => setUpdateFlash(null), 2000);
      })
      .subscribe();

    const batchesSub = supabase.channel('active_batches_dashboard_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'active_batches' }, async (payload) => {
        const { data: rows } = await supabase
          .from('active_batches')
          .select('*, profiles(name), plants(name), batch_readings(id)')
          .eq('id', payload.new.id)
          .limit(1)
          .returns<BatchSource[]>();
        const data = rows?.[0];

        if (data) {
          const formatted = formatBatch(data);
          setLiveBatches(prev => {
            if (prev.some(b => b.id === formatted.id)) return prev;
            return [formatted, ...prev];
          });
          setUpdateFlash(formatted.id);
          setTimeout(() => setUpdateFlash(null), 3000);
        } else {
          const formatted = formatBatch(payload.new as BatchSource);
          setLiveBatches(prev => {
            if (prev.some(b => b.id === formatted.id)) return prev;
            return [formatted, ...prev];
          });
          setUpdateFlash(formatted.id);
          setTimeout(() => setUpdateFlash(null), 3000);
        }
      })
      .subscribe();

    const prodSub = supabase.channel('production_batch_sheets_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'production_batch_sheets' }, () => {
        loadProductionSheets();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(readingsSub);
      supabase.removeChannel(batchesSub);
      supabase.removeChannel(prodSub);
    };
  }, []);

  async function advanceStage(row: ProductionSheetRow) {
    if (!isFactoryAccountant) {
      toast.error(t('batchProd.accountantOnly', 'Only Factory Accountant can move batch stage.'));
      return;
    }
    const next = row.stage === 'created' ? 'in_stock' : row.stage === 'in_stock' ? 'dispatched' : null;
    if (!next) return;

    if (row.source === 'legacy') {
      const { error } = await updateRows('active_batches', {
        sheet_details: { ...(row.legacyDetails ?? {}), stage: next },
      }).eq('id', row.id);
      if (error) {
        toast.error(error.message);
        return;
      }
    } else {
      const { error } = await updateRows('production_batch_sheets', {
        stage: next,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    setProdSheets(prev => prev.map(r => r.id === row.id ? {
      ...r,
      stage: next,
      legacyDetails: r.source === 'legacy' ? { ...(r.legacyDetails ?? {}), stage: next } : r.legacyDetails,
    } : r));
  }

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

  return (
    <>
      {tourOffer && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-bold text-amber-950">
              {t('batchSheetTour.offerTitle', 'New here? Take the full batch walkthrough')}
            </div>
            <p className="text-xs text-amber-900/80 mt-0.5">
              {t('batchSheetTour.offerBody', 'Follows one batch end to end: New Batch, hourly readings, close, batch sheet with density and photos, then stock and dispatch.')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                markTourSeen(BATCH_FLOW_TOUR_ID);
                setTourOffer(false);
              }}
              className="text-xs font-semibold text-amber-900/70 hover:text-amber-950 px-2 py-1.5"
            >
              {t('batchSheetTour.dismissOffer', 'Not now')}
            </button>
            <button
              type="button"
              onClick={openTour}
              className="text-xs font-bold px-3 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-700"
            >
              {t('batchSheetTour.startOffer', 'Start walkthrough')}
            </button>
          </div>
        </div>
      )}

      <div className="card2 p-6 mb-5" data-tour="prod-register">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div className="text-base font-bold font-heading">{t('batchProd.registerTitle', 'Production batch sheets')}</div>
            <div className="text-xs text-slate-500">
              {t('batchProd.registerSub', 'Batch no = reactor + sequence (e.g. P12-13) · density · evidence photos · stage')}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={openTour}
              className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              <CircleHelp size={14} strokeWidth={2.25} />
              {t('batchSheetTour.howThisWorks', 'How this works')}
            </button>
            <Link
              data-tour="create-sheet-btn"
              to="/dashboard/batch-entry?tab=create-sheet"
              className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm no-underline inline-block text-center"
            >
              + {t('nav.createBatchSheet', 'Create Batch Sheet')}
            </Link>
          </div>
        </div>
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <th>Batch no</th>
                <th>Plant</th>
                <th>Reactor</th>
                <th className="num">Rx seq</th>
                <th className="num">Density</th>
                <th>Photos</th>
                <th data-tour="prod-stage">Stage</th>
                <th>Created by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {prodSheets.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-12 px-4">
                    <div className="mx-auto max-w-sm">
                      <div className="text-sm font-heading font-semibold text-slate-700">
                        {t('batchProd.emptyTitle', 'No production batch sheets yet')}
                      </div>
                      <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
                        {t('batchProd.empty', 'Create one from Batch → Create Batch Sheet, or upload a sheet photo for OCR review.')}
                      </p>
                      <Link
                        to="/dashboard/batch-entry?tab=create-sheet"
                        className="btn-accent inline-block mt-4 rounded-[10px] px-4 py-2 font-semibold text-sm no-underline"
                      >
                        + {t('nav.createBatchSheet', 'Create Batch Sheet')}
                      </Link>
                    </div>
                  </td>
                </tr>
              )}
              {prodSheets.map(row => {
                const stage = STAGE_BADGE[row.stage] ?? STAGE_BADGE.created;
                const sheetUrls = row.sheet_photo_urls ?? [];
                const bucketUrls = row.bucket_photo_urls ?? [];
                const heatUrls = row.heat_sample_photo_urls ?? [];
                const photoCount = sheetUrls.length + bucketUrls.length + heatUrls.length;
                const isHighlight = !!highlightBatchNo && row.batch_no === highlightBatchNo;
                const rowDomId = `prod-sheet-${row.batch_no.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                return (
                  <tr
                    key={row.id}
                    id={rowDomId}
                    className={isHighlight ? 'bg-amber-50 ring-2 ring-inset ring-amber-400' : undefined}
                  >
                    <td className="font-bold font-mono">{row.batch_no}</td>
                    <td>{row.plants?.name ?? '—'}</td>
                    <td>{row.reactors?.code ?? '—'}</td>
                    <td className="num">{row.reactor_seq}</td>
                    <td className="num">{row.density}</td>
                    <td>
                      <div className="flex flex-col gap-0.5">
                        {sheetUrls[0] && <a href={sheetUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Sheet ×{sheetUrls.length}</a>}
                        {bucketUrls[0] && <a href={bucketUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Bucket ×{bucketUrls.length}</a>}
                        {heatUrls[0] && <a href={heatUrls[0]} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-[var(--accent-deep)]">Heat ×{heatUrls.length}</a>}
                        {row.colour_note && <span className="text-[10px] text-slate-500">{row.colour_note}</span>}
                        {!photoCount && <span className="text-slate-400 text-xs">—</span>}
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ background: stage.bg, color: stage.color }}>{stage.label}</span>
                    </td>
                    <td className="text-slate-500 text-xs">{row.created_by_name ?? '—'}</td>
                    <td>
                      <div className="flex items-center gap-2 justify-end flex-wrap">
                        {row.stage !== 'dispatched' && isFactoryAccountant && (
                          <button
                            type="button"
                            onClick={() => advanceStage(row)}
                            className="text-[11px] font-bold text-amber-700 hover:underline"
                          >
                            {row.stage === 'created' ? '→ In stock' : '→ Dispatched'}
                          </button>
                        )}
                        {row.stage !== 'dispatched' && !isFactoryAccountant && (
                          <span className="text-[10px] text-slate-400">Accountant</span>
                        )}
                        {canDeleteSheet && (
                          <button
                            type="button"
                            disabled={deletingId === row.id}
                            onClick={() => deleteSheet(row)}
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

      <div className="grid grid-cols-12 gap-4 mb-5" data-tour="batch-kpis">
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-4">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">{t('batch.activeBatches')}</div>
          <div className="text-[28px] font-bold mt-1 num font-heading">{liveBatches.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">{t('batch.acrossFactories')}</div>
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-4">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">{t('batchProd.sheetsCount', 'Prod. sheets')}</div>
          <div className="text-[28px] font-bold mt-1 num font-heading">{prodSheets.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">{t('batchProd.meetingSpec', 'Meeting-spec register')}</div>
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-4">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">{t('batch.avgYield')}</div>
          <div className="text-[28px] font-bold mt-1 num font-heading text-slate-400">—</div>
          <div className="text-[11px] text-slate-400 mt-1">{t('batch.yieldWhenClosed', 'Shown when batches close')}</div>
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-4">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">{t('batch.varianceFlagged')}</div>
          <div className="text-[28px] font-bold mt-1 num font-heading">0</div>
          <div className="text-[11px] text-teal-700 mt-1">{t('batch.noVariance', 'No variance flags')}</div>
        </div>
      </div>

      <div className="card2 p-6" data-tour="active-batches">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div className="text-base font-bold font-heading">{t('batch.activeBatches')}</div>
            <div className="text-xs text-slate-500" data-tour="edited-hint">{t('batch.liveReadingsSub')}</div>
          </div>
          <Link
            to="/dashboard/batch-entry?tab=create-sheet"
            className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm no-underline inline-block text-center flex items-center justify-center"
          >
            + {t('nav.createBatchSheet', 'Create Batch Sheet')}
          </Link>
        </div>
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <Th sortKey="num" s={batchSort}>{t('batch.colBatchNo')}</Th><Th sortKey="plant" s={batchSort}>{t('common.plant')}</Th><Th sortKey="recipe" s={batchSort}>{t('batch.colRecipe')}</Th>
                <Th sortKey="target" s={batchSort} firstDir="desc" className="num">{t('batch.colTarget')}</Th><Th sortKey="current" s={batchSort} firstDir="desc" className="num">{t('batch.colCurrent')}</Th>
                <Th sortKey="drums" s={batchSort} firstDir="desc" className="num">{t('batch.colDrums')}</Th><th className="num">{t('batch.colElapsed')}</th>
                <Th sortKey="op" s={batchSort}>{t('batch.colOperator')}</Th>
                <Th sortKey="qc" s={batchSort}><span data-tour="qc-col">{t('batch.colQc')}</span></Th>
              </tr>
            </thead>
            <tbody>
              {batchSort.sorted.length === 0 && (
                <tr><td colSpan={9} className="text-center text-slate-400 py-10 text-sm">
                  {t('batch.noActive', 'No batches are running right now.')}
                  <br />
                  {t('batch.noActiveHint', 'Start one with “+ Start batch” — live readings and oil-ratio variance appear here as it runs.')}
                </td></tr>
              )}
              {batchSort.sorted.map(b => {
                const qc = QC_BADGE[b.qc] || QC_BADGE.awaiting;
                const isFlashing = updateFlash === b.id;
                return (
                  <tr key={b.num} style={{
                    cursor: 'pointer',
                    transition: 'background-color 0.5s',
                    backgroundColor: isFlashing ? '#D1FAE5' : 'transparent'
                  }}>
                    <td className="font-bold">#{b.num}</td>
                    <td>{b.plant}</td>
                    <td><span className="density-pill">{b.recipe}</span></td>
                    <td className="num">{b.target}</td>
                    <td className="num">
                      <span style={{ color: b.current >= b.target * 0.95 ? '#16A34A' : '#D97706' }}>
                        {b.current}
                      </span>{' '}
                      <span className="text-[10px] text-slate-400">
                        {Math.round((b.current / b.target) * 100) || 0}%
                      </span>
                    </td>
                    <td className="num">{b.drums}</td>
                    <td className="num text-slate-500">{b.elapsed === 'Live' ? t('batch.live') : b.elapsed}</td>
                    <td className="text-slate-500">{b.op}</td>
                    <td>
                      <div className="flex items-center justify-between gap-3">
                        <span className="badge" style={{ background: qc.bg, color: qc.color }}>
                          {t(`batch.qc.${b.qc}`, b.qc.toUpperCase())}
                        </span>
                        {b.editCount > 1 && (
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 cursor-help relative group font-bold tracking-wide select-none shrink-0"
                            title={t('batch.editedTimes', { times: b.editCount - 1 })}
                          >
                            {t('batch.edited')}
                            <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block bg-slate-950 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap z-50">
                              {t('batch.editedCount', { times: b.editCount - 1 })}
                            </span>
                          </span>
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
    </>
  );
}
