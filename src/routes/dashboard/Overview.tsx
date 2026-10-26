import React, { useState, useEffect } from 'react';
import { VoiceSearch } from '../../components/search/VoiceSearch';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Wrench, AlertTriangle, AlertCircle, Mic,
  CheckSquare, ShoppingCart, Truck, FlaskConical, Boxes, Package,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { displayLocationName } from '../../lib/plantLabels';
import type { Database } from '../../lib/database.types';

type AlertRow = Database['public']['Tables']['alerts']['Row'];
type TankRow = Database['public']['Tables']['tanks']['Row'];
type DrumRow = Database['public']['Tables']['cpm_drum_stock']['Row'];
type ReqRow = Database['public']['Tables']['store_requisitions']['Row'] & { plants?: { name: string | null } | null };
import {
  useOverviewKPIs, useTopCustomers, useRecentMovements, useAnalyticsKPIs, fmtINR,
} from '../../hooks/useBusyData';
import { KpiInfoButton } from '../../components/KpiInfoButton';
import type { KpiMeta } from '../../components/KpiInfoButton';
import { StockSnapshot } from '../../components/overview/StockSnapshot';
import { ButtonV2, StatusPill } from '../../components/v2';

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
function KpiBlock({ label, value, delta, deltaTone = 'slate', info, accent }: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: 'green' | 'red' | 'orange' | 'slate';
  info?: React.ComponentProps<typeof KpiInfoButton>['info'];
  accent?: boolean;
}) {
  return (
    <div className="ops-kpi-cell" data-accent={accent ? '1' : undefined}>
      {info && <KpiInfoButton info={info} style={{ top: 8, right: 8 }} />}
      <div className="ops-kpi-label">{label}</div>
      <div className="ops-kpi-val">{value}</div>
      {delta && <div className="ops-kpi-delta" data-tone={deltaTone}>{delta}</div>}
    </div>
  );
}

function Book({
  title, sub, right, children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ov-book">
      <header className="ov-book-head">
        <div>
          <h3>{title}</h3>
          {sub ? <p>{sub}</p> : null}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function StmtRow({
  label, value, note, meter, meterTone, info,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  meter?: number;
  meterTone?: 'ok' | 'warn' | 'hot';
  info?: KpiMeta;
}) {
  return (
    <tr>
      <td className="k">
        {info && <KpiInfoButton info={info} style={{ top: 6, right: 4 }} />}
        {label}
        {meter != null && (
          <div className="ov-meter" data-tone={meterTone}>
            <i style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
          </div>
        )}
      </td>
      <td className="v">{value}</td>
      <td className="n">{note}</td>
    </tr>
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

const fmtDT = (d: string | null) => d
  ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—';

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
  const [tanks, setTanks] = useState<TankRow[]>([]);
  const [drumRows, setDrumRows] = useState<DrumRow[]>([]);
  const [pendingReqs, setPendingReqs] = useState<ReqRow[]>([]);
  const [pendingStoreReq, setPendingStoreReq] = useState<number | null>(null);
  const [openMaint, setOpenMaint] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const [alertsRes, tanksRes, drumsRes, reqListRes, reqCountRes, maintRes] = await Promise.all([
        supabase.from('alerts').select('*').eq('is_resolved', false).order('created_at', { ascending: false }).returns<AlertRow[]>(),
        supabase.from('tanks').select('*').order('sort_order', { ascending: true }).returns<TankRow[]>(),
        supabase.from('cpm_drum_stock').select('*').returns<DrumRow[]>(),
        supabase.from('store_requisitions').select('*, plants(name)').eq('status', 'pending').order('created_at', { ascending: false }).limit(8).returns<ReqRow[]>(),
        supabase.from('store_requisitions').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('maintenance_tickets').select('*', { count: 'exact', head: true }).eq('type', 'emergency').neq('status', 'closed'),
      ]);
      setAlerts(alertsRes.data || []);
      setTanks(tanksRes.data || []);
      setDrumRows(drumsRes.data || []);
      setPendingReqs(reqListRes.data || []);
      setPendingStoreReq(reqCountRes.error ? null : (reqCountRes.count ?? 0));
      setOpenMaint(maintRes.error ? null : (maintRes.count ?? 0));
    })();
  }, []);

  // Pivot drum rows into the density×location matrix (same shape as CPMStock).
  const densities = [...new Set(drumRows.map(r => r.density))].sort((a, b) => a - b);
  const locations = [...new Set(drumRows.map(r => r.location))];
  const drumLookup = new Map(drumRows.map(r => [`${r.location}|${r.density}`, r.drums]));
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
      <Book
        title={t('overview.todaysWork', "Today's Work")}
        sub={t('overview.todaysWorkSub', 'What needs a decision on the floor right now')}
      >
        <div className="ops-shift">
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={toneForCount(pendingStoreReq)}
            onClick={() => navigate('/dashboard/purchase/storereq?queue=pending')}
          >
            <div className="ops-shift-label">{t('overview.pendingApprovals', 'Pending Approvals')}</div>
            <div className="ops-shift-val">{pendingStoreReq ?? '…'}</div>
            <div className="ops-shift-cap">
              {pendingStoreReq ? t('overview.requiresAction', 'Requires your action →') : t('overview.allClear', 'All clear')}
            </div>
          </button>
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={toneForCount(openMaint)}
            onClick={() => navigate('/dashboard/purchase/maint?tab=emergency&status=open')}
          >
            <div className="ops-shift-label">{t('overview.openMaintenance', 'Open Maintenance')}</div>
            <div className="ops-shift-val">{openMaint ?? '…'}</div>
            <div className="ops-shift-cap">
              {openMaint ? t('overview.ticketsInProgress', 'Tickets in progress') : t('overview.noOpenTickets', 'No open tickets')}
            </div>
          </button>
          <button
            type="button"
            className="ops-shift-tile"
            data-tone={toneForCount(alerts.length)}
            onClick={() => {
              document.getElementById('ov-alerts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            <div className="ops-shift-label">{t('overview.openAlerts', 'Open Alerts')}</div>
            <div className="ops-shift-val">{alerts.length}</div>
            <div className="ops-shift-cap">
              {alerts.length ? t('overview.acrossModules', 'Across all modules') : t('overview.allQuiet', 'All quiet')}
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
          <div id="ov-alerts" className="ops-alert-panel">
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
                    <span className={`w-6 h-6 inline-flex items-center justify-center shrink-0 mt-0.5 ${sev === 'red' ? 'bg-[#3F1515] text-[#F87171]' : sev === 'amber' ? 'bg-[#3A2410] text-[#FB923C]' : 'bg-[#2A2A2A] text-[#A39A90]'}`}>
                      {sev === 'red' ? <AlertTriangle size={12} /> : <AlertCircle size={12} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[#F3EFE8] leading-snug">{a.text}</div>
                      <div className="text-[11px] text-[#8A847C] mt-0.5">{a.source}</div>
                    </div>
                    <span className="text-[11px] text-[#8A847C] shrink-0">{a.when_label || AGE(a.created_at, t)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Book>

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
      <Book
        title={t('overview.businessKpis', 'Business KPIs')}
        sub={t('overview.businessKpisSub', 'BUSY ledger pulse — MTD & FY')}
      >
        <div className="ops-kpi-rail">
          <KpiBlock
            accent
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
            label={t('overview.purchaseMtd', 'Purchase · MTD')}
            value={kpis ? fmtINR(kpis.purchaseMTD) : '…'}
            delta={kpis?.purchaseNote || t('overview.inclMarineIns', 'incl. marine insurance')}
            info={{ title: 'Purchase MTD', what: 'Total purchase invoices from suppliers in the current month, all plants consolidated. Liquid chlorine is left out.', source: 'BUSY DB', tables: ['Tran1'], filter: 'VchType=2, Cancelled=0, current month' }}
          />
          <KpiBlock
            label={t('overview.cashNetMtd', 'Cash in − out · MTD')}
            value={kpis ? `${kpis.receiptsMTD - kpis.paymentsMTD < 0 ? '−' : ''}${fmtINR(Math.abs(kpis.receiptsMTD - kpis.paymentsMTD))}` : '…'}
            delta={kpis ? t('overview.cashInOut', { defaultValue: 'In {{inAmt}} · Out {{outAmt}}', inAmt: fmtINR(kpis.receiptsMTD), outAmt: fmtINR(kpis.paymentsMTD) }) : undefined}
            deltaTone={kpis && kpis.receiptsMTD >= kpis.paymentsMTD ? 'green' : 'orange'}
            info={{ title: 'Cash in vs out this month', what: 'Money received from customers (receipt vouchers) minus money paid out (payment vouchers) this month, up to today. Post-dated entries are left out.', source: 'BUSY DB', tables: ['Tran1'], filter: 'VchType=14 receipts, VchType=19 payments, Cancelled=0, current month, date up to today' }}
          />
          <KpiBlock
            label={t('overview.debtorsOutstanding', 'Debtors Outstanding')}
            value={kpis ? fmtINR(kpis.debtorsOutstanding) : '…'}
            delta={analytics ? `DSO ${analytics.dso}d` : undefined}
            deltaTone={analytics && analytics.dso > 30 ? 'orange' : 'green'}
          />
        </div>
      </Book>

      {/* ── Pending Approvals table ── */}
      <Book
        title={t('overview.pendingApprovals', 'Pending Approvals')}
        sub={t('overview.pendingApprovalsSub', 'Store requisitions waiting on Unit Head / Admin')}
        right={
          <button
            type="button"
            className="ops-link"
            onClick={() => navigate('/dashboard/purchase/storereq?queue=pending')}
          >
            {t('common.viewAll', 'View all')}
          </button>
        }
      >
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
              {pendingReqs.length === 0 && (
                <tr>
                  <td colSpan={7} className="!p-0">
                    <div className="ops-empty">
                      <strong>{t('overview.noPendingApprovals', 'Nothing awaiting approval')}</strong>
                      <span>{t('overview.noPendingApprovalsHint', 'When a store indent is raised from maintenance, it will queue here for review.')}</span>
                    </div>
                  </td>
                </tr>
              )}
              {pendingReqs.map(r => (
                <tr key={r.id} onClick={() => navigate('/dashboard/purchase/storereq?queue=pending')} style={{ cursor: 'pointer' }}>
                  <td>
                    <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                      <Package size={13} className="text-slate-400" /> {t('overview.storeReq', 'Store Requisition')}
                    </span>
                  </td>
                  <td className="font-mono text-xs text-slate-400">#{r.id.slice(0, 8)}</td>
                  <td className="font-semibold text-slate-700">{r.item}</td>
                  <td>{displayLocationName(r.plants?.name) || '—'}</td>
                  <td className="num">{r.qty}</td>
                  <td className="text-slate-500">{fmtDT(r.created_at)}</td>
                  <td>
                    {['high', 'plant_stopper'].includes(r.urgency ?? '')
                      ? <StatusPill tone="red" label={t('overview.urgent', 'Urgent')} />
                      : (
                        <ButtonV2
                          size="sm" variant="outline"
                          className="text-green-700 border-green-200 hover:bg-green-50 hover:border-green-300"
                          onClick={(e) => { e.stopPropagation(); navigate('/dashboard/purchase/storereq?queue=pending'); }}
                        >
                          {t('overview.review', 'Review')}
                        </ButtonV2>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Book>

      {analytics && (
        <div className="ov-books">
          <Book
            title={t('overview.workingCapitalBook', 'Working capital')}
            sub={t('overview.workingCapitalBookSub', 'DSO · margin · run rate')}
          >
            <table className="ov-stmt">
              <tbody>
                <StmtRow
                  info={{ title: 'Days Sales Outstanding (DSO)', what: 'How many days on average it takes to collect payment after a sale is made. Lower is better — below 30d is best-in-class.', source: 'Derived', formula: 'DSO = (Debtors Outstanding / FY Revenue) × 365', tables: ['DailySum', 'Master1', 'Tran1'], note: 'Debtors = Master1 WHERE ParentGrp=116. Target < 30 days.' }}
                  label={t('overview.daysSalesOutstanding')}
                  value={`${analytics.dso.toFixed(1)} d`}
                  note={`${t('overview.targetUnder30')} · ${t('overview.turnover')} ${analytics.debtorTurnover.toFixed(2)}×`}
                  meter={(analytics.dso / 90) * 100}
                  meterTone={analytics.dso > 60 ? 'hot' : analytics.dso > 30 ? 'warn' : 'ok'}
                />
                <StmtRow
                  info={{ title: 'Gross Margin %', what: 'Percentage of FY revenue remaining after subtracting total purchases.', source: 'Derived', formula: 'Gross Margin = (FY Revenue − FY Purchase) / FY Revenue × 100', tables: ['Tran1'], note: 'Industry benchmark for chemical mfg is ~28%.' }}
                  label={t('overview.grossMarginFy')}
                  value={`${analytics.grossMarginPct.toFixed(1)}%`}
                  note={`${t('overview.costRatio')} ${analytics.purchaseToCostPct.toFixed(1)}% · ${t('overview.industryAvg28')}`}
                  meter={analytics.grossMarginPct}
                  meterTone={analytics.grossMarginPct >= 28 ? 'ok' : analytics.grossMarginPct >= 18 ? 'warn' : 'hot'}
                />
                <StmtRow
                  info={{ title: 'Annualised Revenue Run Rate', what: 'Projects full-year revenue based on the average of the last 2 complete months.', source: 'Derived', formula: 'Run Rate = avg(last 2 complete months revenue) × 12', tables: ['Tran1'] }}
                  label={t('overview.annualisedRunRate')}
                  value={fmtINR(analytics.revenueRunRate)}
                  note={`${analytics.momRevGrowthPct >= 0 ? '+' : ''}${analytics.momRevGrowthPct}% ${t('overview.momRevGrowth')}`}
                />
                <StmtRow
                  info={{ title: 'Net Working Capital', what: 'Total debtors outstanding minus total creditors outstanding.', source: 'Derived', formula: 'NWC = Debtors Outstanding − Creditors Outstanding', tables: ['DailySum', 'Master1'] }}
                  label={t('overview.netWorkingCapital')}
                  value={`${analytics.netWorkingCapital >= 0 ? '+' : ''}${fmtINR(analytics.netWorkingCapital)}`}
                  note={`${t('overview.debtors')} ${fmtINR(kpis?.debtorsOutstanding ?? 0)} · ${t('overview.creditors')} ${fmtINR(analytics.creditorsOutstanding)}`}
                />
              </tbody>
            </table>
            {analytics.monthly.length > 0 && (
              <div className="ov-months">
                {analytics.monthly.slice(-6).map(m => {
                  const max = Math.max(...analytics.monthly.map(x => x.revenue), 1);
                  return (
                    <div key={m.label}>
                      <b style={{ height: `${Math.max(2, (m.revenue / max) * 28)}px` }} />
                      <span>{m.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Book>

          <Book
            title={t('overview.cashCycleBook', 'Cash cycle')}
            sub={t('overview.cashCycleBookSub', 'DPO · collections · overdue')}
          >
            <table className="ov-stmt">
              <tbody>
                <StmtRow
                  info={{ title: 'DPO & Cash Conversion Cycle', what: 'DPO = how many days before the company pays its suppliers. CCC = DSO minus DPO.', source: 'Derived', formula: 'DPO = (Creditors Outstanding / FY Purchase) × 365\nCCC = DSO − DPO' }}
                  label={t('overview.payablesCycleDpo')}
                  value={analytics.dpo != null ? `${analytics.dpo.toFixed(1)} d` : '—'}
                  note={t('overview.daysPayableOutstanding')}
                />
                <StmtRow
                  label={t('overview.cashConversionCycle')}
                  value={analytics.cashConversionCycle != null
                    ? `${analytics.cashConversionCycle > 0 ? '+' : ''}${analytics.cashConversionCycle.toFixed(1)} d`
                    : '—'}
                  note={analytics.cashConversionCycle != null && analytics.cashConversionCycle <= 0
                    ? t('overview.cashPositiveCycle')
                    : t('overview.dsoMinusDpoTied')}
                />
                <StmtRow
                  info={{ title: 'Collection Ratio MTD', what: "Percentage of this month's sales revenue that has already been received as cash.", source: 'Derived', formula: 'Collection Ratio = MTD Receipts / MTD Sales × 100' }}
                  label={t('overview.collectionRatioMtd')}
                  value={`${analytics.collectionRatioMTD.toFixed(0)}%`}
                  note={t('overview.receiptsVsInvoicedMtd')}
                  meter={analytics.collectionRatioMTD}
                  meterTone={analytics.collectionRatioMTD >= 80 ? 'ok' : analytics.collectionRatioMTD >= 50 ? 'warn' : 'hot'}
                />
                <StmtRow
                  info={{ title: 'Revenue vs Cash Received Gap', what: 'FY revenue invoiced minus FY receipts actually received — the total still owed across all customers.', source: 'Derived', formula: 'Gap = FY Revenue − FY Receipts (VchType=14)' }}
                  label={t('overview.revenueVsCashFy')}
                  value={fmtINR(analytics.revenueReceiptsGap)}
                  note={`${t('overview.received')} ${fmtINR(analytics.fyReceipts)}`}
                />
              </tbody>
            </table>
            <table className="dt2">
              <thead>
                <tr>
                  <th>1–30 d</th>
                  <th>31–60 d</th>
                  <th>61–90 d</th>
                  <th>90+ d</th>
                  <th className="num">{t('overview.overdueAging')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">{fmtINR(analytics.overdueAging.d1_30)}</td>
                  <td className="num">{fmtINR(analytics.overdueAging.d31_60)}</td>
                  <td className="num">{fmtINR(analytics.overdueAging.d61_90)}</td>
                  <td className="num">{fmtINR(analytics.overdueAging.d90plus)}</td>
                  <td className="num" style={{ color: '#DC2626' }}>
                    {fmtINR(analytics.overdueAging.d1_30 + analytics.overdueAging.d31_60 + analytics.overdueAging.d61_90 + analytics.overdueAging.d90plus)}
                  </td>
                </tr>
              </tbody>
            </table>
          </Book>
        </div>
      )}

      <div className="ov-books">
        <Book
          title={t('overview.todaysMovements')}
          sub={t('overview.movementsBookSub', 'Last 3 days from BUSY')}
        >
          <div className="ov-search">
            <input
              value={moveSearch}
              onChange={e => setMoveSearch(e.target.value)}
              placeholder={t('overview.searchMovesPlaceholder')}
            />
          </div>
          <div className="ov-filters">
            {['all', 'purchase', 'sales', 'batch', 'stock', 'maint'].map(f => (
              <button
                key={f}
                type="button"
                data-on={moveFilter === f ? '1' : '0'}
                onClick={() => setMoveFilter(f)}
              >
                {t(`overview.movefilter_${f}`)}
              </button>
            ))}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {filteredMoves.length > 0 ? filteredMoves.map((m, i) => (
              <div
                key={i}
                className="ov-move-row"
                onClick={() => navigate(MOVE_ROUTE[m.type] ?? '/dashboard')}
              >
                <span className="ov-move-type">{m.type}</span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">{m.title}</div>
                  <div className="text-[11px] text-[#8A8178] truncate">{m.sub}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[13px] font-semibold num" style={{ color: m.col }}>{m.amt}</div>
                  <div className="text-[10px] text-[#A39A90]">{m.when}</div>
                </div>
              </div>
            )) : (
              <div className="ops-empty">
                <strong>{t('overview.noMovementsMatch')}</strong>
                <span>{t('overview.noMovementsHint', 'Sales, purchases, and batch closes from BUSY will stream here.')}</span>
              </div>
            )}
          </div>
        </Book>

        <Book
          title={t('overview.customerHistorySnapshot')}
          sub={t('overview.top3ByMtdRevenue')}
          right={
            <button type="button" className="ops-link" onClick={() => navigate('/dashboard/customers')}>
              {t('overview.openCustomerHistory')}
            </button>
          }
        >
          {displayCustomers.map((c, i) => (
            <div
              key={c.name}
              className="ov-cust-row"
              onClick={() => navigate('/dashboard/customers')}
            >
              <span className="rk">{String(i + 1).padStart(2, '0')}</span>
              <span className="nm">{c.name}</span>
              <span className="am">₹ {c.mtdVal}</span>
            </div>
          ))}
        </Book>
      </div>

      <StockSnapshot
        densities={densities}
        locations={locations}
        matrix={matrix}
        tanks={tanks}
        onOpenStock={() => navigate('/dashboard/stock')}
      />

      <VoiceSearch open={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </div>
  );
}
