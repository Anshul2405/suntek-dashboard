import React, { useState, useEffect } from 'react';
import { displayLocationName, locationInPlants } from '../../lib/plantLabels';
import { VoiceSearch } from '../../components/search/VoiceSearch';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Wrench, AlertTriangle, AlertCircle, Mic,
  CheckSquare, ShoppingCart, Truck, FlaskConical, Boxes, ArrowRight, Package,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useRoleContext } from '../../contexts/RoleContext';
import { STORE_REQ_WAITING, STORE_REQ_QUEUE_ROUTE, STORE_REQ_SCOPE, isMyApproval, canDecideStoreReq, waitingCountsAsMyQueue } from '../../lib/store/requisitionQueue';
import { isAdminProfile } from '../../lib/profiles';
import { reqNoLabel } from '../../lib/ticketNo';
import { formatDateTime } from '../../lib/utils/formatting';
import type { Database } from '../../lib/database.types';

type AlertRow = Database['public']['Tables']['alerts']['Row'];
type TankRow = Database['public']['Tables']['tanks']['Row'];
type DrumRow = Database['public']['Tables']['cpm_drum_stock']['Row'];
type ReqRow = Database['public']['Tables']['store_requisitions']['Row'] & { plants?: { name: string | null } | null };
import {
  useOverviewKPIs, useTopCustomers, useRecentMovements, useAnalyticsKPIs, fmtINR,
} from '../../hooks/useBusyData';
import { DSOGauge, RingProgress, MiniBarChart, BulletCompare, DeltaBadge, OverdueAgingBar } from '../../components/charts/AnalyticsViz';
import { KpiInfoButton } from '../../components/KpiInfoButton';
import { StockSnapshot } from '../../components/overview/StockSnapshot';
import { ButtonV2, SectionCard, StatusPill } from '../../components/v2';

/** Fallback source→route map for older alert rows without an explicit `route`. */
const ALERT_ROUTE: Record<string, string> = {
  'Marine ledger':     '/dashboard/purchase/marine',
  'CPM Stock':         '/dashboard/stock',
  'Batch · Oil Ratio': '/dashboard/batches',
  'Sales · Payments':  '/dashboard/sales',
  'Night Manager':     '/dashboard/night-manager',
  'Maintenance':       '/dashboard/purchase/maint',
};

/** Map movement type → dashboard route */
const MOVE_ROUTE: Record<string, string> = {
  batch:    '/dashboard/batches',
  sales:    '/dashboard/sales',
  purchase: '/dashboard/purchase/purchase',
  maint:    '/dashboard/purchase/maint',
  stock:    '/dashboard/stock',
};

/** Small section label — plant ops board (no SaaS numbering). */
function OpsHead({
  title,
  sub,
  right,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="ops-head">
      <div>
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function toneForCount(n: number | null, hotAt = 1): 'ok' | 'warn' | 'hot' | 'neutral' {
  if (n == null) return 'neutral';
  if (n <= 0) return 'ok';
  if (n >= hotAt * 3) return 'hot';
  return 'warn';
}

/** One "Business KPIs" column: gray label, big value, colored delta line. */
function KpiBlock({ label, value, delta, deltaTone = 'slate', info }: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: 'green' | 'red' | 'orange' | 'slate';
  info?: React.ComponentProps<typeof KpiInfoButton>['info'];
}) {
  const toneCls = { green: 'text-green-600', red: 'text-red-600', orange: 'text-orange-600', slate: 'text-slate-400' }[deltaTone];
  return (
    <div className="ops-kpi-cell">
      {info && <KpiInfoButton info={info} style={{ top: 8, right: 8 }} />}
      <div className="ops-kpi-label">{label}</div>
      <div className="ops-kpi-val">{value}</div>
      {delta && <div className={`ops-kpi-delta ${toneCls}`}>{delta}</div>}
    </div>
  );
}

const AGE = (ts: string | null, t: TFunction) => {
  if (!ts) return '';
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return t('time.justNow', 'just now');
  if (m < 60) return t('time.minutesAgo', { count: m, defaultValue: '{{count}}m ago' });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hoursAgo', { count: h, defaultValue: '{{count}}h ago' });
  return t('time.daysAgo', { count: Math.floor(h / 24), defaultValue: '{{count}}d ago' });
};

const fmtDT = (d: string | null) => formatDateTime(d);

export function Overview() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [moveFilter, setMoveFilter] = useState('all');
  const [moveSearch, setMoveSearch] = useState('');
  const [alertsExpanded, setAlertsExpanded] = useState(false);

  // Live BUSY DB data
  const { data: kpis } = useOverviewKPIs();
  const { data: topCustomers } = useTopCustomers(3);
  const { data: busyMovements } = useRecentMovements(3);
  const { data: analytics } = useAnalyticsKPIs();

  // Supabase snapshot data
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  const [tanks, setTanks] = useState<TankRow[]>([]);
  const [drumRows, setDrumRows] = useState<DrumRow[]>([]);
  const [pendingReqs, setPendingReqs] = useState<ReqRow[]>([]);
  const [pendingStoreReq, setPendingStoreReq] = useState<number | null>(null);
  const [openMaint, setOpenMaint] = useState<number | null>(null);
  const [activeBatchCount, setActiveBatchCount] = useState<number | null>(null);
  const [avgBatchHours, setAvgBatchHours] = useState<number | null>(null);

  // Pending approvals: SAME waiting set + SAME plant scope as Store Req's
  // ?queue=pending view, and a real count (the old count was the length of an
  // 8-row page of 'pending' only — capped at 8 and blind to the other stages).
  const { scopeQuery, ready: scopeReady, allowedPlants, isGlobal } = usePlantScope();
  const { activeProfile } = useRoleContext();
  const [approvalView, setApprovalView] = useState<'mine' | 'all'>('all');
  const isAdmin = isAdminProfile(activeProfile);
  useEffect(() => { if (isAdmin) setApprovalView('all'); }, [isAdmin]);
  const canDecide = canDecideStoreReq(activeProfile, isAdmin);
  const waitingIsMine = waitingCountsAsMyQueue(activeProfile, isAdmin);
  const shownPending = approvalView === 'mine'
    ? pendingReqs.filter(r => isMyApproval(r, { name: activeProfile.name, canDecide, waitingIsMine }))
    : pendingReqs;
  useEffect(() => {
    if (!scopeReady) return;
    let alive = true;
    (async () => {
      const [listRes, countRes] = await Promise.all([
        scopeQuery(supabase.from('store_requisitions').select('*, plants(name)'), STORE_REQ_SCOPE)
          .in('status', [...STORE_REQ_WAITING]).order('created_at', { ascending: false }).limit(8).returns<ReqRow[]>(),
        scopeQuery(supabase.from('store_requisitions').select('id', { count: 'exact', head: true }), STORE_REQ_SCOPE)
          .in('status', [...STORE_REQ_WAITING]),
      ]);
      if (!alive) return;
      setPendingReqs(listRes.data || []);
      setPendingStoreReq(countRes.error ? (listRes.error ? null : (listRes.data?.length ?? 0)) : (countRes.count ?? 0));
    })();
    return () => { alive = false; };
  }, [scopeQuery, scopeReady]);

  useEffect(() => {
    (async () => {
      const [alertsRes, tanksRes, drumsRes, maintRes, batchesRes] = await Promise.all([
        supabase.from('alerts').select('*').eq('is_resolved', false).order('created_at', { ascending: false }).returns<AlertRow[]>(),
        supabase.from('tanks').select('*').order('sort_order', { ascending: true }).returns<TankRow[]>(),
        supabase.from('cpm_drum_stock').select('*').returns<DrumRow[]>(),
        supabase.from('maintenance_tickets').select('*', { count: 'exact', head: true }).eq('type', 'emergency').neq('status', 'closed'),
        supabase.from('active_batches').select('started_at').eq('status', 'active').returns<{ started_at: string }[]>(),
      ]);
      setAlerts(alertsRes.data || []);
      setAlertsLoaded(true);
      setTanks(tanksRes.data || []);
      setDrumRows(drumsRes.data || []);
      setOpenMaint(maintRes.error ? null : (maintRes.count ?? 0));

      const batches = batchesRes.data || [];
      setActiveBatchCount(batchesRes.error ? null : batches.length);
      if (batches.length > 0) {
        const avgMs = batches.reduce((sum, b) => sum + (Date.now() - new Date(b.started_at).getTime()), 0) / batches.length;
        setAvgBatchHours(Math.max(0, Math.round(avgMs / 3_600_000)));
      } else {
        setAvgBatchHours(null);
      }
    })();
  }, []);

  // Tanks and drum stock carry a location name, not a plant id: a plant-scoped
  // user only sees the locations of their own plants (none for Madan).
  const scopedDrums = isGlobal ? drumRows : drumRows.filter(r => locationInPlants(r.location, allowedPlants));
  const scopedTanks = isGlobal ? tanks : tanks.filter(tk => locationInPlants(tk.location, allowedPlants));
  // Pivot drum rows into the density×location matrix (same shape as CPMStock).
  const densities = [...new Set(scopedDrums.map(r => r.density))].sort((a, b) => a - b);
  const locations = [...new Set(scopedDrums.map(r => r.location))];
  const drumLookup = new Map(scopedDrums.map(r => [`${r.location}|${r.density}`, r.drums]));
  const matrix: Record<string, number[]> = Object.fromEntries(
    locations.map(loc => [loc, densities.map(d => drumLookup.get(`${loc}|${d}`) ?? 0)]),
  );

  // Movements feed
  const movementsSource = busyMovements && busyMovements.length > 0 ? busyMovements : [];
  const filteredMoves = movementsSource
    .filter(m => moveFilter === 'all' || m.type === moveFilter)
    .filter(m => (m.title + m.sub).toLowerCase().includes(moveSearch.toLowerCase()));

  const displayCustomers = topCustomers && topCustomers.length > 0
    ? topCustomers.map(c => ({ name: c.name, mtdVal: fmtINR(c.mtdRevenue).replace('₹ ', '') }))
    : [{ name: '—', mtdVal: '—' }];

  const shownAlerts = alertsExpanded ? alerts : alerts.slice(0, 5);

  const QUICK_ACTIONS = [
    { icon: <CheckSquare />,  label: t('overview.qaApprove', 'Approve Requests'),   to: '/dashboard/purchase/storereq' },
    { icon: <ShoppingCart />, label: t('overview.qaPO', 'Purchase Orders'),         to: '/dashboard/purchase/purchase' },
    { icon: <Wrench />,       label: t('overview.qaMaint', 'Raise Maintenance'),    to: '/dashboard/purchase/maint' },
    { icon: <FlaskConical />, label: t('overview.qaBatch', 'Record Production'),    to: '/dashboard/batches' },
    { icon: <Truck />,        label: t('overview.qaSales', 'Sales & Dispatch'),     to: '/dashboard/sales' },
    { icon: <Boxes />,        label: t('overview.qaStock', 'View Stock'),           to: '/dashboard/stock' },
  ];

  return (
    <div className="ops-board">
      {/* ── Today's Work (full width) + alerts only when needed ── */}
      <div>
        <OpsHead
          title={t('overview.todaysWork', "Today's Work")}
          sub={t('overview.todaysWorkSub', 'What needs a decision on the floor right now')}
        />
        <div className="ops-shift">
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={toneForCount(pendingStoreReq)}
            onClick={() => navigate(STORE_REQ_QUEUE_ROUTE)}
          >
            <div className="ops-shift-label">{t('overview.pendingApprovals', 'Pending Approvals')}</div>
            <div className="ops-shift-val">{pendingStoreReq ?? '…'}</div>
            <div className="ops-shift-cap">
              {pendingStoreReq == null ? '\u00a0' : pendingStoreReq ? t('overview.requiresAction', 'Requires your action →') : t('overview.allClear', 'All clear')}
            </div>
          </button>
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={toneForCount(openMaint)}
            onClick={() => navigate('/dashboard/purchase/maint')}
          >
            <div className="ops-shift-label">{t('overview.openMaintenance', 'Open Maintenance')}</div>
            <div className="ops-shift-val">{openMaint ?? '…'}</div>
            <div className="ops-shift-cap">
              {openMaint == null ? '\u00a0' : openMaint ? t('overview.ticketsInProgress', 'Tickets in progress') : t('overview.noOpenTickets', 'No open tickets')}
            </div>
          </button>
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={activeBatchCount && activeBatchCount > 0 ? 'warn' : 'ok'}
            onClick={() => navigate('/dashboard/batches')}
          >
            <div className="ops-shift-label">{t('overview.activeBatches', 'Active Batches')}</div>
            <div className="ops-shift-val">{activeBatchCount ?? '…'}</div>
            <div className="ops-shift-cap">
              {avgBatchHours != null
                ? t('overview.avgElapsed', { hours: avgBatchHours, defaultValue: 'avg {{hours}}h elapsed' })
                : t('overview.acrossFactories', { count: allowedPlants.length })}
            </div>
          </button>
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={toneForCount(alerts.length)}
            disabled={alerts.length === 0}
            style={alerts.length === 0 ? { cursor: 'default' } : undefined}
            onClick={() => {
              if (alerts.length === 0) return;
              document.getElementById('ov-alerts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            <div className="ops-shift-label">{t('overview.openAlerts', 'Open Alerts')}</div>
            <div className="ops-shift-val">{alertsLoaded ? alerts.length : '…'}</div>
            <div className="ops-shift-cap">
              {!alertsLoaded ? '\u00a0' : alerts.length ? t('overview.acrossModules', 'Across all modules') : t('overview.allQuiet', 'All quiet')}
            </div>
          </button>
        </div>

        {alerts.length === 0 ? (
          <div className="ops-alert-banner" id="ov-alerts">
            <span className="ops-alert-clear-dot" aria-hidden />
            <div>
              <strong>{t('overview.noOpenAlerts', 'No open alerts')}</strong>
              <span>{t('overview.plantQuietShort', 'All plants clear — new flags appear here.')}</span>
            </div>
          </div>
        ) : (
          <div id="ov-alerts" className="ops-alert-panel mt-3">
            <OpsHead
              title={t('overview.criticalAlerts', 'Critical Alerts')}
              sub={t('overview.criticalAlertsSub', 'Plant stoppers & risk flags')}
              right={alerts.length > 5 ? (
                <button
                  type="button"
                  className="ops-link"
                  onClick={() => setAlertsExpanded(e => !e)}
                >
                  {alertsExpanded ? t('overview.showLess', 'Show less') : t('common.viewAll', 'View all')}
                </button>
              ) : undefined}
            />
            <div>
              {shownAlerts.map(a => {
                const route = a.route || ALERT_ROUTE[a.source || ''];
                const sev = a.severity === 'red' ? 'red' : a.severity === 'amber' ? 'amber' : 'slate';
                return (
                  <div
                    key={a.id}
                    className="ops-alert-row"
                    onClick={() => route && navigate(route)}
                    role={route ? 'link' : undefined}
                  >
                    <span className={`w-6 h-6 rounded-md inline-flex items-center justify-center shrink-0 mt-0.5 ${sev === 'red' ? 'bg-red-50 text-red-600' : sev === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                      {sev === 'red' ? <AlertTriangle size={12} /> : <AlertCircle size={12} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-slate-800 leading-snug">{a.text}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{a.source}</div>
                    </div>
                    <span className="text-[11px] text-slate-400 shrink-0">{a.when_label || AGE(a.created_at, t)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Tool rail ── */}
      <div>
        <OpsHead
          title={t('overview.quickActions', 'Quick Actions')}
          sub={t('overview.quickActionsSub', 'Jump straight into the floor workflows')}
          right={
            <button
              type="button"
              className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:border-orange-300 hover:bg-orange-50 inline-flex items-center justify-center text-slate-500 cursor-pointer"
              onClick={() => setVoiceOpen(true)}
              aria-label={t('voice.heading')}
              title={t('voice.heading')}
            >
              <Mic size={14} />
            </button>
          }
        />
        <div className="ops-tools">
          {QUICK_ACTIONS.map(a => (
            <button key={a.label} type="button" className="ops-tool" onClick={() => navigate(a.to)}>
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Business KPIs ── */}
      <div>
        <OpsHead
          title={t('overview.businessKpis', 'Business KPIs')}
          sub={t('overview.businessKpisSub', 'BUSY ledger pulse — MTD & FY')}
        />
        <div className="ops-kpi-rail">
          <KpiBlock
            label={t('overview.totalSalesMtd', 'Total Sales (MTD)')}
            value={kpis ? fmtINR(kpis.salesMTD) : '…'}
            delta={analytics ? `${analytics.momRevGrowthPct >= 0 ? '+' : ''}${analytics.momRevGrowthPct}% ${t('overview.vsLastMonth', 'vs last month')}` : undefined}
            deltaTone={analytics && analytics.momRevGrowthPct >= 0 ? 'green' : 'red'}
            info={{ title: 'Sales MTD', what: 'Total sales invoiced to customers in the current calendar month. Counts only non-cancelled sales vouchers.', source: 'BUSY DB', tables: ['Tran1'], filter: 'VchType=9, Cancelled=0, current month' }}
          />
          <KpiBlock
            label={t('overview.fyRevenue', 'FY Revenue')}
            value={kpis ? fmtINR(kpis.fyRevenue) : '…'}
            delta={kpis ? t('overview.invoicesFy', { count: kpis.salesInvoiceCount }) : undefined}
          />
          <KpiBlock
            label={t('overview.purchasePaidMtd', 'Purchase Paid (MTD)')}
            value={kpis ? fmtINR(kpis.purchaseMTD) : '…'}
            delta={t('overview.inclMarineIns', 'incl. marine insurance')}
            info={{ title: 'Purchase MTD', what: 'Total purchase amount paid to suppliers in the current month, all plants consolidated.', source: 'BUSY DB', tables: ['Tran1'], filter: 'VchType=14, Cancelled=0, current month' }}
          />
          <KpiBlock
            label={t('overview.debtorsOutstanding', 'Debtors Outstanding')}
            value={kpis ? fmtINR(kpis.debtorsOutstanding) : '…'}
            delta={analytics ? `DSO ${analytics.dso}d` : undefined}
            deltaTone={analytics && analytics.dso > 30 ? 'orange' : 'green'}
          />
          <KpiBlock
            label={t('overview.pendingApprovals', 'Pending Approvals')}
            value={pendingStoreReq ?? '…'}
            delta={pendingStoreReq == null ? '' : pendingStoreReq ? t('overview.requiresActionShort', 'Requires action') : t('overview.noChange', '— No change')}
            deltaTone={pendingStoreReq ? 'orange' : 'slate'}
          />
        </div>
      </div>

      {/* ── Pending Approvals table ── */}
      <SectionCard className="!rounded-[14px]" flush>
        <div className="px-5 pt-5 pb-1">
          <OpsHead
            title={t('overview.pendingApprovals', 'Pending Approvals')}
            sub={t('overview.pendingApprovalsSub', 'Store requisitions waiting on Unit Head / Admin')}
            right={
              <div className="flex items-center gap-2">
                {!isAdmin ? (
                <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
                  <button type="button" onClick={() => setApprovalView('mine')} style={{ padding: '6px 10px', background: approvalView === 'mine' ? '#0F172A' : '#fff', color: approvalView === 'mine' ? '#fff' : '#475569', border: 'none' }}>{t('overview.myApprovals', 'My approvals')}</button>
                  <button type="button" onClick={() => setApprovalView('all')} style={{ padding: '6px 10px', background: approvalView === 'all' ? '#0F172A' : '#fff', color: approvalView === 'all' ? '#fff' : '#475569', border: 'none' }}>{t('overview.allApprovals', 'All approvals')}</button>
                </div>
                ) : null}
                <button
                  type="button"
                  className="ops-link"
                  onClick={() => navigate(STORE_REQ_QUEUE_ROUTE)}
                  data-testid="overview-pending-viewall"
                >
                  {t('common.viewAll', 'View all')}
                </button>
              </div>
            }
          />
        </div>
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <th>{t('overview.thType', 'Type')}</th>
                <th>{t('overview.thReference', 'Reference No.')}</th>
                <th>{t('overview.thItem', 'Item')}</th>
                <th>{t('overview.thFrom', 'From')}</th>
                <th className="num">{t('overview.thQty', 'Qty')}</th>
                <th>{t('overview.thRequestedOn', 'Requested On')}</th>
                <th>{t('overview.thAction', 'Action')}</th>
              </tr>
            </thead>
            <tbody>
              {pendingStoreReq == null && (
                <tr><td colSpan={7} className="text-center text-slate-400 py-6">…</td></tr>
              )}
              {pendingStoreReq != null && shownPending.length === 0 && (
                <tr>
                  <td colSpan={7} className="!p-0">
                    <div className="ops-empty">
                      <strong>{t('overview.noPendingApprovals', 'Nothing awaiting approval')}</strong>
                      <span>{t('overview.noPendingApprovalsHint', 'When a store indent is raised from maintenance, it will queue here for review.')}</span>
                    </div>
                  </td>
                </tr>
              )}
              {shownPending.map(r => (
                <tr key={r.id} onClick={() => navigate(`/dashboard/purchase/storereq?queue=pending&req=${r.id}`)} style={{ cursor: 'pointer' }}>
                  <td>
                    <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                      <Package size={13} className="text-slate-400" /> {t('overview.storeReq', 'Store Requisition')}
                    </span>
                  </td>
                  <td className="font-mono text-xs text-slate-500">{reqNoLabel(r)}</td>
                  <td className="font-semibold text-slate-700">{r.item}</td>
                  <td>{displayLocationName(r.plants?.name) || '—'}</td>
                  <td className="num">{r.qty}</td>
                  <td className="text-slate-500">{fmtDT(r.created_at)}</td>
                  <td>
                    <span className="inline-flex items-center gap-2">
                      {['high', 'plant_stopper'].includes(r.urgency ?? '') && <StatusPill tone="red" label={t('overview.urgent', 'Urgent')} />}
                      <ButtonV2
                        size="sm" variant="outline"
                        className="text-green-700 border-green-200 hover:bg-green-50 hover:border-green-300"
                        onClick={(e) => { e.stopPropagation(); navigate(`/dashboard/purchase/storereq?queue=pending&req=${r.id}`); }}
                      >
                        {t('overview.review', 'Review')}
                      </ButtonV2>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shownPending.length > 0 && (
          <div className="px-5 py-3 text-[12px] text-slate-400 border-t border-slate-100">
            {t('overview.showingOfTotal', { n: shownPending.length, total: pendingStoreReq ?? shownPending.length, defaultValue: 'Showing {{n}} of {{total}}' })}
          </div>
        )}
      </SectionCard>

      {/* ── Analytics Insight Row ── */}
      {analytics && (
        <div className="grid grid-cols-12 gap-4">

          {/* DSO Gauge */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Days Sales Outstanding (DSO)', what: 'How many days on average it takes to collect payment after a sale is made. Lower is better — below 30d is best-in-class.', source: 'Derived', formula: 'DSO = (Debtors Outstanding / FY Revenue) × 365', tables: ['DailySum', 'Master1', 'Tran1'], note: 'Debtors = Master1 WHERE ParentGrp=116. Target < 30 days.' }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{t('overview.daysSalesOutstanding')}</div>
            <div className="flex items-center gap-3">
              <DSOGauge value={analytics.dso} />
              <div>
                <div className="text-xs text-slate-500 leading-snug">{t('overview.targetUnder30')}<br/>{t('overview.turnover')} <strong className="text-slate-700">{analytics.debtorTurnover}×</strong></div>
                <div className="mt-2">
                  <DeltaBadge value={-(analytics.dso - 30)} unit={t('overview.dGap')} />
                </div>
              </div>
            </div>
          </div>

          {/* Gross Margin Ring */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Gross Margin %', what: 'Percentage of FY revenue remaining after subtracting total purchases.', source: 'Derived', formula: 'Gross Margin = (FY Revenue − FY Purchase) / FY Revenue × 100', tables: ['Tran1'], note: 'Industry benchmark for chemical mfg is ~28%.' }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{t('overview.grossMarginFy')}</div>
            <div className="flex items-center gap-3">
              <RingProgress pct={analytics.grossMarginPct} color="#16A34A" label={t('overview.marginLabel')} />
              <div>
                <div className="text-[22px] font-extrabold text-green-700">{analytics.grossMarginPct}%</div>
                <div className="text-xs text-slate-500 mt-1">{t('overview.costRatio')} <strong className="text-slate-700">{analytics.purchaseToCostPct}%</strong></div>
                <div className="text-xs text-slate-500 mt-0.5">{t('overview.industryAvg28')}</div>
              </div>
            </div>
          </div>

          {/* Revenue Run Rate + bar sparkline */}
          <div className="col-span-12 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Annualised Revenue Run Rate', what: 'Projects full-year revenue based on the average of the last 2 complete months.', source: 'Derived', formula: 'Run Rate = avg(last 2 complete months revenue) × 12', tables: ['Tran1'] }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{t('overview.annualisedRunRate')}</div>
            <div className="text-[22px] font-extrabold text-slate-800 num">{fmtINR(analytics.revenueRunRate)}</div>
            <div className="flex items-center gap-2 mt-1 mb-2">
              <DeltaBadge value={analytics.momRevGrowthPct} />
              <span className="text-[10px] text-slate-500">{t('overview.momRevGrowth')}</span>
            </div>
            <MiniBarChart
              data={analytics.monthly.map(m => m.revenue)}
              labels={analytics.monthly.map(m => m.label)}
              color="#EF6C00"
              height={36}
            />
          </div>

          {/* Working Capital — debtors vs creditors */}
          <div className="col-span-12 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Net Working Capital', what: 'Total debtors outstanding minus total creditors outstanding.', source: 'Derived', formula: 'NWC = Debtors Outstanding − Creditors Outstanding', tables: ['DailySum', 'Master1'] }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{t('overview.netWorkingCapital')}</div>
            <div className={`text-[22px] font-extrabold num ${analytics.netWorkingCapital >= 0 ? 'text-green-700' : 'text-red-600'}`}>
              {analytics.netWorkingCapital >= 0 ? '+' : ''}{fmtINR(analytics.netWorkingCapital)}
            </div>
            <div className="text-[10px] text-slate-500 mb-3 mt-0.5">{t('overview.debtorsMinusCreditors')}</div>
            <BulletCompare
              left={kpis?.debtorsOutstanding ?? 0}
              right={analytics.creditorsOutstanding}
              leftLabel={`${t('overview.debtors')} ${fmtINR(kpis?.debtorsOutstanding ?? 0)}`}
              rightLabel={`${t('overview.creditors')} ${fmtINR(analytics.creditorsOutstanding)}`}
              leftColor="#EF6C00"
              rightColor="#2563EB"
            />
          </div>
        </div>
      )}

      {/* ── Analytics Insight Row 2 — Liquidity & Risk ── */}
      {analytics && analytics.dpo !== undefined && (
        <div className="grid grid-cols-12 gap-4">

          {/* DPO + Cash Conversion Cycle */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'DPO & Cash Conversion Cycle', what: 'DPO = how many days before the company pays its suppliers. CCC = DSO minus DPO.', source: 'Derived', formula: 'DPO = (Creditors Outstanding / FY Purchase) × 365\nCCC = DSO − DPO' }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{t('overview.payablesCycleDpo')}</div>
            <div className="text-[28px] font-extrabold num text-blue-700">{analytics.dpo} d</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{t('overview.daysPayableOutstanding')}</div>
            <div className="mt-3 pt-3 border-t border-slate-100">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider">{t('overview.cashConversionCycle')}</div>
              <div className={`text-[18px] font-extrabold num mt-0.5 ${analytics.cashConversionCycle <= 0 ? 'text-green-700' : 'text-amber-600'}`}>
                {analytics.cashConversionCycle > 0 ? '+' : ''}{analytics.cashConversionCycle} d
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                {analytics.cashConversionCycle <= 0 ? t('overview.cashPositiveCycle') : t('overview.dsoMinusDpoTied')}
              </div>
            </div>
          </div>

          {/* Collection Ratio */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Collection Ratio MTD', what: "Percentage of this month's sales revenue that has already been received as cash.", source: 'Derived', formula: 'Collection Ratio = MTD Receipts / MTD Sales × 100' }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-2">{t('overview.collectionRatioMtd')}</div>
            <div className="flex items-center gap-3">
              <RingProgress pct={Math.min(analytics.collectionRatioMTD, 100)} color="#2563EB" label={t('overview.collectedLabel')} />
              <div>
                <div className="text-[22px] font-extrabold text-blue-700">{analytics.collectionRatioMTD.toFixed(0)}%</div>
                <div className="text-[10px] text-slate-400 mt-1 leading-snug">
                  {t('overview.receiptsVsInvoicedMtd')}
                </div>
              </div>
            </div>
          </div>

          {/* Overdue Aging */}
          <div className="col-span-12 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Overdue Aging Buckets', what: 'Outstanding bills broken into 4 age bands. Older buckets have higher collection risk.', source: 'BUSY DB', tables: ['Tran3'], filter: 'RecType=5, Status=1 (pending), DueDate < today' }} />
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('overview.overdueAging')}</div>
              <div className="text-[11px] font-bold text-red-600">
                {fmtINR(analytics.overdueAging.d1_30 + analytics.overdueAging.d31_60 + analytics.overdueAging.d61_90 + analytics.overdueAging.d90plus)} {t('overview.total')}
              </div>
            </div>
            <OverdueAgingBar aging={analytics.overdueAging} />
          </div>

          {/* Revenue vs Cash Gap */}
          <div className="col-span-12 lg:col-span-3 ops-surface p-5" style={{ position: 'relative' }}>
            <KpiInfoButton info={{ title: 'Revenue vs Cash Received Gap', what: 'FY revenue invoiced minus FY receipts actually received — the total still owed across all customers.', source: 'Derived', formula: 'Gap = FY Revenue − FY Receipts (VchType=16)' }} />
            <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">{t('overview.revenueVsCashFy')}</div>
            <div className="text-[22px] font-extrabold num text-amber-600">{fmtINR(analytics.revenueReceiptsGap)}</div>
            <div className="text-[10px] text-slate-400 mt-0.5 mb-3">{t('overview.uncollectedGap')}</div>
            <BulletCompare
              left={analytics.fyReceipts}
              right={analytics.revenueReceiptsGap}
              leftLabel={`${t('overview.received')} ${fmtINR(analytics.fyReceipts)}`}
              rightLabel={`${t('overview.gap')} ${fmtINR(analytics.revenueReceiptsGap)}`}
              leftColor="#16A34A"
              rightColor="#F59E0B"
            />
          </div>
        </div>
      )}

      {/* ── Movements + Top customers ── */}
      <div className="grid grid-cols-12 gap-4">

        {/* Movements feed */}
        <div className="col-span-12 lg:col-span-8 ops-surface p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: "Today's Movements Feed", what: 'Real-time activity feed showing sales, purchase, batch, stock, and maintenance events from the last 3 days. Click any row to navigate to the source module.', source: 'BUSY DB', tables: ['Tran1', 'Master1'], filter: 'VchType in (9,14,16,19), last 3 days' }} />
          <OpsHead title={t('overview.todaysMovements')} />

          {/* Search */}
          <div className="relative mb-3">
            <input
              value={moveSearch}
              onChange={e => setMoveSearch(e.target.value)}
              placeholder={t('overview.searchMovesPlaceholder')}
              className="pl-10 pr-4 py-2.5 w-full bg-[#F8FAFC] border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-[#EF6C00] focus:ring-2 focus:ring-[rgba(239,108,0,0.15)] transition"
            />
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
            </svg>
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {['all','purchase','sales','batch','stock','maint'].map(f => (
              <div
                key={f}
                className={`chip${moveFilter === f ? ' active' : ''}`}
                onClick={() => setMoveFilter(f)}
              >
                <span>{t(`overview.movefilter_${f}`)}</span>
              </div>
            ))}
          </div>

          {/* List */}
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
            {filteredMoves.length > 0 ? filteredMoves.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-slate-50 cursor-pointer transition-colors"
                onClick={() => navigate(MOVE_ROUTE[m.type] ?? '/dashboard')}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-slate-100 text-slate-500">
                  <ArrowRight size={13} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm leading-tight truncate">{m.title}</div>
                  <div className="text-xs text-slate-500 truncate">{m.sub}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold num" style={{ color: m.col }}>{m.amt}</div>
                  <div className="text-[10px] text-slate-400">{m.when}</div>
                </div>
              </div>
            )) : (
              <div className="ops-empty rounded-xl border border-dashed border-slate-200">
                <strong>{t('overview.noMovementsMatch')}</strong>
                <span>{t('overview.noMovementsHint', 'Sales, purchases, and batch closes from BUSY will stream here.')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Top customers snapshot */}
        <div className="col-span-12 lg:col-span-4 ops-surface p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Customer History Snapshot', what: 'Top 3 customers ranked by MTD sales revenue, pulled live from BUSY.', source: 'BUSY DB', tables: ['Tran1', 'Master1'], filter: 'VchType=9, Cancelled=0, TOP 3 by MTD revenue' }} />
          <OpsHead
            title={t('overview.customerHistorySnapshot')}
            sub={t('overview.top3ByMtdRevenue')}
          />
          <div className="space-y-0.5">
            {displayCustomers.map(c => (
              <div
                key={c.name}
                className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 rounded-lg px-1.5 -mx-1.5 transition-colors"
                onClick={() => navigate('/dashboard/customers')}
              >
                <div className="text-sm font-medium truncate pr-2">{c.name}</div>
                <div className="text-sm font-bold font-heading num shrink-0">₹ {c.mtdVal}</div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="ops-link mt-3"
            onClick={() => navigate('/dashboard/customers')}
          >
            {t('overview.openCustomerHistory')} →
          </button>
        </div>
      </div>

      {(isGlobal || scopedDrums.length > 0 || scopedTanks.length > 0) && (
        <StockSnapshot
          densities={densities}
          locations={locations}
          matrix={matrix}
          tanks={scopedTanks}
          onOpenStock={() => navigate('/dashboard/stock')}
        />
      )}

      <VoiceSearch open={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </div>
  );
}
