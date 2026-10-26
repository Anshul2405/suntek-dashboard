import React, { useState, useEffect, useMemo } from 'react';
import { patchUrlParams } from '../../../lib/urlParams';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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
import { useDirectory, extractMentionIds, truncate } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { useRoleContext } from '../../../contexts/RoleContext';
import { profileHasCapability, type RoleRow } from '../../../lib/profiles';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { withEmbedFallback } from '../../../lib/scopedList';
import { useNotifications } from '../../../contexts/NotificationsContext';
import type { Database } from '../../../lib/database.types';
import { ticketNoLabel } from '../../../lib/ticketNo';
import { DateRangeFilter, FilterBar, FilterSelect } from '../../../components/v2';
import { Building2, Factory, Layers, MapPin } from 'lucide-react';
import { formatDate, inIstDayRange } from '../../../lib/utils/formatting';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { displayLocationName } from '../../../lib/plantLabels';

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
  source: 'manual' | 'maintenance' | 'incident' | 'system';
  ticketId?: string | null;
  /** A deletion / reversal kept in the log: shaded and labelled, never hidden. */
  deleted?: boolean;
};

const MANUAL_TYPE_KEYS: Record<string, string> = {
  regular: 'activity.typeRegular', repair: 'activity.typeRepair', scrap: 'activity.typeScrap',
  inspection: 'activity.typeInspection', calibration: 'activity.typeCalibration',
};
/** activity_logs rows written by database functions (stock, repair, import),
 *  not by a person through + Log activity: never verified, labelled, and
 *  deletions/reversals marked. */
const SYSTEM_TYPE_KEYS: Record<string, [string, string]> = {
  stock_purchase: ['activity.sysStockPurchase', 'Stock purchase added'],
  stock_anomaly: ['activity.sysStockAnomaly', 'Stock anomaly resolved'],
  repair_return: ['activity.sysRepairReturn', 'Repaired part returned'],
  repair_return_reversed: ['activity.sysRepairReturnReversed', 'Repair return reversed (deleted)'],
  defective_disposition: ['activity.sysDefective', 'Defective part decided'],
  import_deleted: ['activity.sysImportDeleted', 'Upload deleted'],
};
const ticketRef = (tk: { id: string; ticket_no?: string | number | null }) => ticketNoLabel(tk);
/** Build a lightbox image list from [url, label] pairs, dropping empties. */
const photoList = (pairs: [string | null | undefined, string][]): LightboxImage[] =>
  pairs.filter(([u]) => !!u).map(([u, label]) => ({ url: u as string, label }));
const toMs = (ts: string | null | undefined) => (ts ? new Date(ts).getTime() : 0);
const fmtDate = (d: string | null | undefined) =>
  d ? formatDate(d) : '—';

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
      onClick={onOpen}
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
    const ref = ticketRef(tk);
    const plant = tk.plants?.name ?? null;

    // 1) Raised
    const raisePhotos = photoList([[tk.defective_raise_photo_url, t('activity.photoRaise', 'Raise photo')]]);
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
        const procPhotos = photoList([[sr.handover_invoice_url, t('activity.photoSupplierInvoice', 'Supplier invoice')]]);
        out.push({
          key: `${sr.id}:procured`, equipment: tk.equipment,
          type: `${t('activity.evtPartProcured', 'Part procured')} · ${sr.part_name}`, date: tk.closed_at || sr.created_at,
          doneBy: sr.supplier_name || t('activity.byProcurement', 'Procurement'), verifiedBy: null, plant,
          hasPhoto: procPhotos.length > 0, photos: procPhotos, ticketRef: ref, ticketId: tk.id, source: 'maintenance',
        });
      }
      if (sr.handover_confirmed_at) {
        const hoPhotos = photoList([[sr.handover_photo_url, t('activity.photoHandover', 'Handover photo')], [sr.handover_invoice_url, t('activity.photoHandoverInvoice', 'Handover invoice')]]);
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
      const defPhotos = photoList([[tk.defective_part_photo_url, t('activity.photoDefectivePart', 'Defective part')]]);
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
      const donePhotos = photoList([[tk.completion_photo_url, t('activity.photoCompletion', 'Completion photo')], [tk.defective_part_photo_url, t('activity.photoDefectivePart', 'Defective part')]]);
      out.push({
        key: `${tk.id}:done`, equipment: tk.equipment,
        type: tk.type === 'emergency' ? t('activity.evtRepairCompleted', 'Repair completed') : t('activity.evtPeriodicCheckCompleted', 'Periodic check completed'),
        date: tk.closed_at || tk.created_at, doneBy: tk.assigned_to || null,
        verifiedBy: null,
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
  const navigate = useNavigate();
  const location = useLocation();
  // The entry just saved through + Log activity: pinned to the top and
  // highlighted until the page is left (its date may sort it lower otherwise).
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const people = useDirectory();
  const { activeProfile } = useRoleContext();
  const { scopeQuery, allowedPlants, ready: scopeReady, locations, allowedUnits } = usePlantScope();
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
  const [showManualOnly, setShowManualOnly] = useState(searchParams.get('manual') === '1');
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  const search = searchParams.get('q') || '';
  const plantFilter = searchParams.get('plant') || '';
  const kpi = (searchParams.get('kpi') as 'all' | 'verified' | 'pending' | 'photo' | 'maint') || 'all';
  const fromDate = searchParams.get('from') || '';
  const toDate = searchParams.get('to') || '';
  const srcFilter = searchParams.get('src') || '';
  const stateFilter = searchParams.get('state') || '';
  const unitFilter = searchParams.get('unit') || '';
  function patchParams(patch: Record<string, string>) {
    patchUrlParams(setSearchParams, patch);
  }
  const setSearch = (v: string) => patchParams({ q: v });
  const setPlantFilter = (v: string) => patchParams({ plant: v });
  const setKpi = (v: 'all' | 'verified' | 'pending' | 'photo' | 'maint') => patchParams({ kpi: v === 'all' ? '' : v });
  const setFromTo = (from: string, to: string) => patchParams({ from, to });
  const [incidents, setIncidents] = useState<{ id: string; what_text: string; who_text: string | null; occurred_at: string; reported_by: string | null; plants?: { name: string } | null }[]>([]);
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({ equipment: '', type: 'Regular', date: today, doneBy: '', verifiedBy: '', plant: '', notes: '' });

  async function load() {
    try {
      const { data: plantsData } = await fetchActivePlants<{ id: string; name: string }>('id, name');
      if (plantsData && plantsData.length > 0) setDbPlants(plantsData);

      const [logsRes, ticketsRes] = await Promise.all([
        withEmbedFallback(
          scopeQuery(supabase.from('activity_logs').select('*, plants(name)')).order('date', { ascending: false }).returns<ActivityRow[]>(),
          () => scopeQuery(supabase.from('activity_logs').select('*')).order('date', { ascending: false }).returns<ActivityRow[]>(),
          'ActivityLog.logs',
        ),
        withEmbedFallback(
          scopeQuery(supabase.from('maintenance_tickets').select('*, plants(name)'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<TicketRow[]>(),
          () => scopeQuery(supabase.from('maintenance_tickets').select('*'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<TicketRow[]>(),
          'ActivityLog.tickets',
        ),
      ]);
      if (logsRes.error) throw logsRes.error;
      setLogs(logsRes.data || []);

      const tks = ticketsRes.data || [];
      setTickets(tks);
      const ids = tks.map(x => x.id);
      if (ids.length) {
        const { data: srData } = await supabase.from('maintenance_store_requests').select('*').in('ticket_id', ids).returns<StoreReqRow[]>();
        setStoreReqs(srData || []);
      } else {
        setStoreReqs([]);
      }
      try {
        const db = supabase as unknown as { from: (table: string) => any };
        const { data: incidentRows } = await scopeQuery(db.from('incident_reports').select('id, what_text, who_text, occurred_at, reported_by, plants(name)')).order('occurred_at', { ascending: false });
        setIncidents(incidentRows || []);
      } catch { setIncidents([]); }
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
    const manual: UnifiedRow[] = logs.map((a, i) => {
      const kind = (a.type || '').toLowerCase();
      const sys = SYSTEM_TYPE_KEYS[kind];
      return {
      key: a.id || `manual-${i}`,
      equipment: a.equipment || '—',
      // Saved lower-case ('regular'); show the same label the form offers.
      type: sys ? t(sys[0], sys[1]) : MANUAL_TYPE_KEYS[kind] ? t(MANUAL_TYPE_KEYS[kind]) : a.type,
      date: a.date,
      doneBy: a.done_by,
      verifiedBy: sys ? null : a.verified_by,
      plant: a.plants?.name ?? null,
      hasPhoto: !!a.photo_url,
      photos: a.photo_url ? [{ url: a.photo_url, label: t('activity.photoActivity', 'Activity photo') }] : [],
      ticketRef: null,
      ticketId: null,
      source: sys ? 'system' as const : 'manual' as const,
      deleted: kind === 'import_deleted' || kind === 'repair_return_reversed' || /delet/.test(kind),
      };
    });
    const derived = deriveMaintenanceEvents(tickets, storeReqs, t);
    const incidentRows: UnifiedRow[] = incidents.map((r) => ({
      key: `incident-${r.id}`,
      equipment: r.what_text || 'Incident',
      type: 'Incident report',
      date: r.occurred_at,
      doneBy: r.reported_by,
      verifiedBy: null, // incidents are not verified; who_text is who was involved
      plant: r.plants?.name ?? null,
      hasPhoto: false,
      photos: [],
      ticketRef: null,
      ticketId: null,
      source: 'incident',
    }));
    const all = showManualOnly ? manual : [...manual, ...derived, ...incidentRows];
    return all.sort((a, b) => {
      if (a.source === 'manual' && b.source !== 'manual') return -1;
      if (b.source === 'manual' && a.source !== 'manual') return 1;
      return toMs(b.date) - toMs(a.date);
    });
  }, [logs, tickets, storeReqs, incidents, showManualOnly, t]);

  const fromMaintenance = rows.filter(r => r.source === 'maintenance').length;
  const verified = rows.filter(r => r.source === 'manual' && r.verifiedBy).length;
  const pendingVerify = rows.filter(r => r.source === 'manual' && !r.verifiedBy).length;
  const withPhoto = rows.length ? Math.round((rows.filter(r => r.hasPhoto).length / rows.length) * 100) : 0;

  // Factory names come from the DB only — a hard-coded fallback would keep
  // offering names that no longer exist after a rename. The filter compares
  // display names on both sides (rows carry the same live join), so it stays
  // consistent; the entry form below keys off the plant ID.
  const plantOptions = useMemo(
    () => [...plantsForPicker(allowedPlants, scopeReady)].sort((a, b) => a.name.localeCompare(b.name)),
    [allowedPlants, scopeReady],
  );
  const plantNames = plantOptions.map(p => p.name);
  // State and unit come from the granted plants, so the filters never offer a
  // place the user cannot see. Each is shown only when there is a choice.
  const stateOfPlant = useMemo(() => {
    const byLoc = new Map(locations.map(l => [l.id, l.state] as const));
    return new Map(plantOptions.map(p => [p.name, (p.location_id && byLoc.get(p.location_id)) || ''] as const));
  }, [locations, plantOptions]);
  const stateOptions = [...new Set([...stateOfPlant.values()].filter(Boolean))].sort();
  const unitOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of plantOptions) for (const u of allowedUnits(p.id)) if (!seen.has(u.name)) seen.set(u.name, u.name);
    return [...seen.keys()].sort();
  }, [plantOptions, allowedUnits]);
  const unitByTicket = useMemo(() => {
    const unitName = new Map<string, string>();
    for (const p of plantOptions) for (const u of allowedUnits(p.id)) unitName.set(u.id, u.name);
    return new Map(tickets.map(tk => [tk.id, (tk.unit_id && unitName.get(tk.unit_id)) || ''] as const));
  }, [tickets, plantOptions, allowedUnits]);

  // Search + plant filter, then paginate — Activity Log grows unbounded over time.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!plantFilter || r.plant === plantFilter) &&
      (!srcFilter || r.source === srcFilter) &&
      (!stateFilter || stateOfPlant.get(r.plant || '') === stateFilter) &&
      (!unitFilter || (!!r.ticketId && unitByTicket.get(r.ticketId) === unitFilter)) &&
      inIstDayRange(r.date, fromDate, toDate) &&
      (kpi === 'all'
        || (kpi === 'verified' && r.source === 'manual' && !!r.verifiedBy)
        || (kpi === 'pending' && r.source === 'manual' && !r.verifiedBy)
        || (kpi === 'photo' && r.hasPhoto)
        || (kpi === 'maint' && r.source === 'maintenance')) &&
      (!q || [r.equipment, r.type, r.doneBy, r.verifiedBy, r.plant, r.ticketRef].some(f => (f || '').toLowerCase().includes(q))),
    );
  }, [rows, search, plantFilter, fromDate, toDate, kpi, srcFilter, stateFilter, unitFilter, stateOfPlant, unitByTicket]);
  const actSort = useSortable(filtered, {
    equipment: r => r.equipment,
    activity: r => r.type,
    ticket: r => r.ticketRef,
    date: r => new Date(r.date),
    doneBy: r => r.doneBy,
    verifiedBy: r => r.verifiedBy,
    plant: r => r.plant,
  }, {
    // Sort survives Back/Cancel through the URL (?sort=&dir=).
    key: searchParams.get('sort') || 'date',
    dir: searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
  });
  useEffect(() => {
    const key = actSort.sort.key && !(actSort.sort.key === 'date' && actSort.sort.dir === 'desc') ? actSort.sort.key : '';
    const dir = key ? actSort.sort.dir : '';
    if ((searchParams.get('sort') || '') !== key || (searchParams.get('dir') || '') !== dir) patchParams({ sort: key, dir });
  }, [actSort.sort.key, actSort.sort.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const ordered = useMemo(() => {
    if (!justAdded) return actSort.sorted;
    const key = justAdded;
    const pinned = actSort.sorted.filter(r => r.key === key);
    return pinned.length ? [...pinned, ...actSort.sorted.filter(r => r.key !== key)] : actSort.sorted;
  }, [actSort.sorted, justAdded]);
  const { pageRows, controls } = usePagination(ordered, {
    resetKey: `${search}|${plantFilter}|${showManualOnly}|${srcFilter}|${stateFilter}|${unitFilter}|${fromDate}|${toDate}|${kpi}|${actSort.sort.key}|${actSort.sort.dir}|${justAdded}`,
    // Page and page size survive Back/Cancel through the URL (?p=&ps=).
    initialPage: Number(searchParams.get('p')) || 1,
    initialPageSize: Number(searchParams.get('ps')) || 10,
    onChange: (page, size) => {
      const p = page > 1 ? String(page) : '';
      const ps = size !== 10 ? String(size) : '';
      if ((searchParams.get('p') || '') !== p || (searchParams.get('ps') || '') !== ps) patchParams({ p, ps });
    },
  });

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    if (!form.equipment.trim() || !form.doneBy.trim()) return;
    const plant = plantOptions.find(p => p.id === form.plant) || allowedPlants.find(p => p.id === form.plant);
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
    if (data) {
      setLogs(prev => [data as ActivityRow, ...prev]);
      if ((data as ActivityRow).id) setJustAdded((data as ActivityRow).id);
    }

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
      <div className="flex justify-end mb-3">
        <button className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm" onClick={() => setOpen(true)}>
          + {t('activity.logActivityBtn')}
        </button>
      </div>
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-5 mb-5">
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'All activity events', what: 'Every activity across all plants — manual log entries PLUS milestones auto-fed from the maintenance workflow (raised, procured, handed over, completed, defective decided). The single overall record.', source: 'Derived', note: 'Manual activity_logs + maintenance_tickets / maintenance_store_requests milestones.' }} />
          <button type="button" className="text-left w-full" onClick={() => setKpi('all')}>
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiTotal')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{loading ? '…' : rows.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">{loading ? '\u00a0' : t('activity.kpiFromMaintenance', { count: fromMaintenance })}</div>
          </button>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Verified', what: 'Activity events that carry a verifier (supervisor / unit head sign-off, or the raising role on a completed maintenance ticket).', source: 'Derived' }} />
          <button type="button" className="text-left w-full" onClick={() => setKpi(kpi === 'verified' ? 'all' : 'verified')}>
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiVerified')}</div>
          <div className="text-[28px] font-extrabold mt-1 num text-green-600">{loading ? '…' : verified}</div>
          </button>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Pending verification', what: 'Events with no verifier yet. These need supervisor sign-off.', source: 'Derived' }} />
          <button type="button" className="text-left w-full" onClick={() => setKpi(kpi === 'pending' ? 'all' : 'pending')}>
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiPending')}</div>
          <div className="text-[28px] font-extrabold mt-1 num text-amber-600">{loading ? '…' : pendingVerify}</div>
          </button>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Photo proof coverage', what: 'Percentage of activity events that carry photo proof — manual uploads plus the completion / handover / defective-part photos captured through the maintenance workflow.', source: 'Derived' }} />
          <button type="button" className="text-left w-full" onClick={() => setKpi(kpi === 'photo' ? 'all' : 'photo')}>
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('activity.kpiPhotoProof')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{loading ? '…' : `${withPhoto}%`}</div>
          </button>
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
              className="pill px-3 py-2 text-xs font-semibold btn-ghost"
              style={{ border: '1px solid #E2E8F0', background: '#fff', color: '#475569' }}
              onClick={() => setShowManualOnly(v => !v)}
              title={t('activity.toggleFeedTitle')}
            >
              {showManualOnly ? t('activity.showMaintenanceFeed') : t('activity.manualOnly')}
            </button>
          </div>
        </div>
        {/* Same filter bar as Maintenance / Incidents (search · selects · IST
            date range · Reset); every value lives in the URL. */}
        <FilterBar
          className="mb-3 !p-0 !border-0 !shadow-none !bg-transparent"
          search={search}
          onSearch={setSearch}
          searchPlaceholder={t('activity.searchPh', 'Search equipment, activity, person, ticket…')}
          onReset={() => patchParams({ q: '', plant: '', src: '', state: '', unit: '', from: '', to: '', kpi: '', p: '' })}
        >
          <FilterSelect
            icon={<Building2 />}
            value={plantFilter || 'all'}
            onChange={v => setPlantFilter(v === 'all' ? '' : v)}
            options={[{ value: 'all', label: t('activity.allPlants', 'All plants') }, ...plantNames.map(p => ({ value: p, label: displayLocationName(p) }))]}
          />
          <FilterSelect
            icon={<Layers />}
            value={srcFilter || 'all'}
            onChange={v => patchParams({ src: v === 'all' ? '' : v })}
            options={[
              { value: 'all', label: t('activity.allModules', 'All modules') },
              { value: 'manual', label: t('activity.srcManual', 'Manual log') },
              { value: 'maintenance', label: t('activity.srcMaint', 'Maintenance') },
              { value: 'incident', label: t('activity.srcIncident', 'Incidents') },
              { value: 'system', label: t('activity.srcSystem', 'Store & system') },
            ]}
          />
          {stateOptions.length > 1 && (
            <FilterSelect
              icon={<MapPin />}
              value={stateFilter || 'all'}
              onChange={v => patchParams({ state: v === 'all' ? '' : v })}
              options={[{ value: 'all', label: t('activity.allStates', 'All states') }, ...stateOptions.map(st => ({ value: st, label: st }))]}
            />
          )}
          {unitOptions.length > 0 && (
            <FilterSelect
              icon={<Factory />}
              value={unitFilter || 'all'}
              onChange={v => patchParams({ unit: v === 'all' ? '' : v })}
              options={[{ value: 'all', label: t('activity.allUnits', 'All units') }, ...unitOptions.map(u => ({ value: u, label: u }))]}
            />
          )}
          <DateRangeFilter from={fromDate} to={toDate} onChange={({ from, to }) => setFromTo(from, to)} />
        </FilterBar>
        {loadError ? (
          <ErrorState title={t('activity.errorTitle')} message={t('activity.errorMessage')}
            onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
        ) : loading ? (
          <SkeletonRows rows={6} />
        ) : filtered.length === 0 ? (
          <EmptyState title={t('activity.emptyState')} message={search || plantFilter || srcFilter || stateFilter || unitFilter || fromDate || toDate || kpi !== 'all' ? t('activity.noMatches', 'No rows match your filters.') : undefined} />
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
              {pageRows.map((a) => (
                <tr key={a.key} style={{ cursor: (a.ticketId || a.source === 'incident' || a.photos.length) ? 'pointer' : 'default', background: a.key === justAdded ? '#FFF7ED' : a.deleted || /delet/i.test(a.equipment) ? '#FEF2F2' : undefined, boxShadow: a.key === justAdded ? 'inset 3px 0 0 #EA580C' : undefined }} onClick={() => {
                  const back = encodeURIComponent(location.pathname + location.search);
                  if (a.source === 'maintenance' && a.ticketId) navigate(`/dashboard/purchase/maint?ticket=${a.ticketId}&back=${back}`);
                  else if (a.source === 'incident') navigate(`/dashboard/purchase/maint?tab=incidents&incident=${a.key.replace('incident-', '')}&back=${back}`);
                  else if (a.photos.length) setLightbox(a.photos);
                }} title={a.ticketId ? t('activity.openTicket', 'Open ticket') : undefined}>
                  <td className="font-semibold">{a.equipment || '—'}</td>
                  <td className="text-slate-600">
                    {a.type}
                    {a.deleted && (
                      <span className="badge" style={{ marginLeft: 6, background: '#FEE2E2', color: '#B91C1C', fontWeight: 700, fontSize: 10 }}>{t('activity.deletedBadge', 'Deleted')}</span>
                    )}
                    {(a.source === 'maintenance' || a.source === 'system') && (
                      <span className="badge" style={{ marginLeft: 6, background: '#E0F2FE', color: '#0369A1', fontWeight: 700, fontSize: 10 }}>{t('activity.autoBadge')}</span>
                    )}
                  </td>
                  <td>{a.ticketRef ? <span className="num text-xs text-slate-500">#{a.ticketRef}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="text-slate-500 text-xs">{fmtDate(a.date)}</td>
                  <td>{a.doneBy || '—'}</td>
                  <td className="text-slate-500">{a.verifiedBy || '—'}</td>
                  <td>{displayLocationName(a.plant) || '—'}</td>
                  <td><PicBadge photos={a.photos} onOpen={() => setLightbox(a.photos)} /></td>
                </tr>
              ))}
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
