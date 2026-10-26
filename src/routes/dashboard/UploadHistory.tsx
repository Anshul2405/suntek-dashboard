/**
 * Upload History — admin-only recovery from an incorrect bulk import.
 *
 * The problem this solves: a wrong CSV/Excel file used to be permanent. There
 * was no record of which rows came from which file, so the only options were
 * hand-deleting hundreds of rows or wiping the whole register.
 *
 * Every import now registers a batch (migration 70) and stamps its rows with the
 * batch id. This screen lists those batches and deletes them — one, several, or
 * everything under the current filters.
 *
 * THE GUARANTEE, and where it is enforced: deleting a batch removes ONLY rows
 * carrying its id. A row typed in by hand has no batch id and cannot be reached;
 * a row from a different file carries a different id. That is a WHERE clause in
 * delete_import_batch(), not a promise this component keeps — which is also why
 * every deletion goes through the RPC rather than issuing DELETEs from here. The
 * RPC additionally checks the capability, counts what it is about to remove,
 * refuses when a stock register has live movements against it, rolls stock
 * baselines back, and writes the audit row — atomically.
 *
 * Two tabs: the uploads themselves, and the deletion audit trail. The audit tab
 * is read-only by policy (there is no client write policy on
 * import_batch_deletions), so a deletion cannot be un-recorded.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { History, Trash2, AlertTriangle, FileSpreadsheet, ShieldAlert, Download } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useRoleContext } from '../../contexts/RoleContext';
import { profileHasCapability } from '../../lib/profiles';
import { useStepUp } from '../../lib/useStepUp';
import { useToast } from '../../components/ui/toast';
import { SkeletonRows, ErrorState } from '../../components/ui/states';
import { usePagination } from '../../components/ui/usePagination';
import { useSortable } from '../../components/ui/useSortable';
import { exportToCsv, type CsvColumn } from '../../lib/utils/exportCsv';
import { humanizeError } from '../../lib/errors';
import {
  SectionCard, FilterBar, FilterSelect, ButtonV2, SegmentTabs, StatusPill,
  StatCard, TablePaginationV2, ThV2 as Th, InfoBanner,
} from '../../components/v2';
import {
  previewImportBatch, deleteImportBatches, moduleLabel, IMPORT_MODULES,
  describeDeleteError, type ImportBatchRow, type BatchPreview,
} from '../../lib/imports/batches';
import type { Database } from '../../lib/database.types';
import { formatDate, formatDateTime } from '../../lib/utils/formatting';

type DeletionRow = Database['public']['Tables']['import_batch_deletions']['Row'];

const fmtDT = (d: string | null | undefined) => formatDateTime(d);
const fmtD = (d: string | null | undefined) => formatDate(d);

const AUDIT_COLUMNS: CsvColumn[] = [
  { header: 'Deleted at', key: 'deleted_at' },
  { header: 'Batch ID', key: 'batch_id' },
  { header: 'Module', key: 'module' },
  { header: 'Plant', key: 'plant_name' },
  { header: 'Store', key: 'store_name' },
  { header: 'File name', key: 'file_name' },
  { header: 'Period', key: 'period_month' },
  { header: 'Uploaded by', key: 'uploaded_by_name' },
  { header: 'Uploaded at', key: 'uploaded_at' },
  { header: 'Records deleted', key: 'deleted_count' },
  { header: 'Forced', key: 'forced' },
  { header: 'Reason', key: 'reason' },
  { header: 'Deleted by', key: 'deleted_by_name' },
];

/** Date filter presets. Kept as a fixed set rather than a date picker — "which
 *  files went in today / this week" is the actual question an admin asks when a
 *  wrong upload has just happened. */
const RANGES = [
  { value: 'all',   label: 'Any date',    days: 0   },
  { value: '1',     label: 'Last 24 h',   days: 1   },
  { value: '7',     label: 'Last 7 days', days: 7   },
  { value: '30',    label: 'Last 30 days', days: 30 },
] as const;

export function UploadHistory() {
  const { t } = useTranslation();
  const { activeProfile } = useRoleContext();
  const { plants, stores, storeQuery, ready } = usePlantScope();
  const toast = useToast();
  const { stepUp, modal: stepUpModal } = useStepUp();

  // Deletion is capability-gated in the RPC too — this only decides whether the
  // affordance is even shown. Never the only check.
  const canDelete = profileHasCapability(activeProfile, 'delete_import_batch');

  const [tab, setTab] = useState<'uploads' | 'audit'>('uploads');
  const [batches, setBatches] = useState<ImportBatchRow[]>([]);
  const [deletions, setDeletions] = useState<DeletionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** When the list was fetched. The date filter measures from here rather than
   *  from Date.now() at render time — reading the clock during render is impure
   *  and would let rows silently drop out of a "Last 24 h" view between two
   *  unrelated re-renders, which is exactly the wrong behaviour while someone is
   *  ticking checkboxes. */
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  // Filters (requirement §2: filter by plant, module, date, uploader).
  //
  // Seeded from the URL so the Stock Register can link straight here already
  // narrowed to the register the user was looking at — arriving at an unfiltered
  // list of every upload across every factory would make them do the filtering
  // again, at the exact moment they are trying to undo one specific file.
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [plantFilter, setPlantFilter] = useState('all');
  const [storeFilter, setStoreFilter] = useState(() => params.get('store') ?? 'all');
  const [moduleFilter, setModuleFilter] = useState(() => params.get('module') ?? 'all');
  const [uploaderFilter, setUploaderFilter] = useState('all');
  const [rangeFilter, setRangeFilter] = useState<string>('all');
  const [showDeleted, setShowDeleted] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Confirmation dialog state. `previews` holds the LIVE counts from the RPC —
  // never a number computed here, so what the admin is shown is what will go.
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [previews, setPreviews] = useState<BatchPreview[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setLoadedAt(Date.now());
    try {
      // A stock batch belongs to a STORE; FAR and PM batches carry no store and
      // stay factory-owned, which storeQuery's null-store clause handles. Before
      // this, the keeper who uploaded a shared store's file could not see it in
      // his own history — so he could not delete it either.
      const [b, d] = await Promise.all([
        storeQuery(supabase.from('import_batches').select('*'))
          .order('created_at', { ascending: false }).returns<ImportBatchRow[]>(),
        // store_id arrives on the audit table with migration 80; until it is
        // applied every row reads null and falls back to the factory grant.
        storeQuery(supabase.from('import_batch_deletions').select('*'))
          .order('deleted_at', { ascending: false }).returns<DeletionRow[]>(),
      ]);
      // Migration 70 may not have been applied yet (the frontend ships first in
      // some environments). Degrade to an empty screen with an explanation
      // rather than an error page — the same posture PlantScopeContext takes
      // toward the stores/locations tables.
      if (b.error) {
        setBatches([]); setDeletions([]);
        setErr(humanizeError(b.error, { action: 'load the upload history', context: 'UploadHistory.load' }));
        return;
      }
      setBatches(b.data ?? []);
      setDeletions(d.error ? [] : (d.data ?? []));
    } finally {
      setLoading(false);
    }
  }, [storeQuery]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const plantName = useCallback(
    (id: string | null) => plants.find(p => p.id === id)?.name ?? '—', [plants],
  );
  const storeName = useCallback(
    (id: string | null) => stores.find(s => s.id === id)?.name ?? null, [stores],
  );

  /** Uploaders present in the data — the filter lists who has actually uploaded,
   *  not every user in the directory. */
  const uploaders = useMemo(
    () => [...new Set(batches.map(b => b.uploaded_by_name).filter((n): n is string => !!n))].sort(),
    [batches],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const days = RANGES.find(r => r.value === rangeFilter)?.days ?? 0;
    const cutoff = days ? loadedAt - days * 86_400_000 : 0;
    return batches.filter(b => {
      if (!showDeleted && b.status === 'deleted') return false;
      if (plantFilter !== 'all' && b.plant_id !== plantFilter) return false;
      if (storeFilter !== 'all' && b.store_id !== storeFilter) return false;
      if (moduleFilter !== 'all' && b.module !== moduleFilter) return false;
      if (uploaderFilter !== 'all' && b.uploaded_by_name !== uploaderFilter) return false;
      if (cutoff && new Date(b.created_at).getTime() < cutoff) return false;
      if (q && !((b.file_name || '').toLowerCase().includes(q)
              || plantName(b.plant_id).toLowerCase().includes(q)
              || (b.uploaded_by_name || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [batches, search, plantFilter, storeFilter, moduleFilter, uploaderFilter, rangeFilter, showDeleted, plantName, loadedAt]);

  const sort = useSortable(filtered, {
    created_at: b => b.created_at,
    module: b => b.module,
    plant: b => plantName(b.plant_id),
    file_name: b => b.file_name ?? '',
    row_count: b => b.row_count,
    uploaded_by_name: b => b.uploaded_by_name ?? '',
  }, { key: 'created_at', dir: 'desc' });
  const { pageRows, controls } = usePagination(sort.sorted, {
    resetKey: `${search}|${plantFilter}|${storeFilter}|${moduleFilter}|${uploaderFilter}|${rangeFilter}|${showDeleted}`,
  });

  const auditSort = useSortable(deletions, {
    deleted_at: d => d.deleted_at,
    module: d => d.module,
    plant_name: d => d.plant_name ?? '',
    deleted_count: d => d.deleted_count,
  }, { key: 'deleted_at', dir: 'desc' });
  const audit = usePagination(auditSort.sorted, { resetKey: 'audit' });

  /** Only live batches are deletable — a deleted one has nothing left to remove. */
  const deletableFiltered = useMemo(
    () => filtered.filter(b => b.status === 'active'), [filtered],
  );
  const selectedLive = useMemo(
    () => [...selected].filter(id => batches.some(b => b.id === id && b.status === 'active')),
    [selected, batches],
  );

  function toggle(id: string) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAllOnPage() {
    const ids = pageRows.filter(b => b.status === 'active').map(b => b.id);
    const allOn = ids.length > 0 && ids.every(id => selected.has(id));
    setSelected(s => {
      const n = new Set(s);
      ids.forEach(id => (allOn ? n.delete(id) : n.add(id)));
      return n;
    });
  }

  /**
   * Open the confirmation dialog, fetching the live count for every batch about
   * to go. Requirement §2: "See the number of records that will be deleted."
   */
  async function askDelete(ids: string[]) {
    if (!ids.length) return;
    setConfirmIds(ids); setPreviews(null); setPreviewErr(null);
    setOverride(false); setReason('');
    try {
      setPreviews(await Promise.all(ids.map(previewImportBatch)));
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : String(e));
    }
  }

  const totalToDelete = useMemo(
    () => (previews ?? []).reduce((n, p) => n + p.total, 0), [previews],
  );
  const allBlockers = useMemo(
    () => (previews ?? []).flatMap(p => p.blockers), [previews],
  );
  const needsOverride = allBlockers.length > 0;

  async function doDelete() {
    if (!confirmIds?.length || deleting) return;
    if (needsOverride && (!override || !reason.trim())) return;
    setDeleting(true);
    try {
      // Password step-up, matching every other privileged action in the app.
      // Deleting hundreds of imported records is not something a walked-away
      // session should be able to do.
      if (!(await stepUp())) return;
      const res = await deleteImportBatches(confirmIds, {
        force: needsOverride && override,
        reason: reason.trim() || undefined,
      });
      toast.success(t('uploads.toastDeleted', {
        defaultValue: 'Deleted {{files}} upload(s) and {{rows}} record(s).',
        files: res.batches, rows: res.deleted_count,
      }));
      setConfirmIds(null);
      setSelected(new Set());
      await load();
    } catch (e) {
      toast.error(describeDeleteError(e instanceof Error ? e.message : String(e)));
    } finally {
      setDeleting(false);
    }
  }

  const totals = useMemo(() => ({
    live: batches.filter(b => b.status === 'active').length,
    rows: batches.filter(b => b.status === 'active').reduce((n, b) => n + (b.row_count || 0), 0),
    deleted: deletions.length,
  }), [batches, deletions]);

  if (!ready || loading) return <SkeletonRows rows={6} />;

  return (
    <>
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-4">
          <StatCard className="h-full" icon={<FileSpreadsheet />} label={t('uploads.kpiFiles', 'Uploaded files')}
            value={loading ? '…' : totals.live} caption={t('uploads.kpiFilesCap', 'live batches across your factories')} />
        </div>
        <div className="col-span-12 sm:col-span-4">
          <StatCard className="h-full" icon={<History />} label={t('uploads.kpiRows', 'Imported records')}
            value={loading ? '…' : totals.rows} caption={t('uploads.kpiRowsCap', 'rows traceable to a file')} />
        </div>
        <div className="col-span-12 sm:col-span-4">
          <StatCard className="h-full" icon={<Trash2 />} label={t('uploads.kpiDeleted', 'Deletions logged')}
            value={loading ? '…' : totals.deleted} caption={t('uploads.kpiDeletedCap', 'permanent audit trail')} />
        </div>
      </div>

      <SegmentTabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'uploads', label: t('uploads.tabUploads', 'Uploaded files'), icon: <FileSpreadsheet />, count: totals.live },
          { key: 'audit',   label: t('uploads.tabAudit', 'Deletion audit'),   icon: <ShieldAlert />,     count: totals.deleted },
        ]}
      />

      {err && <div className="mb-4"><ErrorState message={err} onRetry={load} /></div>}

      {tab === 'uploads' ? (
        <>
          <FilterBar
            className="mb-4"
            search={search}
            onSearch={setSearch}
            searchPlaceholder={t('uploads.searchPh', 'Search file name, factory or uploader…')}
            onReset={() => {
              setSearch(''); setPlantFilter('all'); setStoreFilter('all'); setModuleFilter('all');
              setUploaderFilter('all'); setRangeFilter('all'); setShowDeleted(false);
            }}
          >
            <FilterSelect
              label={t('uploads.filterPlant', 'Factory')} value={plantFilter} onChange={setPlantFilter}
              options={[{ value: 'all', label: t('common.allPlants', 'All plants') },
                        ...plants.map(p => ({ value: p.id, label: p.name }))]}
            />
            {/* Only meaningful for stock uploads — FAR and PM are factory-owned
                and carry no store — so it appears once a store is in play. */}
            {stores.length > 1 && (
              <FilterSelect
                label={t('uploads.filterStore', 'Store')} value={storeFilter} onChange={setStoreFilter}
                options={[{ value: 'all', label: t('uploads.allStores', 'All stores') },
                          ...stores.map(s => ({ value: s.id, label: s.name }))]}
              />
            )}
            <FilterSelect
              label={t('uploads.filterModule', 'Module')} value={moduleFilter} onChange={setModuleFilter}
              options={[{ value: 'all', label: t('uploads.allModules', 'All modules') },
                        ...IMPORT_MODULES.map(m => ({ value: m.key, label: m.label }))]}
            />
            <FilterSelect
              label={t('uploads.filterUploader', 'Uploaded by')} value={uploaderFilter} onChange={setUploaderFilter}
              options={[{ value: 'all', label: t('uploads.allUploaders', 'Anyone') },
                        ...uploaders.map(u => ({ value: u, label: u }))]}
            />
            <FilterSelect
              label={t('uploads.filterDate', 'Uploaded')} value={rangeFilter} onChange={setRangeFilter}
              options={RANGES.map(r => ({ value: r.value, label: r.label }))}
            />
          </FilterBar>

          <SectionCard
            flush
            title={t('uploads.title', 'Uploaded files')}
            subtitle={t('uploads.subtitle', 'Every bulk CSV / Excel import, and the records it created. Deleting a file removes only the records it imported — never anything entered by hand.')}
            actions={
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-1.5 text-[12.5px] text-slate-600 cursor-pointer select-none">
                  <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />
                  {t('uploads.showDeleted', 'Show already-deleted')}
                </label>
                {canDelete && (
                  <>
                    <ButtonV2
                      variant="outline" icon={<Trash2 />} disabled={selectedLive.length === 0}
                      onClick={() => askDelete(selectedLive)}
                    >
                      {t('uploads.deleteSelected', { defaultValue: 'Delete selected ({{n}})', n: selectedLive.length })}
                    </ButtonV2>
                    {/* Requirement §2: "Delete all uploads shown under the applied
                        filters." Resolved to explicit ids here so the RPC deletes
                        exactly what the admin can see — never a server-side filter
                        that might match more. */}
                    <ButtonV2
                      variant="danger" icon={<Trash2 />} disabled={deletableFiltered.length === 0}
                      onClick={() => askDelete(deletableFiltered.map(b => b.id))}
                      title={t('uploads.deleteFilteredHint', 'Delete every upload currently listed by the filters above')}
                    >
                      {t('uploads.deleteFiltered', { defaultValue: 'Delete all filtered ({{n}})', n: deletableFiltered.length })}
                    </ButtonV2>
                  </>
                )}
              </div>
            }
          >
            {!canDelete && (
              <div className="px-5 pb-4">
                <InfoBanner tone="blue">
                  {t('uploads.readOnlyNote', 'You can see the upload history, but deleting imported data is restricted to administrators.')}
                </InfoBanner>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    {canDelete && (
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label={t('uploads.selectPage', 'Select all on this page')}
                          checked={pageRows.some(b => b.status === 'active')
                                   && pageRows.filter(b => b.status === 'active').every(b => selected.has(b.id))}
                          onChange={toggleAllOnPage}
                        />
                      </th>
                    )}
                    <Th sortKey="created_at" s={sort} firstDir="desc">{t('uploads.thWhen', 'Uploaded')}</Th>
                    <Th sortKey="file_name" s={sort}>{t('uploads.thFile', 'File name')}</Th>
                    <Th sortKey="module" s={sort}>{t('uploads.thModule', 'Module')}</Th>
                    <Th sortKey="plant" s={sort}>{t('uploads.thPlant', 'Factory')}</Th>
                    <Th sortKey="row_count" s={sort} firstDir="desc" className="num">{t('uploads.thRows', 'Records')}</Th>
                    <Th sortKey="uploaded_by_name" s={sort}>{t('uploads.thBy', 'Uploaded by')}</Th>
                    <th>{t('uploads.thStatus', 'Status')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={canDelete ? 9 : 8} className="text-center text-slate-400 py-8 text-sm">
                        {batches.length === 0
                          ? t('uploads.emptyAll', 'No bulk uploads recorded yet. Files imported from now on will appear here and can be removed if they are wrong.')
                          : t('uploads.emptyFiltered', 'No uploads match these filters.')}
                      </td>
                    </tr>
                  ) : pageRows.map(b => {
                    const isDeleted = b.status === 'deleted';
                    const sName = storeName(b.store_id);
                    return (
                      <tr key={b.id} style={isDeleted ? { opacity: 0.55 } : undefined}>
                        {canDelete && (
                          <td>
                            <input
                              type="checkbox" disabled={isDeleted}
                              aria-label={t('uploads.selectRow', 'Select this upload')}
                              checked={selected.has(b.id)} onChange={() => toggle(b.id)}
                            />
                          </td>
                        )}
                        <td className="whitespace-nowrap">{fmtDT(b.created_at)}</td>
                        <td>
                          <div className="font-medium">{b.file_name || '—'}</div>
                          {b.period_month && (
                            <div className="text-[11px] text-slate-500">
                              {t('uploads.period', 'Period')}: {b.period_month.slice(0, 7)}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap">{moduleLabel(b.module)}</td>
                        <td>
                          <div>{plantName(b.plant_id)}</div>
                          {sName && <div className="text-[11px] text-slate-500">{sName}</div>}
                        </td>
                        <td className="num font-semibold">{b.row_count}</td>
                        <td>{b.uploaded_by_name || '—'}</td>
                        <td>
                          {isDeleted
                            ? <StatusPill tone="red" label={t('uploads.stDeleted', 'Deleted')} dot />
                            : <StatusPill tone="green" label={t('uploads.stActive', 'Active')} dot />}
                        </td>
                        <td className="whitespace-nowrap">
                          {b.file_url && (
                            <a href={b.file_url} target="_blank" rel="noreferrer"
                               className="text-[12px] font-semibold text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
                              <Download size={13} />{t('uploads.original', 'Original')}
                            </a>
                          )}
                          {canDelete && !isDeleted && (
                            <button
                              onClick={() => askDelete([b.id])}
                              className="ml-3 text-[12px] font-semibold text-red-600 hover:text-red-700"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                            >
                              {t('common.delete', 'Delete')}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TablePaginationV2 controls={controls} label={t('uploads.nounFiles', 'files')} />
          </SectionCard>
        </>
      ) : (
        /* ── Deletion audit trail ─────────────────────────────────────────── */
        <SectionCard
          flush
          title={t('uploads.auditTitle', 'Deletion audit')}
          subtitle={t('uploads.auditSubtitle', 'Permanent record of every deleted upload — kept even after the file and its records are gone, and not editable through the app.')}
          actions={
            <ButtonV2
              variant="outline" icon={<Download />} disabled={deletions.length === 0}
              onClick={() => exportToCsv('upload-deletion-audit',
                AUDIT_COLUMNS,
                deletions.map(d => ({ ...d, module: moduleLabel(d.module), forced: d.forced ? 'YES' : 'no' })) as unknown as Record<string, unknown>[],
                [['Suntek — Upload deletion audit'], ['Generated at', formatDateTime(new Date())]])}
            >
              {t('common.export', 'Export')}
            </ButtonV2>
          }
        >
          <div className="overflow-x-auto">
            <table className="dt">
              <thead>
                <tr>
                  <Th sortKey="deleted_at" s={auditSort} firstDir="desc">{t('uploads.thDeletedAt', 'Deleted')}</Th>
                  <Th sortKey="plant_name" s={auditSort}>{t('uploads.thPlant', 'Factory')}</Th>
                  <Th sortKey="module" s={auditSort}>{t('uploads.thModule', 'Module')}</Th>
                  <th>{t('uploads.thFile', 'File name')}</th>
                  <Th sortKey="deleted_count" s={auditSort} firstDir="desc" className="num">{t('uploads.thRowsDeleted', 'Records removed')}</Th>
                  <th>{t('uploads.thBy2', 'Deleted by')}</th>
                  <th>{t('uploads.thReason', 'Reason')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-slate-400 py-8 text-sm">
                      {t('uploads.auditEmpty', 'No uploads have been deleted.')}
                    </td>
                  </tr>
                ) : audit.pageRows.map(d => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap">{fmtDT(d.deleted_at)}</td>
                    <td>
                      <div>{d.plant_name || '—'}</div>
                      {d.store_name && <div className="text-[11px] text-slate-500">{d.store_name}</div>}
                    </td>
                    <td className="whitespace-nowrap">{moduleLabel(d.module)}</td>
                    <td>
                      <div className="font-medium">{d.file_name || '—'}</div>
                      <div className="text-[11px] text-slate-500">
                        {t('uploads.uploadedOn', 'uploaded')} {fmtD(d.uploaded_at)} · {d.uploaded_by_name || '—'}
                      </div>
                    </td>
                    <td className="num font-semibold">{d.deleted_count}</td>
                    <td>
                      <div>{d.deleted_by_name || '—'}</div>
                      {d.forced && (
                        <StatusPill tone="red" label={t('uploads.forced', 'Forced')} icon={<AlertTriangle />} className="mt-1" />
                      )}
                    </td>
                    <td className="text-[12px] text-slate-600" style={{ maxWidth: 280 }}>{d.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePaginationV2 controls={audit.controls} label={t('uploads.nounDeletions', 'deletions')} />
        </SectionCard>
      )}

      {/* ── Confirmation ────────────────────────────────────────────────────
          The exact number comes from preview_import_batch(), the same
          expression the deletion uses — so the figure the admin approves and
          the figure that is removed cannot drift apart. */}
      {confirmIds && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900, padding: 16 }}
          onClick={() => !deleting && setConfirmIds(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 560, background: '#fff', borderRadius: 16, border: '1px solid #E2E8F0', boxShadow: '0 24px 60px rgba(0,0,0,0.28)', maxHeight: '88vh', overflowY: 'auto', padding: 22 }}
          >
            <div className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center rounded-full shrink-0"
                    style={{ width: 38, height: 38, background: '#FEE2E2', color: '#DC2626' }}>
                <Trash2 size={18} />
              </span>
              <div>
                <div className="font-heading font-semibold text-[17px]">
                  {t('uploads.confirmTitle', 'Delete uploaded data?')}
                </div>
                <div className="text-[12.5px] text-slate-500 mt-0.5">
                  {t('uploads.confirmSub', 'Records entered manually, and records from other files, are not affected.')}
                </div>
              </div>
            </div>

            {previewErr ? (
              <div className="mt-4 text-[13px] text-red-600">{describeDeleteError(previewErr)}</div>
            ) : !previews ? (
              <div className="mt-4"><SkeletonRows rows={2} /></div>
            ) : (
              <>
                <div className="mt-4 text-[13.5px] leading-relaxed" style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: '12px 14px', color: '#7F1D1D' }}>
                  {confirmIds.length === 1
                    ? t('uploads.confirmBodyOne', {
                        defaultValue: 'You are about to delete the selected upload and all {{rows}} records imported through it. This action cannot be undone.',
                        rows: totalToDelete,
                      })
                    : t('uploads.confirmBodyMany', {
                        defaultValue: 'You are about to delete {{files}} uploads and all {{rows}} records imported through them. This action cannot be undone.',
                        files: confirmIds.length, rows: totalToDelete,
                      })}
                </div>

                {/* Per-file breakdown, so a multi-select deletion is not a single
                    opaque number. */}
                <div className="mt-3" style={{ maxHeight: 180, overflowY: 'auto' }}>
                  {previews.map(p => (
                    <div key={p.batch_id} className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 text-[12.5px]">
                      <span className="truncate">{p.file_name || p.batch_id.slice(0, 8)}</span>
                      <span className="text-slate-500 whitespace-nowrap">
                        {moduleLabel(p.module)} · <strong>{p.total}</strong> {t('uploads.records', 'records')}
                      </span>
                    </div>
                  ))}
                </div>

                {needsOverride && (
                  <div className="mt-4" style={{ background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 12, padding: '12px 14px' }}>
                    <div className="flex items-center gap-2 text-[13px] font-bold" style={{ color: '#B45309' }}>
                      <AlertTriangle size={15} />
                      {t('uploads.blockedTitle', 'There is activity recorded against this data')}
                    </div>
                    <ul className="mt-2 text-[12.5px] list-disc pl-5" style={{ color: '#92400E' }}>
                      {allBlockers.map((b, i) => <li key={`${b.kind}-${i}`}>{b.detail}</li>)}
                    </ul>
                    <label className="flex items-start gap-2 mt-3 text-[12.5px] cursor-pointer select-none" style={{ color: '#7C2D12' }}>
                      <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} style={{ marginTop: 3 }} />
                      <span>{t('uploads.overrideLabel', 'I understand, and want to delete it anyway. Stock figures will be recalculated from the remaining months.')}</span>
                    </label>
                    <textarea
                      value={reason} onChange={e => setReason(e.target.value)}
                      placeholder={t('uploads.reasonPh', 'Why are you overriding this? (recorded in the audit trail)')}
                      rows={2}
                      style={{ width: '100%', marginTop: 10, padding: '9px 11px', fontSize: 13, border: '1.5px solid #FED7AA', borderRadius: 10, outline: 'none', fontFamily: 'inherit', resize: 'vertical' }}
                    />
                  </div>
                )}
              </>
            )}

            <div className="flex gap-2.5 mt-5">
              <ButtonV2 className="flex-1" variant="outline" disabled={deleting} onClick={() => setConfirmIds(null)}>
                {t('common.cancel', 'Cancel')}
              </ButtonV2>
              <ButtonV2
                className="flex-1" variant="danger" icon={<Trash2 />}
                disabled={deleting || !previews || !!previewErr || (needsOverride && (!override || !reason.trim()))}
                onClick={doDelete}
              >
                {deleting
                  ? t('uploads.deleting', 'Deleting…')
                  : t('uploads.confirmDelete', { defaultValue: 'Delete {{rows}} records', rows: totalToDelete })}
              </ButtonV2>
            </div>
          </div>
        </div>
      )}

      {stepUpModal}
    </>
  );
}
