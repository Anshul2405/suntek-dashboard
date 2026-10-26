import React, { useState, useEffect, useMemo } from 'react';
import { patchUrlParams } from '../../../lib/urlParams';
import { displayLocationName } from '../../../lib/plantLabels';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListChecks, Package, Recycle, Plus, FileText, Hourglass, PackageCheck, Zap } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { fetchActivePlants } from '../../../lib/plants';
import { insertRows, updateRows } from '../../../lib/db';
import { useMentionNotifier } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, OcrUpload, PanelFooter } from '../../../components/SlidePanel';
import { KpiInfoButton } from '../../../components/KpiInfoButton';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState, EmptyState } from '../../../components/ui/states';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { usePagination } from '../../../components/ui/usePagination';
import { useSortable } from '../../../components/ui/useSortable';
import { SegmentTabs, StatCard, SectionCard, ButtonV2, TablePaginationV2, ThV2 as Th } from '../../../components/v2';
import { TableSearch, useTextFilter } from '../../../components/ui/TableSearch';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { useRoleContext } from '../../../contexts/RoleContext';
import { isAdminProfile } from '../../../lib/profiles';
import { withEmbedFallback } from '../../../lib/scopedList';
import { StockRegister } from './StockRegister';
import { STORE_REQ_WAITING, isWaitingReq, isMyApproval, canDecideStoreReq, waitingCountsAsMyQueue } from '../../../lib/store/requisitionQueue';
import { useMyIdentity } from '../../../lib/useMyIdentity';
import { ticketNoForId, reqNoLabel } from '../../../lib/ticketNo';
import { DateRangeFilter } from '../../../components/v2';
import { formatDateTime, inIstDayRange } from '../../../lib/utils/formatting';
import { RepairScrapPanel } from './RepairScrapPanel';
import type { Database } from '../../../lib/database.types';

// ticket_id is added by migration NN_requisition_ticket_link.sql; typed here until
// database.types.ts is regenerated so requisitions raised from a maintenance ticket
// can deep-link back to it.
type ReqRow = Database['public']['Tables']['store_requisitions']['Row']
  & { plants?: { name: string | null } | null; ticket_id?: string | null };

function PicBadge({ url, onOpen }: { url: string | null; onOpen: () => void }) {
  const { t } = useTranslation();
  const Icon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
  if (!url) return <span className="pic-badge missing" title={t('storereq.no_pic_yet')}>{Icon}</span>;
  return (
    <button type="button" className="pic-badge" title={t('storereq.pic_on_file')} onClick={onOpen}
      style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, color: 'inherit' }}>
      {Icon}
    </button>
  );
}

const UNITS  = ['nos', 'kg', 'L', 'sets', 'MT', 'boxes'];

const URGENCY_MAP: Record<string, 'low' | 'medium' | 'high' | 'plant_stopper'> = {
  Normal: 'medium',
  Urgent: 'high',
};

const STATUS_STAGE: Record<string, { bg: string; color: string; label: string }> = {
  pending:    { bg: '#FEF3C7', color: '#D97706', label: 'Unit head' },
  pending_store:    { bg: '#FEF3C7', color: '#D97706', label: 'Store' },
  pending_approval: { bg: '#FEF3C7', color: '#D97706', label: 'Unit head' },
  pending_buyer:    { bg: '#FEF3C7', color: '#D97706', label: 'Buyer' },
  pending_vijay:    { bg: '#FEF3C7', color: '#D97706', label: 'Vijay' },
  approved:   { bg: '#DCFCE7', color: '#16A34A', label: 'Approved' },
  dispatched: { bg: '#DBEAFE', color: '#2563EB', label: 'Dispatched' },
  received:   { bg: '#DCFCE7', color: '#16A34A', label: 'Received' },
  rejected:   { bg: '#FEE2E2', color: '#DC2626', label: 'Rejected' },
};

type StoreTab = 'requirements' | 'stock' | 'scrap';

export function StoreRequisitions() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  // ?tab= keeps the active tab deep-linkable (single route → no RBAC change).
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeProfile } = useRoleContext();
  const isTechnical =
    activeProfile.id === 'factory_operator' || activeProfile.baseRoleId === 'factory_operator';
  const rawTab = searchParams.get('tab');
  // Meet Aug 2026: Technical only sees Stock Register under Store Req.
  const tab: StoreTab = isTechnical
    ? 'stock'
    : (rawTab === 'stock' || rawTab === 'scrap' ? rawTab : 'requirements');
  const setTab = (k: StoreTab) => {
    if (isTechnical && k !== 'stock') return;
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('tab', k); return p; }, { replace: true });
  };
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const { scopeQuery, allowedPlants, ready: scopeReady } = usePlantScope();
  const isAdmin = isAdminProfile(activeProfile);
  const canDecideReq = canDecideStoreReq(activeProfile, isAdmin);
  const waitingIsMine = waitingCountsAsMyQueue(activeProfile, isAdmin);
  const me = useMyIdentity();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [items, setItems] = useState<ReqRow[]>([]);
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Search and My/All live in the URL (?q=&view=mine) so they survive Back,
  // opening a linked ticket, or a refresh. Owner/admin stay on All.
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [approvalView, setApprovalView] = useState<'mine' | 'all'>(() => (searchParams.get('view') === 'mine' ? 'mine' : 'all'));
  useEffect(() => { if (isAdmin) setApprovalView('all'); }, [isAdmin]);
  useEffect(() => {
    patchUrlParams(setSearchParams, { q: search.trim(), view: approvalView === 'mine' ? 'mine' : '' });
  }, [search, approvalView, setSearchParams]);
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  // Row click → requisition detail panel (rows with a linked ticket jump straight to it).
  const [detailReq, setDetailReq] = useState<ReqRow | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [savingReq, setSavingReq] = useState(false);
  const [form, setForm] = useState({ item: '', plant: '', qty: '', unit: 'nos', priority: 'Normal', notes: '' });

  function openRow(r: ReqRow) {
    if (r.ticket_id) navigate(`/dashboard/purchase/maint?ticket=${r.ticket_id}&back=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    else setDetailReq(r);
  }

  const queuePending = searchParams.get('queue') === 'pending';
  const listed = useMemo(() => {
    const from = searchParams.get('fromDate') || '';
    const to = searchParams.get('toDate') || '';
    return items.filter(r => {
      if (queuePending && !isWaitingReq(r.status)) return false;
      if (approvalView === 'mine' && !isMyApproval(r, { ids: me.ids, canDecide: canDecideReq, waitingIsMine })) return false;
      return inIstDayRange(r.created_at, from, to);
    });
  }, [items, queuePending, searchParams, approvalView, me.ids, canDecideReq, waitingIsMine]);
  const filtered = useTextFilter(listed, search, r => [r.item, r.plants?.name, displayLocationName(r.plants?.name), reqNoLabel(r), r.status, r.ticket_id ? ticketNoForId(r.ticket_id) : '']);
  const reqSort = useSortable(filtered, {
    reqno: r => r.id,
    ticket: r => r.ticket_id ?? null,
    item: r => r.item,
    plant: r => r.plants?.name,
    qty: r => r.qty,
    stage: r => r.status,
  });
  const { pageRows, controls } = usePagination(reqSort.sorted, { resetKey: `${search}|${approvalView}|${queuePending}|${reqSort.sort.key}|${reqSort.sort.dir}` });

  async function load() {
    try {
      const { data: plantsData } = await fetchActivePlants<{ id: string; name: string }>('id, name');
      if (plantsData && plantsData.length > 0) setDbPlants(plantsData);

      const { data, error } = await withEmbedFallback(
        scopeQuery(supabase.from('store_requisitions').select('*, plants(name)'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<ReqRow[]>(),
        () => scopeQuery(supabase.from('store_requisitions').select('*'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<ReqRow[]>(),
        'StoreRequisitions.list',
      );
      if (error) throw error;
      setItems(data || []);
      setLoadError(false);
    } catch (err) {
      console.error('[StoreRequisitions] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restrict the plant picker to the user's allowed plants (all if global).
  // Factory options from the DB, restricted to the user's own. No hard-coded
  // fallback: after a rename it would offer names that no longer exist. The
  // form stores the plant ID, so a rename cannot orphan an in-flight request.
  const plantOptions = useMemo(
    () => [...plantsForPicker(allowedPlants, scopeReady)].sort((a, b) => a.name.localeCompare(b.name)),
    [allowedPlants, scopeReady],
  );

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    // A plant-less request matches no plant grant, so no Unit Head would ever
    // see it to approve: the plant is required (defaults to your only one).
    const plantId = form.plant || (plantOptions.length === 1 ? plantOptions[0].id : '');
    if (!form.item.trim() || !form.qty || !plantId || savingReq) return;
    setSavingReq(true);
    try {
    const plant = dbPlants.find(p => p.id === plantId) ?? plantOptions.find(p => p.id === plantId);
    const row = {
      item: form.item,
      plant_id: plantId,
      // raised_by is a uuid (auth user) on this table, not a name.
      qty: parseFloat(form.qty) || 0,
      urgency: URGENCY_MAP[form.priority] || 'medium',
      status: 'pending' as const,
      remarks: [form.unit ? `Unit: ${form.unit}` : '', form.notes].filter(Boolean).join(' · ') || null,
    };
    let { data, error } = await insertRows('store_requisitions', { ...row, raised_by: me.authUserId }).select('*, plants(name)').single();
    // A database without the raised_by column still takes the request.
    if (error && /raised_by/.test(error.message || '')) {
      ({ data, error } = await insertRows('store_requisitions', row).select('*, plants(name)').single());
    }

    if (error) {
      toast.error(t('storereq.save_failed', { message: error.message }));
      return;
    }
    if (data) {
      setItems(prev => [data as ReqRow, ...prev]);
      // Notify admin and unit head
      insertRows('notifications', {
        target_roles: ['admin', 'unit_head'],
        title: t('storereq.notif_title', { item: form.item }),
        body: `${plant?.name ?? ''} · ${t('storereq.qty_label')}: ${form.qty} ${form.unit} · ${form.priority}`,
        type: form.priority === 'Urgent' ? 'urgent' : 'info',
        route: '/dashboard/purchase/storereq',
        actor_name: plant?.name ?? '',
        actor_role: 'warehouse_manager',
        read_by: [],
        plant_id: plant?.id || null, // deliver only to this plant's unit head + admin
      }).then(() => {}, () => {});
      await notifyMentions(form.notes, {
        entityType: 'store_requisition', entityId: (data as ReqRow).id,
        entityLabel: t('storereq.entity_label', { item: form.item }), route: '/dashboard/purchase/storereq',
      });
    }
    const hits = await screenBlacklist(
      [{ value: form.item, label: 'Item' }, { value: form.notes, label: 'Notes' }],
      { workflow: 'Store Requisition', source: 'entry', entityLabel: `Store req · ${form.item}` },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('storereq.blacklist_alert', { value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }
    setSaved(true);
    setTimeout(() => { setOpen(false); setSaved(false); setForm({ item: '', plant: '', qty: '', unit: 'nos', priority: 'Normal', notes: '' }); }, 1600);
    } finally {
      setSavingReq(false);
    }
  }

  function handleClose() { setOpen(false); setSaved(false); }

  async function decideReq(row: ReqRow, status: 'approved' | 'rejected' | 'dispatched') {
    if (!canDecideReq) {
      toast.error(t('storereq.decide_forbidden', 'Only Unit Head / Admin can decide this request.'));
      return;
    }
    setDeciding(true);
    try {
      // Record who decided (approved_by is a uuid); a database without the
      // column still takes the decision.
      const decidedBy = status === 'dispatched' ? {} : { approved_by: me.authUserId };
      let { error } = await updateRows('store_requisitions', { status, ...decidedBy }).eq('id', row.id);
      if (error && /approved_by/.test(error.message || '')) {
        ({ error } = await updateRows('store_requisitions', { status }).eq('id', row.id));
      }
      if (error) {
        toast.error(t('storereq.decide_failed', { message: error.message, defaultValue: 'Update failed: {{message}}' }));
        return;
      }
      setItems(prev => prev.map(r => r.id === row.id ? { ...r, status } : r));
      setDetailReq(prev => prev && prev.id === row.id ? { ...prev, status } : prev);
      toast.success(
        status === 'approved' ? t('storereq.approved_ok', 'Request approved') :
        status === 'rejected' ? t('storereq.rejected_ok', 'Request rejected') :
        t('storereq.dispatched_ok', 'Marked dispatched'),
      );
      insertRows('notifications', {
        target_roles: ['admin', 'unit_head', 'store_manager_maint', 'store_manager_chl'],
        title: t('storereq.decide_notif_title', {
          defaultValue: 'Store req {{status}}: {{item}}',
          status,
          item: row.item,
        }),
        body: `#${row.id.slice(0, 8)} · ${row.plants?.name ?? ''}`,
        type: status === 'rejected' ? 'urgent' : 'info',
        route: '/dashboard/purchase/storereq',
        actor_name: activeProfile.name || '',
        actor_role: activeProfile.id,
        read_by: [],
        plant_id: row.plant_id || null,
      }).then(() => {}, () => {});
    } finally {
      setDeciding(false);
    }
  }

  // Summary tiles for the Requirements tab (computed from the loaded rows).
  // Same waiting set as Overview's Pending Approvals and ?queue=pending.
  const pendingCount   = items.filter(r => isWaitingReq(r.status)).length;
  const readyCount     = items.filter(r => ['approved', 'dispatched'].includes(r.status)).length;
  const urgentCount    = items.filter(r => ['high', 'plant_stopper'].includes(r.urgency ?? '')).length;

  return (
    <>
      {/* Tab bar — Requirements · Stock Register · Scrap */}
      <SegmentTabs
        className="mb-5"
        items={isTechnical
          ? [{ key: 'stock', label: t('storereq.tab_stock', 'Stock Register'), icon: <Package /> }]
          : [
              { key: 'requirements', label: t('storereq.tab_requirements', 'Requirements'), icon: <ListChecks /> },
              { key: 'stock',        label: t('storereq.tab_stock', 'Stock Register'),      icon: <Package /> },
              { key: 'scrap',        label: t('storereq.tab_scrap', 'Repair/Scrap'),        icon: <Recycle /> },
            ]}
        value={tab}
        onChange={setTab}
      />

      {/* ── Consolidated stock register (uploaded file + live usage) ────────── */}
      {tab === 'stock' && <StockRegister />}

      {/* ── Repair & scrap tracking (post-maintenance asset movement) ───────── */}
      {tab === 'scrap' && <RepairScrapPanel />}

      {tab === 'requirements' && (
      <>
      {/* Summary tiles */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <StatCard className="col-span-6 lg:col-span-3" icon={<FileText />} tone="blue"
          label={t('storereq.stat_total', 'Total Requirements')} value={loading ? '…' : String(items.length)}
          caption={t('storereq.stat_total_sub', 'Open requests')}
          onView={() => document.getElementById('open-reqs')?.scrollIntoView({ behavior: 'smooth' })}
          viewLabel={t('common.view', 'View')} />
        <StatCard className="col-span-6 lg:col-span-3" icon={<Hourglass />} tone="amber"
          label={t('storereq.stat_pending', 'Pending Approval')} value={loading ? '…' : String(pendingCount)}
          caption={t('storereq.stat_pending_sub', 'Awaiting approval')}
          onView={() => { setSearch(''); document.getElementById('open-reqs')?.scrollIntoView({ behavior: 'smooth' }); }}
          viewLabel={t('storereq.viewPending', 'See pending')} />
        <StatCard className="col-span-6 lg:col-span-3" icon={<PackageCheck />} tone="green"
          label={t('storereq.stat_ready', 'Ready to Fulfil')} value={loading ? '…' : String(readyCount)}
          caption={t('storereq.stat_ready_sub', 'Approved & in progress')}
          onView={() => document.getElementById('open-reqs')?.scrollIntoView({ behavior: 'smooth' })}
          viewLabel={t('common.view', 'View')} />
        <StatCard className="col-span-6 lg:col-span-3" icon={<Zap />} tone="purple" valueTone={urgentCount > 0 ? 'orange' : 'default'}
          label={t('storereq.stat_urgent', 'Urgent')} value={loading ? '…' : String(urgentCount)}
          caption={t('storereq.stat_urgent_sub', 'High priority requests')}
          onView={() => { setSearch('Urgent'); document.getElementById('open-reqs')?.scrollIntoView({ behavior: 'smooth' }); }}
          viewLabel={t('storereq.viewUrgent', 'See urgent')} />
      </div>

      {/* Requirements table */}
      <div className="relative" id="open-reqs">
        <KpiInfoButton info={{ title: 'Open Store Requirements', what: 'All active store requisitions raised by plant/store keepers. Each row shows approval stage and photo proof. Raise via "+ Raise request"; Unit Head / Admin can approve, reject, or mark dispatched.', source: 'Supabase', formLabel: 'Raise request form', formPath: '/dashboard/purchase/storereq', note: 'Live table store_requisitions. Maintenance part indents still flow via maintenance_store_requests on the Maintenance screen.' }} />
      <SectionCard
        flush
        title={t('storereq.open_req_title')}
        subtitle={t('storereq.open_req_subtitle')}
        actions={
          <ButtonV2 variant="primary" icon={<Plus />} onClick={() => { setForm(f => ({ ...f, plant: f.plant || (plantOptions.length === 1 ? plantOptions[0].id : '') })); setOpen(true); }}>
            {t('storereq.raise_request_btn')}
          </ButtonV2>
        }
      >
        {loadError ? (
          <div className="px-5 pb-5">
            <ErrorState title={t('storereq.load_error_title')} message={t('storereq.load_error_msg')}
              onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
          </div>
        ) : loading ? (
          <div className="px-5 pb-5"><SkeletonRows rows={6} /></div>
        ) : (
        <>
          <div className="px-5 pb-4 flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[180px]"><TableSearch value={search} onChange={setSearch} placeholder={t('storereq.search_ph', 'Search item, plant, ticket…')} /></div>
            {!isAdmin ? (
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
              <button type="button" onClick={() => setApprovalView('mine')} style={{ padding: '7px 10px', background: approvalView === 'mine' ? '#0F172A' : '#fff', color: approvalView === 'mine' ? '#fff' : '#475569', border: 'none' }}>{t('storereq.myApprovals', 'My approvals')}</button>
              <button type="button" onClick={() => setApprovalView('all')} style={{ padding: '7px 10px', background: approvalView === 'all' ? '#0F172A' : '#fff', color: approvalView === 'all' ? '#fff' : '#475569', border: 'none' }}>{t('storereq.allApprovals', 'All approvals')}</button>
            </div>
            ) : null}
          </div>
          {filtered.length === 0 ? (
            <div className="px-5 pb-5"><EmptyState title={t('storereq.open_req_empty')} message={search ? t('common.noMatches', 'No rows match your search.') : undefined} /></div>
          ) : (
            <div className="overflow-x-auto scroll-x">
              <table className="dt2">
                <thead>
                  <tr>
                    <Th sortKey="reqno" s={reqSort}>{t('storereq.col_req_no')}</Th><Th sortKey="ticket" s={reqSort}>{t('storereq.col_ticket', 'Ticket #')}</Th><Th sortKey="item" s={reqSort}>{t('storereq.col_item')}</Th><Th sortKey="plant" s={reqSort}>{t('storereq.col_plant')}</Th><Th sortKey="qty" s={reqSort} firstDir="desc" className="num">{t('storereq.col_qty')}</Th>
                    <Th sortKey="stage" s={reqSort}>{t('storereq.col_stage')}</Th><th>{t('storereq.col_awaiting')}</th><th>{t('storereq.col_decision')}</th><th>{t('storereq.col_pic')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map(r => {
                    const s = STATUS_STAGE[r.status] || STATUS_STAGE.pending;
                    const stageKey = STATUS_STAGE[r.status] ? r.status : 'pending';
                    return (
                      <tr
                        key={r.id}
                        onClick={() => openRow(r)}
                        style={{ cursor: 'pointer' }}
                        title={r.ticket_id ? t('storereq.open_ticket', 'Open maintenance ticket') : t('storereq.open_detail', 'View request details')}
                      >
                        <td className="font-bold text-xs text-slate-400">{reqNoLabel(r)}</td>
                        <td>
                          {r.ticket_id
                            ? <span className="num text-xs text-blue-600 font-semibold">#{ticketNoForId(r.ticket_id)}</span>
                            : <span className="text-xs text-slate-400" title={t('storereq.direct_req_hint', 'Raised from Store Req, not from a maintenance ticket')}>{t('storereq.direct_req', 'Direct')}</span>}
                        </td>
                        <td>{r.item}</td>
                        <td>{displayLocationName(r.plants?.name) || '—'}</td>
                        <td className="num">{r.qty}</td>
                        <td>
                          <span className="badge" style={{ background: s.bg, color: s.color }}>{t('storereq.stage_' + stageKey)}</span>
                        </td>
                        <td className="text-slate-500">{isWaitingReq(stageKey) ? t('storereq.awaiting_' + stageKey) : '—'}</td>
                        <td className="font-semibold">{t('storereq.decision_' + (isWaitingReq(stageKey) ? 'pending' : stageKey))}</td>
                        <td onClick={e => e.stopPropagation()}><PicBadge url={r.photo_url} onOpen={() => r.photo_url && setLightbox([{ url: r.photo_url, label: r.item }])} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <TablePaginationV2 controls={controls} label={t('storereq.pagination_noun', 'requirements')} />
            </div>
          )}
        </>
        )}
      </SectionCard>
      </div>
      </>
      )}

      {/* Slide panel */}
      <SlidePanel open={open} onClose={handleClose} title={t('storereq.panel_title')} subtitle={t('storereq.panel_subtitle')}>
        <PanelField label={t('storereq.field_item')}>
          <PanelInput placeholder={t('storereq.ph_item')} value={form.item} onChange={e => set('item', e.target.value)} />
        </PanelField>

        <PanelRow>
          <PanelField label={t('storereq.field_plant')}>
            <PanelSelect value={form.plant} onChange={e => set('plant', e.target.value)}>
              {!form.plant && <option value="">{t('storereq.selectPlant', 'Select factory…')}</option>}
              {plantOptions.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </PanelSelect>
          </PanelField>
          <PanelField label={t('storereq.field_priority')}>
            <PanelSelect value={form.priority} onChange={e => set('priority', e.target.value)}>
              <option value="Normal">{t('storereq.opt_normal')}</option>
              <option value="Urgent">{t('storereq.opt_urgent')}</option>
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('storereq.field_quantity')}>
            <PanelInput type="number" placeholder={t('storereq.ph_qty')} value={form.qty} onChange={e => set('qty', e.target.value)} />
          </PanelField>
          <PanelField label={t('storereq.field_unit')}>
            <PanelSelect value={form.unit} onChange={e => set('unit', e.target.value)}>
              {UNITS.map(u => <option key={u}>{u}</option>)}
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelField label={t('storereq.field_reason')}>
          <PanelTextarea placeholder={t('storereq.ph_reason')} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </PanelField>

        <PanelDivider />

        <OcrUpload
          label={t('storereq.ocr_label')}
          hint={t('storereq.ocr_hint')}
          fields={[
            { key: 'item',  label: t('storereq.ocr_field_item'), value: 'Mechanical seal — pump P-104' },
            { key: 'qty',   label: t('storereq.ocr_field_qty'),  value: '2' },
            { key: 'notes', label: t('storereq.ocr_field_notes'), value: 'Worn seal causing leakage at flange joint' },
          ]}
          onExtracted={data => {
            if (data.item)  set('item',  data.item);
            if (data.qty)   set('qty',   data.qty);
            if (data.notes) set('notes', data.notes);
          }}
        />

        <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 16 }}>
          {t('storereq.panel_helper')}
        </div>

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('storereq.save_label')}
          successLabel={t('storereq.success_label')}
          successSub={t('storereq.success_sub')}
          disabled={!form.item.trim() || !form.qty || savingReq || !(form.plant || plantOptions.length === 1)}
          requiredHint={t('storereq.required_hint')}
        />
      </SlidePanel>

      {/* ── PANEL: Requisition detail (rows without a linked ticket) ─────── */}
      <SlidePanel
        open={!!detailReq}
        onClose={() => setDetailReq(null)}
        title={detailReq?.item || t('storereq.detail_title', 'Requisition')}
        subtitle={detailReq ? `#${reqNoLabel(detailReq)} · ${displayLocationName(detailReq.plants?.name) || '—'}` : ''}
      >
        {detailReq && (() => {
          const s = STATUS_STAGE[detailReq.status] || STATUS_STAGE.pending;
          const stageKey = STATUS_STAGE[detailReq.status] ? detailReq.status : 'pending';
          const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #F1F5F9' }}>
              <span style={{ fontSize: 12, color: '#94A3B8' }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', textAlign: 'right' }}>{v}</span>
            </div>
          );
          return (
            <div>
              <Row k={t('storereq.col_req_no')} v={`#${reqNoLabel(detailReq)}`} />
              <Row k={t('storereq.col_item')} v={detailReq.item} />
              <Row k={t('storereq.col_plant')} v={displayLocationName(detailReq.plants?.name) || '—'} />
              <Row k={t('storereq.col_qty')} v={String(detailReq.qty)} />
              <Row k={t('storereq.field_priority')} v={detailReq.urgency === 'high' || detailReq.urgency === 'plant_stopper' ? t('storereq.opt_urgent') : t('storereq.opt_normal')} />
              <Row k={t('storereq.col_stage')} v={<span className="badge" style={{ background: s.bg, color: s.color }}>{t('storereq.stage_' + stageKey)}</span>} />
              <Row k={t('storereq.col_decision')} v={t('storereq.decision_' + (isWaitingReq(stageKey) ? 'pending' : stageKey))} />
              {detailReq.remarks && <Row k={t('storereq.field_reason')} v={detailReq.remarks} />}
              <Row k={t('storereq.detail_requested', 'Requested on')} v={detailReq.created_at ? formatDateTime(detailReq.created_at) : '—'} />
              {detailReq.photo_url && (
                <button
                  type="button"
                  onClick={() => setLightbox([{ url: detailReq.photo_url as string, label: detailReq.item }])}
                  style={{ marginTop: 14, padding: 0, border: '1px solid #E2E8F0', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', background: 'none', lineHeight: 0, width: '100%' }}
                  title={t('storereq.pic_on_file')}
                >
                  <img src={detailReq.photo_url} alt={detailReq.item} style={{ width: '100%', maxHeight: 220, objectFit: 'cover', display: 'block' }} />
                </button>
              )}
              {canDecideReq && detailReq.status === 'pending' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => decideReq(detailReq, 'approved')}>
                    {t('storereq.approve_btn', 'Approve')}
                  </ButtonV2>
                  <ButtonV2 variant="ghost" disabled={deciding} onClick={() => decideReq(detailReq, 'rejected')}>
                    {t('storereq.reject_btn', 'Reject')}
                  </ButtonV2>
                </div>
              )}
              {canDecideReq && detailReq.status === 'approved' && (
                <div style={{ marginTop: 16 }}>
                  <ButtonV2 variant="primary" disabled={deciding} onClick={() => decideReq(detailReq, 'dispatched')}>
                    {t('storereq.dispatch_btn', 'Mark dispatched')}
                  </ButtonV2>
                </div>
              )}
            </div>
          );
        })()}
      </SlidePanel>

      <ImageLightbox images={lightbox || []} open={!!lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}
