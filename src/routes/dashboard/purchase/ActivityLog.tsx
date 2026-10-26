import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { supabase } from '../../../lib/supabase';
import { fetchActivePlants } from '../../../lib/plants';
import { insertRows, updateRows } from '../../../lib/db';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, OcrUpload, PanelFooter } from '../../../components/SlidePanel';
import { KpiInfoButton } from '../../../components/KpiInfoButton';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState, EmptyState } from '../../../components/ui/states';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th } from '../../../components/v2';
import { TableSearch } from '../../../components/ui/TableSearch';
import { useDirectory, extractMentionIds, truncate } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { ensureLateApproval, useOpsSettings, recordAudit, loadAudit } from '../../../lib/opsControls';
import { useRoleContext } from '../../../contexts/RoleContext';
import { profileHasCapability, type RoleRow } from '../../../lib/profiles';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { withEmbedFallback } from '../../../lib/scopedList';
import { useNotifications } from '../../../contexts/NotificationsContext';
import type { Database } from '../../../lib/database.types';
import { displayLocationName } from '../../../lib/plantLabels';
import { listedPhotoUrls } from './maintenance/shared';
import { fetchAllRowsProgressive } from '../../../lib/fetchAll';

type Tables = Database['public']['Tables'];
type PlantRel = { plants?: { name: string | null } | null };
type ActivityRow = Tables['activity_logs']['Row'] & PlantRel;
type TicketRow = Tables['maintenance_tickets']['Row'] & PlantRel;
type StoreReqRow = Tables['maintenance_store_requests']['Row'];

// One normalized row for the unified timeline — whether it came from the
// activity_logs table (manual) or was derived from the maintenance workflow.
type UnifiedRow = {
  key: string;
  equipment: string;
  type: string;            // event kind / activity type
  date: string;            // ISO or YYYY-MM-DD
  doneBy: string | null;
  verifiedBy: string | null;
  plant: string | null;
  hasPhoto: boolean;
  photos: LightboxImage[];    // actual evidence images for this row (opens the lightbox)
  ticketRef: string | null;   // short maintenance ticket id, e.g. "f855d730"
  ticketId: string | null;    // full id, so the ticket number can open the ticket
  source: 'manual' | 'maintenance' | 'incident' | 'audit' | 'purchase' | 'requisition' | 'far' | 'batch';
};

const ticketRef = (id: string) => id.slice(0, 8);

function recordHref(
  row: Pick<UnifiedRow, 'source' | 'key' | 'ticketId' | 'equipment'>,
  fromPath: string,
): string | null {
  const withFrom = (path: string) => {
    const q = new URLSearchParams();
    const [base, existing] = path.split('?');
    if (existing) {
      new URLSearchParams(existing).forEach((value, key) => q.set(key, value));
    }
    q.set('from', fromPath);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  if (row.source === 'maintenance' && row.ticketId) {
    return withFrom(`/dashboard/purchase/maint?ticket=${row.ticketId}`);
  }
  if (row.source === 'incident') {
    const id = row.key.replace(/^incident-/, '');
    return withFrom(`/dashboard/purchase/maint?tab=incidents&incident=${id}`);
  }
  if (row.source === 'purchase') {
    return `/dashboard/purchase/storereq?tab=stock&receipt=${row.key.replace(/^purchase-/, '')}&from=${encodeURIComponent(fromPath)}`;
  }
  if (row.source === 'requisition') {
    return `/dashboard/purchase/storereq?req=${row.key.replace(/^req-/, '')}&from=${encodeURIComponent(fromPath)}`;
  }
  if (row.source === 'far') {
    return `/dashboard/purchase/far?asset=${row.key.replace(/^far-/, '')}&from=${encodeURIComponent(fromPath)}`;
  }
  if (row.source === 'batch' && row.equipment && row.equipment !== '—') {
    return `/dashboard/batches?highlight=${encodeURIComponent(row.equipment)}&from=${encodeURIComponent(fromPath)}`;
  }
  return null;
}
/** Build a lightbox image list from [url, label] pairs, dropping empties. */
const photoList = (pairs: [string | null | undefined, string][]): LightboxImage[] =>
  pairs.filter(([u]) => !!u).map(([u, label]) => ({ url: u as string, label }));
const toMs = (ts: string | null | undefined) => (ts ? new Date(ts).getTime() : 0);
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const CameraSvg = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>
);

/** Clickable when the row has photos → opens them in the lightbox; a muted
 *  placeholder otherwise. Previously this was a dead badge that did nothing. */
function PicBadge({ photos, onOpen }: { photos: LightboxImage[]; onOpen: () => void }) {
  const { t } = useTranslation();
  if (photos.length === 0) {
    return <span className="pic-badge missing" title={t('activity.noPicYet', 'No pic yet')}><CameraSvg /></span>;
  }
  return (
    <button
      type="button"
      className="pic-badge"
      title={t('activity.viewNPhotos', { defaultValue: 'View {{count}} photo(s)', count: photos.length })}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 2 }}
    >
      <CameraSvg />
      {photos.length > 1 && <span style={{ fontSize: 9, fontWeight: 700 }}>{photos.length}</span>}
    </button>
  );
}


// Build the derived maintenance-lifecycle events. Each milestone (raised, part
// procured, part handed over, repair completed, defective part decided) becomes
// one timeline row — so the Activity Log is the single overall record of "what
// happened, where, by whom, with proof", keyed by the maintenance ticket #.
// `t` is passed in from the component so the derived strings re-translate on
// language change (never call hooks in module-level helpers).
function deriveMaintenanceEvents(tickets: TicketRow[], srs: StoreReqRow[], t: TFunction): UnifiedRow[] {
  const srByTicket = new Map<string, StoreReqRow[]>();
  for (const s of srs) {
    if (!s.ticket_id) continue;
    (srByTicket.get(s.ticket_id) ?? srByTicket.set(s.ticket_id, []).get(s.ticket_id)!).push(s);
  }

  const out: UnifiedRow[] = [];
  for (const tk of tickets) {
    const ref = tk.ticket_no || ticketRef(tk.id);
    const plant = displayLocationName(tk.plants?.name) || null;

    // 1) Raised
    const raisePhotos = photoList(listedPhotoUrls(tk.defective_raise_photo_url, tk.defective_raise_photo_urls).map(u => [u, t('activity.photoRaise', 'Raise photo')]));
    out.push({
      key: `${tk.id}:raised`, equipment: tk.equipment,
      type: tk.type === 'emergency' ? t('activity.evtEmergencyRaised', 'Emergency raised') : t('activity.evtPeriodicRaised', 'Periodic raised'),
      date: tk.created_at, doneBy: tk.raised_by || tk.assigned_to || null,
      verifiedBy: null, plant, hasPhoto: raisePhotos.length > 0, photos: raisePhotos, ticketRef: ref, ticketId: tk.id, source: 'maintenance',
    });

    // 1b) Review cycle — reviewer sent it back for correction at least once.
    // Full per-cycle detail lives in the ticket's Notes thread; this surfaces the
    // most recent request as a milestone so the loop is visible in the feed.
    if ((tk.revision_count ?? 0) > 0 && tk.revision_requested_at) {
      out.push({
        key: `${tk.id}:revision`, equipment: tk.equipment,
        type: `${t('activity.evtChangesRequested', 'Changes requested')}${(tk.revision_count ?? 0) > 1 ? ` ·×${tk.revision_count}` : ''}${tk.revision_reason ? ` · ${tk.revision_reason}` : ''}`,
        date: tk.revision_requested_at, doneBy: tk.revision_requested_by || null,
        verifiedBy: null, plant, hasPhoto: false, photos: [], ticketRef: ref, ticketId: tk.id, source: 'maintenance',
      });
    }

    // Store-request driven milestones
    for (const sr of srByTicket.get(tk.id) ?? []) {
      if (sr.supplier_name || sr.busy_transaction_ref) {
        const procPhotos = photoList(listedPhotoUrls(sr.handover_invoice_url, sr.handover_invoice_urls).map(u => [u, t('activity.photoSupplierInvoice', 'Supplier invoice')]));
        out.push({
          key: `${sr.id}:procured`, equipment: tk.equipment,
          type: `${t('activity.evtPartProcured', 'Part procured')} · ${sr.part_name}`, date: tk.closed_at || sr.created_at,
          doneBy: sr.supplier_name || t('activity.byProcurement', 'Procurement'), verifiedBy: null, plant,
          hasPhoto: procPhotos.length > 0, photos: procPhotos, ticketRef: ref, ticketId: tk.id, source: 'maintenance',
        });
      }
      if (sr.handover_confirmed_at) {
        const hoPhotos = photoList([
          ...listedPhotoUrls(sr.handover_photo_url, sr.handover_photo_urls).map(u => [u, t('activity.photoHandover', 'Handover photo')] as [string, string]),
          ...listedPhotoUrls(sr.handover_invoice_url, sr.handover_invoice_urls).map(u => [u, t('activity.photoHandoverInvoice', 'Handover invoice')] as [string, string]),
        ]);
        out.push({
          key: `${sr.id}:handover`, equipment: tk.equipment,
          type: `${t('activity.evtPartHandedOver', 'Part handed over')} · ${sr.part_name}`, date: sr.handover_confirmed_at,
          doneBy: t('activity.byStore', 'Store'), verifiedBy: null, plant,
          hasPhoto: hoPhotos.length > 0, photos: hoPhotos, ticketRef: ref, ticketId: tk.id, source: 'maintenance',
        });
      }
    }

    // 2) Defective-part decision
    if (tk.defective_part_decision) {
      const defPhotos = photoList(listedPhotoUrls(tk.defective_part_photo_url, tk.defective_part_photo_urls).map(u => [u, t('activity.photoDefectivePart', 'Defective part')]));
      const consumed = tk.defective_part_decision === 'consumed';
      out.push({
        key: `${tk.id}:defective`, equipment: tk.equipment,
        type: consumed
          ? t('activity.evtPartsConsumed', 'Issued parts consumed')
          : tk.defective_part_decision === 'scrap'
            ? t('activity.evtDefectiveScrapped', 'Defective part scrapped')
            : tk.defective_part_decision === 'mixed'
              ? t('activity.evtDefectiveMixed', 'Defective parts sent for repair and scrap')
              : t('activity.evtDefectiveSentRepair', 'Defective part sent for repair'),
        date: tk.closed_at || tk.created_at, doneBy: tk.assigned_to || null, verifiedBy: null, plant,
        hasPhoto: defPhotos.length > 0, photos: defPhotos, ticketRef: ref, ticketId: tk.id, source: 'maintenance',
      });
    }

    // 3) Completed / closed
    if (tk.status === 'closed') {
      const donePhotos = photoList([
        ...listedPhotoUrls(tk.completion_photo_url, tk.completion_photo_urls).map(u => [u, t('activity.photoCompletion', 'Completion photo')] as [string, string]),
        ...listedPhotoUrls(tk.defective_part_photo_url, tk.defective_part_photo_urls).map(u => [u, t('activity.photoDefectivePart', 'Defective part')] as [string, string]),
      ]);
      out.push({
        key: `${tk.id}:done`, equipment: tk.equipment,
        type: tk.type === 'emergency' ? t('activity.evtRepairCompleted', 'Repair completed') : t('activity.evtPeriodicCheckCompleted', 'Periodic check completed'),
        date: tk.closed_at || tk.created_at, doneBy: tk.assigned_to || null,
        verifiedBy: tk.raised_role || null,
        plant, hasPhoto: donePhotos.length > 0, photos: donePhotos,
        ticketRef: ref, ticketId: tk.id, source: 'maintenance',
      });
    }
  }
  return out;
}

const ACTIVITY_ROUTE = '/dashboard/purchase/activity';

/** Admin-only: grant Activity Log to other roles without opening Role Manager. */
function ActivityRoleAccessCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const { authProfile, roles, refreshRoles } = useRoleContext();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const mayEdit = !!authProfile && profileHasCapability(authProfile, 'manage_roles');
  const grantable = useMemo(
    () => roles.filter((r) => !r.is_admin && !(r.allowed_routes ?? []).includes('*')),
    [roles],
  );
  const enabledCount = grantable.filter((r) => (r.allowed_routes ?? []).includes(ACTIVITY_ROUTE)).length;

  if (!mayEdit) return null;

  async function toggleRole(role: RoleRow) {
    const current = role.allowed_routes ?? [];
    const on = current.includes(ACTIVITY_ROUTE);
    const next = on
      ? current.filter((x) => x !== ACTIVITY_ROUTE)
      : [...new Set([...current, ACTIVITY_ROUTE])];
    setBusyId(role.id);
    try {
      const { error } = await updateRows('roles', { allowed_routes: next }).eq('id', role.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      await refreshRoles();
      toast.success(
        on
          ? t('activity.accessRevoked', { defaultValue: 'Activity Log hidden for {{role}}', role: role.label })
          : t('activity.accessGranted', { defaultValue: 'Activity Log enabled for {{role}}', role: role.label }),
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card2 p-4 mb-5" style={{ border: '1px solid #FED7AA' }}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 text-left bg-transparent border-0 p-0 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div className="text-sm font-bold font-heading text-slate-900">
            {t('activity.whoCanView', 'Who can view Activity Log')}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {t('activity.whoCanViewSub', {
              defaultValue: 'Always on for Admin. Enabled for {{count}} other role(s).',
              count: enabledCount,
            })}
          </div>
        </div>
        <span className="text-xs font-semibold text-orange-700 shrink-0">
          {open ? t('activity.hideRoles', 'Hide') : t('activity.editRoles', 'Enable for roles')}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {grantable.map((role) => {
            const on = (role.allowed_routes ?? []).includes(ACTIVITY_ROUTE);
            const busy = busyId === role.id;
            return (
              <div
                key={role.id}
                className="flex items-center gap-3 px-3 py-2 rounded-xl border"
                style={{
                  borderColor: on ? '#FDBA74' : '#E2E8F0',
                  background: on ? '#FFF7ED' : '#F8FAFC',
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-slate-800 truncate">{role.label}</div>
                  <div className="text-[10px] text-slate-400 font-mono">{role.id}</div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={on}
                  title={on ? t('activity.revokeAccess', 'Turn off for this role') : t('activity.grantAccess', 'Turn on for this role')}
                  onClick={() => toggleRole(role)}
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 12,
                    background: on ? '#EA580C' : '#CBD5E1',
                    border: 'none',
                    cursor: busy ? 'wait' : 'pointer',
                    position: 'relative',
                    flexShrink: 0,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: '#fff',
                      position: 'absolute',
                      top: 3,
                      transition: 'left 0.2s',
                      left: on ? 22 : 4,
                    }}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ActivityLog() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const people = useDirectory();
  const { activeProfile } = useRoleContext();
  const ops = useOpsSettings();
  const { scopeQuery } = usePlantScope();
  const { addNotification } = useNotifications();
  const screenBlacklist = useBlacklistGuard();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [logs, setLogs] = useState<ActivityRow[]>([]);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [storeReqs, setStoreReqs] = useState<StoreReqRow[]>([]);
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showManualOnly, setShowManualOnly] = useState(false);
  const [head, setHead] = useState<'all' | 'tickets' | 'incidents' | 'purchases' | 'store' | 'far' | 'batches' | 'changes'>('all');
  const [incidents, setIncidents] = useState<{ id: string; what_text: string; who_text: string | null; solution_text: string | null; occurred_at: string; reported_by: string | null; plants?: { name: string } | null }[]>([]);
  const [audits, setAudits] = useState<{ id: string; created_at: string; actor_name: string | null; module: string | null; summary: string | null }[]>([]);
  const [purchases, setPurchases] = useState<{ id: string; vendor_name: string; invoice_no: string | null; purchase_date: string | null; created_at: string; actor_name: string | null; plant_id: string; bill_url: string | null }[]>([]);
  const [requisitions, setRequisitions] = useState<{ id: string; item: string; status: string; raised_by: string | null; created_at: string; plant_id: string | null }[]>([]);
  const [farRows, setFarRows] = useState<{ id: string; name: string; job_no: string | null; created_at: string; plant_id: string | null; deleted_at: string | null }[]>([]);
  const [batchRows, setBatchRows] = useState<{ id: string; batch_no: string; created_at: string; created_by_name: string | null; plant_id: string; stage: string }[]>([]);
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  const [search, setSearch] = useState('');
  const plantFilter = searchParams.get('plant') || '';
  const setPlantFilter = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('plant', value);
    else next.delete('plant');
    setSearchParams(next, { replace: true });
  };
  const activityHere = (() => {
    const next = new URLSearchParams();
    if (plantFilter) next.set('plant', plantFilter);
    if (search.trim()) next.set('q', search.trim());
    if (head !== 'all') next.set('head', head);
    const s = next.toString();
    return s ? `/dashboard/purchase/activity?${s}` : '/dashboard/purchase/activity';
  })();
  useEffect(() => {
    const q = (searchParams.get('q') || '').trim();
    if (q) setSearch(q);
    const rawHead = searchParams.get('head');
    if (rawHead === 'tickets' || rawHead === 'incidents' || rawHead === 'purchases' || rawHead === 'store' || rawHead === 'far' || rawHead === 'batches' || rawHead === 'changes') {
      setHead(rawHead);
    }
  }, [searchParams]);
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({ equipment: '', type: 'Regular', date: today, doneBy: '', verifiedBy: '', plant: '', notes: '' });

  async function load() {
    try {
      const { data: plantsData } = await fetchActivePlants<{ id: string; name: string }>('id, name');
      if (plantsData && plantsData.length > 0) setDbPlants(plantsData);

      const ticketSelect = 'id, ticket_no, equipment, type, created_at, raised_by, assigned_to, revision_count, revision_requested_at, revision_reason, revision_requested_by, defective_part_decision, defective_part_photo_url, defective_part_photo_urls, defective_raise_photo_url, defective_raise_photo_urls, status, closed_at, raised_role, completion_photo_url, completion_photo_urls';
      const [logsRes, ticketsRes] = await Promise.all([
        withEmbedFallback(
          scopeQuery(supabase.from('activity_logs').select('*, plants(name)')).order('date', { ascending: false }).returns<ActivityRow[]>(),
          () => scopeQuery(supabase.from('activity_logs').select('*')).order('date', { ascending: false }).returns<ActivityRow[]>(),
          'ActivityLog.logs',
        ),
        withEmbedFallback(
          fetchAllRowsProgressive<TicketRow>(
            (from, to) => scopeQuery(supabase.from('maintenance_tickets').select(`${ticketSelect}, plants(name)`), { unitCol: 'unit_id' })
              .order('created_at', { ascending: false }).order('id', { ascending: false })
              .range(from, to).returns<TicketRow[]>(),
            rows => { setTickets(rows); setLoading(false); },
          ),
          () => fetchAllRowsProgressive<TicketRow>(
            (from, to) => scopeQuery(supabase.from('maintenance_tickets').select(ticketSelect), { unitCol: 'unit_id' })
              .order('created_at', { ascending: false }).order('id', { ascending: false })
              .range(from, to).returns<TicketRow[]>(),
            rows => { setTickets(rows); setLoading(false); },
          ),
          'ActivityLog.tickets',
        ),
      ]);
      if (logsRes.error) throw logsRes.error;
      setLogs(logsRes.data || []);

      const tks = ticketsRes.data || [];
      setTickets(tks);
      setLoading(false);
      const ids = tks.map(x => x.id);
      const srRows: StoreReqRow[] = [];
      const srSelect = 'id, ticket_id, part_name, supplier_name, busy_transaction_ref, handover_invoice_url, handover_invoice_urls, handover_photo_url, handover_photo_urls, handover_confirmed_at, created_at';
      for (let i = 0; i < ids.length; i += 80) {
        const chunk = ids.slice(i, i + 80);
        const { data: srData } = await supabase.from('maintenance_store_requests').select(srSelect).in('ticket_id', chunk).returns<StoreReqRow[]>();
        if (srData?.length) srRows.push(...srData);
      }
      setStoreReqs(srRows);
      const incidentDb = supabase as unknown as { from: (t: string) => any };
      const { data: incidentRows } = await incidentDb.from('incident_reports').select('id, what_text, who_text, solution_text, occurred_at, reported_by, plants(name)').order('occurred_at', { ascending: false });
      setIncidents(incidentRows || []);
      setAudits(await loadAudit(200));
      const { data: purchaseRows } = await supabase.from('stock_purchase_receipts').select('id, vendor_name, invoice_no, purchase_date, created_at, actor_name, plant_id, bill_url').order('created_at', { ascending: false }).limit(400);
      setPurchases(purchaseRows || []);
      const { data: reqRows } = await supabase.from('store_requisitions').select('id, item, status, raised_by, created_at, plant_id').order('created_at', { ascending: false }).limit(400);
      setRequisitions(reqRows || []);
      const { data: assetRows } = await supabase.from('fixed_assets').select('id, name, job_no, created_at, plant_id, deleted_at').order('created_at', { ascending: false }).limit(400);
      setFarRows(assetRows || []);
      const { data: sheets } = await supabase.from('production_batch_sheets').select('id, batch_no, created_at, created_by_name, plant_id, stage').order('created_at', { ascending: false }).limit(400);
      setBatchRows(sheets || []);
      setLoadError(false);
    } catch (err) {
      console.error('[ActivityLog] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge manual entries + derived maintenance events into one sorted timeline.
  const rows = useMemo<UnifiedRow[]>(() => {
    const manual: UnifiedRow[] = logs.map((a, i) => ({
      key: a.id || `manual-${i}`,
      equipment: a.equipment || '—',
      type: a.type,
      date: a.date,
      doneBy: a.done_by,
      verifiedBy: a.verified_by,
      plant: displayLocationName(a.plants?.name) || null,
      hasPhoto: !!a.photo_url,
      photos: a.photo_url ? [{ url: a.photo_url, label: t('activity.photoActivity', 'Activity photo') }] : [],
      ticketRef: null,
      ticketId: null,
      source: 'manual',
    }));
    const derived = deriveMaintenanceEvents(tickets, storeReqs, t);
    const incidentRows: UnifiedRow[] = incidents.map((r) => ({
      key: `incident-${r.id}`,
      equipment: r.what_text,
      type: 'Incident',
      date: r.occurred_at,
      doneBy: r.who_text || r.reported_by,
      verifiedBy: r.solution_text,
      plant: displayLocationName(r.plants?.name) || null,
      hasPhoto: false,
      photos: [],
      ticketRef: null,
      ticketId: null,
      source: 'incident',
    }));
    const auditRows: UnifiedRow[] = audits.map((r) => ({
      key: `audit-${r.id}`,
      equipment: r.summary || r.module || 'Change',
      type: 'Record change',
      date: r.created_at,
      doneBy: r.actor_name,
      verifiedBy: r.module,
      plant: null,
      hasPhoto: false,
      photos: [],
      ticketRef: null,
      ticketId: null,
      source: 'audit',
    }));
    const plantById = new Map(dbPlants.map((p) => [p.id, displayLocationName(p.name)]));
    const purchaseRows: UnifiedRow[] = purchases.map((r) => ({
      key: `purchase-${r.id}`,
      equipment: r.vendor_name || 'Purchase',
      type: r.invoice_no ? `Purchase · ${r.invoice_no}` : 'Purchase',
      date: r.purchase_date || r.created_at,
      doneBy: r.actor_name,
      verifiedBy: null,
      plant: plantById.get(r.plant_id) || null,
      hasPhoto: !!r.bill_url,
      photos: r.bill_url ? [{ url: r.bill_url, label: 'Bill' }] : [],
      ticketRef: null,
      ticketId: null,
      source: 'purchase',
    }));
    const requisitionRows: UnifiedRow[] = requisitions.map((r) => ({
      key: `req-${r.id}`,
      equipment: r.item,
      type: `Store request · ${r.status.replace(/_/g, ' ')}`,
      date: r.created_at,
      doneBy: r.raised_by,
      verifiedBy: null,
      plant: (r.plant_id && plantById.get(r.plant_id)) || null,
      hasPhoto: false,
      photos: [],
      ticketRef: null,
      ticketId: null,
      source: 'requisition',
    }));
    const farHistory: UnifiedRow[] = farRows.map((r) => ({
      key: `far-${r.id}`,
      equipment: r.name,
      type: r.deleted_at ? 'FAR asset removed' : `FAR asset${r.job_no ? ` · ${r.job_no}` : ''}`,
      date: r.deleted_at || r.created_at,
      doneBy: null,
      verifiedBy: null,
      plant: (r.plant_id && plantById.get(r.plant_id)) || null,
      hasPhoto: false,
      photos: [],
      ticketRef: r.job_no,
      ticketId: null,
      source: 'far',
    }));
    const batchHistory: UnifiedRow[] = batchRows.map((r) => ({
      key: `batch-${r.id}`,
      equipment: r.batch_no,
      type: `Batch sheet · ${r.stage.replace(/_/g, ' ')}`,
      date: r.created_at,
      doneBy: r.created_by_name,
      verifiedBy: null,
      plant: plantById.get(r.plant_id) || null,
      hasPhoto: false,
      photos: [],
      ticketRef: null,
      ticketId: null,
      source: 'batch',
    }));
    const all = showManualOnly
      ? manual
      : [...manual, ...derived, ...incidentRows, ...auditRows, ...purchaseRows, ...requisitionRows, ...farHistory, ...batchHistory];
    const headed = head === 'tickets'
      ? all.filter((r) => r.source === 'maintenance')
      : head === 'incidents'
        ? all.filter((r) => r.source === 'incident')
        : head === 'purchases'
          ? all.filter((r) => r.source === 'purchase')
          : head === 'store'
            ? all.filter((r) => r.source === 'requisition')
            : head === 'far'
              ? all.filter((r) => r.source === 'far')
              : head === 'batches'
                ? all.filter((r) => r.source === 'batch')
                : head === 'changes'
                  ? all.filter((r) => r.source === 'audit' || r.source === 'manual')
                  : all;
    return headed.sort((a, b) => toMs(b.date) - toMs(a.date));
  }, [logs, tickets, storeReqs, incidents, audits, purchases, requisitions, farRows, batchRows, dbPlants, showManualOnly, head, t]);

  const fromMaintenance = rows.filter(r => r.source === 'maintenance').length;
  const verified = rows.filter(r => r.verifiedBy).length;
  const withPhoto = rows.length ? Math.round((rows.filter(r => r.hasPhoto).length / rows.length) * 100) : 0;

  // Factory names come from the DB only — a hard-coded fallback would keep
  // offering names that no longer exist after a rename. The filter compares
  // display names on both sides (rows carry the same live join), so it stays
  // consistent; the entry form below keys off the plant ID.
  const plantNames = [...new Set(dbPlants.map(p => displayLocationName(p.name)).filter(Boolean))].sort();
  const plantOptions = [...dbPlants].sort((a, b) => a.name.localeCompare(b.name));

  // Search + plant filter, then paginate — Activity Log grows unbounded over time.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!plantFilter || r.plant === plantFilter) &&
      (!q || [r.equipment, r.type, r.doneBy, r.verifiedBy, r.plant, r.ticketRef].some(f => (f || '').toLowerCase().includes(q))),
    );
  }, [rows, search, plantFilter]);
  const actSort = useSortable(filtered, {
    equipment: r => r.equipment,
    activity: r => r.type,
    ticket: r => r.ticketRef,
    date: r => new Date(r.date),
    doneBy: r => r.doneBy,
    verifiedBy: r => r.verifiedBy,
    plant: r => r.plant,
  }, { key: 'date', dir: 'desc' });
  const { pageRows, controls } = usePagination(actSort.sorted, { resetKey: `${search}|${plantFilter}|${showManualOnly}|${head}|${actSort.sort.key}|${actSort.sort.dir}` });

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    if (!form.equipment.trim() || !form.doneBy.trim()) return;
    const allowed = await ensureLateApproval({ module: 'activity', entryDate: form.date, profile: activeProfile, bufferDays: ops.bufferDays });
    if (!allowed) { toast.error('Not saved. Management has to approve this date first.'); return; }
    const plant = dbPlants.find(p => p.id === form.plant);
    const { data, error } = await insertRows('activity_logs', {
      equipment: form.equipment,
      type: form.type.toLowerCase(),
      date: form.date,
      done_by: form.doneBy,
      verified_by: form.verifiedBy || null,
      plant_id: plant?.id || null,
    }).select('*, plants(name)').single();

    if (error) {
      toast.error(t('activity.saveFailed', { message: error.message }));
      return;
    }
    if (data) setLogs(prev => [data as ActivityRow, ...prev]);
    void recordAudit({ module: 'activity', action: 'logged', summary: `${form.type} · ${form.equipment} · ${form.date}`, actorName: activeProfile.name, actorRole: activeProfile.roleLabel });

    // Notify anyone @-tagged in the notes (Teams-style heads-up).
    const mentionIds = extractMentionIds(form.notes, people).filter(id => id !== activeProfile.id);
    if (mentionIds.length) {
      await addNotification({
        target_roles: mentionIds,
        title: t('activity.taggedTitle', { name: activeProfile.name }),
        body: `${form.equipment}: “${truncate(form.notes)}”`,
        type: 'info',
        route: '/dashboard/purchase/activity',
        actor_name: activeProfile.name,
        actor_role: activeProfile.roleLabel,
      });
    }

    // Screen the people/equipment named on this entry against the blacklist.
    const hits = await screenBlacklist(
      [
        { value: form.doneBy, label: t('activity.colDoneBy') },
        { value: form.verifiedBy, label: t('activity.colVerifiedBy') },
        { value: form.equipment, label: t('activity.colEquipment') },
      ],
      { workflow: 'Activity Log', source: 'entry', entityLabel: form.equipment },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('activity.blacklistHit', { value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }

    setSaved(true);
    setTimeout(() => { setOpen(false); setSaved(false); setForm({ equipment: '', type: 'Regular', date: today, doneBy: '', verifiedBy: '', plant: '', notes: '' }); }, 1600);
  }

  function handleClose() { setOpen(false); setSaved(false); }

  return (
    <>
      <ActivityRoleAccessCard />
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-5 mb-5">
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'All activity events', what: 'Every activity across all plants — manual log entries PLUS milestones auto-fed from the maintenance workflow (raised, procured, handed over, completed, defective decided). The single overall record.', source: 'Derived', note: 'Manual activity_logs + maintenance_tickets / maintenance_store_requests milestones.' }} />
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiTotal')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{rows.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">{t('activity.kpiFromMaintenance', { count: fromMaintenance })}</div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Verified', what: 'Activity events that carry a verifier (supervisor / unit head sign-off, or the raising role on a completed maintenance ticket).', source: 'Derived' }} />
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiVerified')}</div>
          <div className="text-[28px] font-extrabold mt-1 num text-green-600">{verified}</div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Pending verification', what: 'Events with no verifier yet. These need supervisor sign-off.', source: 'Derived' }} />
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiPending')}</div>
          <div className="text-[28px] font-extrabold mt-1 num text-amber-600">{rows.length - verified}</div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Photo proof coverage', what: 'Percentage of activity events that carry photo proof — manual uploads plus the completion / handover / defective-part photos captured through the maintenance workflow.', source: 'Derived' }} />
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiPhotoProof')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{withPhoto}%</div>
        </div>
      </div>

      {/* Table — amber-soft */}
      <div className="card2 p-6" style={{ position: 'relative' }}>
        <KpiInfoButton info={{ title: 'Activity log book', what: 'The overall record of activity across all plants. Maintenance milestones flow in automatically and are tagged with their ticket #; ad-hoc work is added with "+ Log activity". Every row aims to carry photo proof.', source: 'Derived', note: 'Auto-fed from the maintenance workflow + manual activity_logs entries.' }} />
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <div className="text-base font-bold font-heading">{t('activity.logBookTitle')}</div>
            <div className="text-xs text-slate-500">{t('activity.logBookSubtitle')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`pill px-3 py-2 text-xs font-semibold ${showManualOnly ? 'btn-ghost' : 'btn-ghost'}`}
              style={{ border: '1px solid #E2E8F0', background: showManualOnly ? '#fff' : '#0F172A', color: showManualOnly ? '#475569' : '#fff' }}
              onClick={() => setShowManualOnly(v => !v)}
              title={t('activity.toggleFeedTitle')}
            >
              {showManualOnly ? t('activity.showMaintenanceFeed') : t('activity.manualOnly')}
            </button>
            <button className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm" onClick={() => setOpen(true)}>
              + {t('activity.logActivityBtn')}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {([
                ['all', 'All history'],
                ['tickets', 'Tickets & maintenance'],
                ['incidents', 'Incident reports'],
                ['purchases', 'Purchases & bills'],
                ['store', 'Store requests'],
                ['far', 'FAR'],
                ['batches', 'Batch sheets'],
                ['changes', 'Edits & other records'],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setHead(key)} className={`chip${head === key ? ' active' : ''}`}>{label}</button>
              ))}
            </div>
            <TableSearch value={search} onChange={setSearch} placeholder={t('activity.searchPh', 'Search equipment, activity, person, ticket…')} style={{ marginBottom: 0 }} />
          </div>
          <select value={plantFilter} onChange={e => setPlantFilter(e.target.value)} style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer' }}>
            <option value="">{t('activity.allPlants', 'All plants')}</option>
            {plantNames.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        {loadError ? (
          <ErrorState title={t('activity.errorTitle')} message={t('activity.errorMessage')}
            onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
        ) : loading ? (
          <SkeletonRows rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState title={t('activity.emptyState')} message={search || plantFilter ? t('activity.noMatches', 'No rows match your filters.') : undefined} />
        ) : (
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <Th sortKey="equipment" s={actSort}>{t('activity.colEquipment')}</Th><Th sortKey="activity" s={actSort}>{t('activity.colActivity')}</Th><Th sortKey="ticket" s={actSort}>{t('activity.colTicket')}</Th><Th sortKey="date" s={actSort} firstDir="desc">{t('activity.colDate')}</Th>
                <Th sortKey="doneBy" s={actSort}>{t('activity.colDoneBy')}</Th><Th sortKey="verifiedBy" s={actSort}>{t('activity.colVerifiedBy')}</Th><Th sortKey="plant" s={actSort}>{t('activity.colPlant')}</Th><th>{t('activity.colPic')}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((a) => {
                const href = recordHref(a, activityHere);
                return (
                <tr key={a.key} style={{ cursor: href ? 'pointer' : 'default' }} onClick={() => { if (href) navigate(href); }} title={href ? 'Open this record' : undefined}>
                  <td className="font-semibold">{a.equipment || '—'}</td>
                  <td className="text-slate-600">
                    {a.type}
                    {a.source === 'maintenance' && (
                      <span className="badge" style={{ marginLeft: 6, background: '#E0F2FE', color: '#0369A1', fontWeight: 700, fontSize: 10 }}>{t('activity.autoBadge')}</span>
                    )}
                  </td>
                  <td>
                    {a.ticketId ? (
                      <button
                        type="button"
                        className="num text-xs"
                        onClick={e => { e.stopPropagation(); const href = recordHref(a, activityHere); if (href) navigate(href); }}
                        style={{ color: '#2563EB', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, textDecoration: 'underline' }}
                      >
                        #{a.ticketRef}
                      </button>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="text-slate-500 text-xs">{fmtDate(a.date)}</td>
                  <td>{a.doneBy || '—'}</td>
                  <td className="text-slate-500">{a.verifiedBy || '—'}</td>
                  <td>{a.plant || '—'}</td>
                  <td><PicBadge photos={a.photos} onOpen={() => setLightbox(a.photos)} /></td>
                </tr>
                );
              })}
            </tbody>
          </table>
          <TablePagination controls={controls} />
        </div>
        )}
      </div>

      {/* Slide panel */}
      <SlidePanel open={open} onClose={handleClose} title={t('activity.panelTitle')} subtitle={t('activity.panelSubtitle')}>
        <PanelField label={t('activity.fieldEquipment')}>
          <PanelInput placeholder={t('activity.phEquipment')} value={form.equipment} onChange={e => set('equipment', e.target.value)} />
        </PanelField>

        <PanelRow>
          <PanelField label={t('activity.fieldActivityType')}>
            <PanelSelect value={form.type} onChange={e => set('type', e.target.value)}>
              <option value="Regular">{t('activity.typeRegular')}</option>
              <option value="Repair">{t('activity.typeRepair')}</option>
              <option value="Scrap">{t('activity.typeScrap')}</option>
              <option value="Inspection">{t('activity.typeInspection')}</option>
              <option value="Calibration">{t('activity.typeCalibration')}</option>
            </PanelSelect>
          </PanelField>
          <PanelField label={t('activity.fieldPlant')}>
            <PanelSelect value={form.plant} onChange={e => set('plant', e.target.value)}>
              {!form.plant && <option value="">{t('activity.selectPlant', 'Select factory…')}</option>}
              {plantOptions.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('activity.fieldDate')}>
            <PanelInput type="date" value={form.date} onChange={e => set('date', e.target.value)} />
          </PanelField>
          <PanelField label={t('activity.fieldDoneBy')}>
            <PanelInput placeholder={t('activity.phDoneBy')} value={form.doneBy} onChange={e => set('doneBy', e.target.value)} />
          </PanelField>
        </PanelRow>

        <PanelField label={t('activity.fieldVerifiedBy')}>
          <PanelInput placeholder={t('activity.phVerifiedBy')} value={form.verifiedBy} onChange={e => set('verifiedBy', e.target.value)} />
        </PanelField>

        <PanelField label={t('activity.fieldNotes')}>
          <PanelTextarea placeholder={t('activity.phNotes')} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </PanelField>

        <PanelDivider />

        <OcrUpload
          label={t('activity.ocrLabel')}
          hint={t('activity.ocrHint')}
          fields={[
            { key: 'equipment', label: t('activity.ocrFldEquipmentId', 'Equipment ID'),  value: 'Atlas Copco GA18 — SHD-AC-04' },
            { key: 'type',      label: t('activity.fieldActivityType'), value: 'Repair' },
            { key: 'notes',     label: t('activity.ocrFldWorkSummary', 'Work summary'),  value: 'Replaced V-belt drive + tightened coupling bolts' },
          ]}
          onExtracted={data => {
            if (data.equipment) set('equipment', data.equipment);
            if (data.type)      set('type',      data.type);
            if (data.notes)     set('notes',     data.notes);
          }}
        />

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('activity.saveLabel')}
          successLabel={t('activity.successLabel')}
          successSub={t('activity.successSub')}
          disabled={!form.equipment.trim() || !form.doneBy.trim()}
          requiredHint={t('activity.requiredHint')}
        />
      </SlidePanel>

      <ImageLightbox images={lightbox || []} open={!!lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}
