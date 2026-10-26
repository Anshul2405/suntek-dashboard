import React, { useRef, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Footer } from './Footer';
import { RestrictedAccess } from './RestrictedAccess';
import { useAuth } from '../../hooks/useAuth';
import { useRoleContext } from '../../contexts/RoleContext';
import { profileCanAccess, isAdminProfile, isManagementProfile } from '../../lib/profiles';
import { displayLocationName } from '../../lib/plantLabels';
import { useBlacklist } from '../../contexts/BlacklistContext';
import type { BlacklistEntry } from '../../contexts/BlacklistContext';
import { ErrorBoundary } from '../ErrorBoundary';
import { SearchPaletteProvider } from '../../contexts/SearchPaletteContext';
import { LateEntryHost } from '../LateEntryHost';
import { BrandLoader } from '../brand/BrandLoader';
import { BatchFlowTourHost } from '../tour/BatchFlowTourHost';
import { MobileTableStack } from './MobileTableStack';

// ── Blacklisted overlay ───────────────────────────────────────────────────────

const SEV_COLORS: Record<string, string> = {
  critical: '#DC2626',
  high:     '#EA580C',
  medium:   '#D97706',
  low:      '#2563EB',
};

function BlacklistedOverlay({ entry, onBack }: { entry: BlacklistEntry; onBack: () => void }) {
  const { t } = useTranslation();
  const sevColor = SEV_COLORS[entry.severity] || '#DC2626';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', textAlign: 'center', padding: '40px 20px' }}>
      <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#FEF2F2', border: `2px solid ${sevColor}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24, fontSize: 32 }}>
        🚫
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>
        {t('nav.accountRestricted', 'Account Restricted')}
      </div>
      <div style={{ fontSize: 13, color: '#475569', maxWidth: 420, lineHeight: 1.6, marginBottom: 20 }}>
        {t('nav.accountRestrictedBody', 'This account has been restricted by the administrator. All dashboard data is hidden until the restriction is lifted.')}
      </div>

      <div style={{ background: '#FEF2F2', border: `1px solid ${sevColor}30`, borderRadius: 14, padding: '16px 24px', maxWidth: 440, width: '100%', marginBottom: 20, textAlign: 'left' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{t('nav.reason', 'Reason')}</div>
        <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>{entry.reason}</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20, background: '#FEF2F2', color: sevColor, border: `1px solid ${sevColor}40` }}>
            {entry.severity.toUpperCase()}
          </span>
          <span style={{ fontSize: 11, color: '#94A3B8' }}>{t('nav.addedBy', { defaultValue: 'Added by {{name}}', name: entry.added_by })}</span>
        </div>
      </div>

      <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 24 }}>
        {t('nav.contactAdminResolve', 'Contact admin to resolve this restriction')} · <strong style={{ color: '#475569' }}>Sagar Nenwani</strong>
      </div>

      <button
        onClick={onBack}
        style={{ padding: '10px 24px', borderRadius: 20, background: '#F1F5F9', border: '1px solid #E2E8F0', fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        {t('nav.backToAdminView', '← Back to Admin view')}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * i18n note: all map values below are stored as [i18nKey, englishDefault]
 * tuples (breadcrumbs as a list of segment tuples joined with ' · ') and are
 * translated at render time inside the component via t(key, default).
 */
type L = readonly [string, string];

const PAGE_TITLES: Record<string, L> = {
  '/dashboard': ['nav.operationsDashboard', 'Operations Dashboard'],
  '/dashboard/todo': ['nav.todo', 'To-Do'],
  '/dashboard/sales': ['nav.sales', 'Sales'],
  '/dashboard/stock': ['nav.cpAndStock', 'CP and Stock'],
  '/dashboard/batches': ['nav.batchSheet', 'Batch Sheet'],
  '/dashboard/customers': ['nav.customerHistory', 'Customer History'],
  '/dashboard/night-manager': ['nav.nightManager', 'Night Manager'],
  '/dashboard/oil-ratio': ['nav.oilRatioTable', 'Oil Ratio Table'],
  '/dashboard/audit': ['nav.auditLog', 'Audit Log'],
  '/dashboard/anomalies': ['nav.anomalyDetection', 'Anomaly Detection'],
  '/dashboard/anomaly-center': ['nav.anomalyOperationsCenter', 'Anomaly Operations Center'],
  '/dashboard/cost-intelligence': ['nav.costMarginIntelligence', 'Cost & Margin Intelligence'],
  '/dashboard/benchmarking': ['nav.multiPlantBenchmarking', 'Multi-Plant Benchmarking'],
  '/dashboard/predictive-qc': ['nav.livePredictiveQcBoard', 'Live Predictive QC Board'],
  '/dashboard/working-capital': ['nav.workingCapitalCash', 'Working Capital & Cash'],
  '/dashboard/owner': ['nav.ownerIntelligence', 'Owner Intelligence'],
  '/dashboard/night-entry':     ['nav.nightCheckin', 'Night Check-in'],
  '/dashboard/batch-entry':     ['nav.batchLogger', 'Batch Logger'],
  '/dashboard/warehouse-entry': ['nav.warehouseConsole', 'Warehouse Console'],
  '/dashboard/blacklist':       ['nav.blacklist', 'Blacklist'],
  '/dashboard/admin/uploads':   ['nav.uploadHistory', 'Upload History'],
  '/dashboard/users':           ['nav.userManagement', 'User Management'],
  '/dashboard/access':          ['Access & backup', 'Access & backup'],
  '/dashboard/daily-log':       ['nav.dailyUnitLog', 'Daily Unit Log'],
};

// Breadcrumb section segments (reuse existing section.*/nav.* keys).
const C_WORKSPACE:  L = ['section.workspace', 'Workspace'];
const C_OPERATIONS: L = ['section.operations', 'Operations'];
const C_FACTORY:    L = ['nav.factory', 'Factory'];
const C_REFERENCE:  L = ['section.reference', 'Reference'];
const C_MONITORING: L = ['section.monitoring', 'Monitoring'];
const C_ADMIN:      L = ['section.admin', 'Admin'];

const BREADCRUMBS: Record<string, readonly L[]> = {
  '/dashboard': [C_WORKSPACE, ['nav.overview', 'Overview']],
  '/dashboard/todo': [C_WORKSPACE, ['nav.todo', 'To-Do']],
  '/dashboard/sales': [C_OPERATIONS, ['nav.sales', 'Sales']],
  '/dashboard/stock': [C_OPERATIONS, ['nav.cpAndStock', 'CP and Stock']],
  '/dashboard/batches': [C_FACTORY, ['nav.batchSheet', 'Batch Sheet']],
  '/dashboard/customers': [C_OPERATIONS, ['nav.customerHistory', 'Customer History']],
  '/dashboard/night-manager': [C_FACTORY, ['nav.nightManager', 'Night Manager']],
  '/dashboard/oil-ratio': [C_REFERENCE, ['nav.oilRatio', 'Oil Ratio']],
  '/dashboard/audit': [C_REFERENCE, ['nav.auditLog', 'Audit Log']],
  '/dashboard/anomalies': [C_MONITORING, ['nav.anomalyDetection', 'Anomaly Detection']],
  '/dashboard/anomaly-center': [C_MONITORING, ['nav.anomalyCenter', 'Anomaly Center']],
  '/dashboard/cost-intelligence': [C_MONITORING, ['nav.costMargin', 'Cost & Margin']],
  '/dashboard/benchmarking': [C_MONITORING, ['nav.benchmarking', 'Benchmarking']],
  '/dashboard/predictive-qc': [C_MONITORING, ['nav.predictiveQc', 'Predictive QC']],
  '/dashboard/working-capital': [C_MONITORING, ['nav.workingCapital', 'Working Capital']],
  '/dashboard/owner': [C_MONITORING, ['nav.ownerIntelligence', 'Owner Intelligence']],
  '/dashboard/users': [C_ADMIN, ['nav.userManagement', 'User Management']],
  '/dashboard/access': [C_ADMIN, ['Access & backup', 'Access & backup']],
  '/dashboard/blacklist': [C_ADMIN, ['nav.blacklist', 'Blacklist']],
  '/dashboard/admin/uploads': [C_ADMIN, ['nav.uploadHistory', 'Upload History']],
  '/dashboard/daily-log': [C_REFERENCE, ['nav.dailyUnitLog', 'Daily Unit Log']],
  '/dashboard/night-entry':     [C_WORKSPACE, ['nav.nightCheckin', 'Night Check-in']],
  '/dashboard/batch-entry':     [C_WORKSPACE, ['nav.batchLogger', 'Batch Logger']],
  '/dashboard/warehouse-entry': [C_WORKSPACE, ['nav.warehouseConsole', 'Warehouse Console']],
};

/** Titles and breadcrumbs for routes that used to sit in the Purchase accordion. */
const PURCHASE_SUBPAGES: Record<string, { title: L; breadcrumb: readonly L[]; subtitle?: L }> = {
  '/dashboard/purchase/far':      { title: ['nav.asset', 'Asset'],                        breadcrumb: [C_FACTORY, ['nav.far', 'FAR'], ['nav.asset', 'Asset']],    subtitle: ['nav.subFar', 'Fixed Asset Register — every factory asset with its financial record.'] },
  '/dashboard/purchase/qr':       { title: ['nav.qrCodes', 'QR Codes'],                   breadcrumb: [C_FACTORY, ['nav.far', 'FAR'], ['nav.qrCodes', 'QR Codes']], subtitle: ['nav.subQr', 'Generate and print QR codes for factory assets.'] },
  '/dashboard/purchase/maint':    { title: ['nav.maintenance', 'Maintenance'],            breadcrumb: [C_FACTORY, ['nav.maintenance', 'Maintenance']],            subtitle: ['nav.subMaint', 'Plan, track and complete machine maintenance.'] },
  '/dashboard/purchase/activity': { title: ['nav.activityLog', 'Activity Log'],           breadcrumb: [C_FACTORY, ['nav.activityLog', 'Activity Log']],           subtitle: ['nav.subActivity', 'Every purchase-linked event, in one stream.'] },
  '/dashboard/purchase/storereq': { title: ['nav.storeRequisition', 'Store Requisition'], breadcrumb: [C_FACTORY, ['nav.storeRequisition', 'Store Requisition']], subtitle: ['nav.subStoreReq', 'Request materials, track approvals, manage stock and scrap.'] },
  '/dashboard/purchase/purchase': { title: ['nav.purchase', 'Purchase'],                  breadcrumb: [C_OPERATIONS, ['nav.purchase', 'Purchase']],                  subtitle: ['nav.subPurchaseOrder', 'Raise and track purchase orders.'] },
  '/dashboard/purchase/book':     { title: ['nav.purchaseBook', 'Purchase book'],         breadcrumb: [C_OPERATIONS, ['nav.purchaseBook', 'Purchase book']],         subtitle: ['nav.subPurchaseBook', 'Payments, marine cover, Kolkata, SHD, requirements and dispatch from the Purchase workbook.'] },
  '/dashboard/purchase/marine':   { title: ['nav.marineInsurance', 'Marine Insurance'],   breadcrumb: [C_OPERATIONS, ['nav.marineInsurance', 'Marine Insurance']] },
  '/dashboard/purchase/labour':   { title: ['nav.labour', 'Labour'],                      breadcrumb: [C_OPERATIONS, ['nav.labour', 'Labour']] },
};

/** v2 subtitles for non-purchase pages (rendered under the TopBar title). */
const PAGE_SUBTITLES: Record<string, L> = {
  '/dashboard': ['nav.subOverview', 'Shift board — work queue, alerts and plant KPIs.'],
  '/dashboard/todo': ['nav.subTodo', 'Items waiting on your role.'],
  '/dashboard/night-manager': ['nav.subNightManager', 'Night duty roster and check-ins.'],
  '/dashboard/sales': ['nav.subSales', 'Contracts, dispatches and acid tracking.'],
  '/dashboard/stock': ['nav.subStock', 'Tanks, drums and store stock by plant.'],
  '/dashboard/batches': ['nav.subBatches', 'Production sheets — TDS, COA and photo evidence.'],
  '/dashboard/customers': ['nav.subCustomers', 'Customer ledger and payment history.'],
  '/dashboard/oil-ratio': ['nav.subOilRatio', 'Density ↔ oil-ratio reference table.'],
  '/dashboard/audit': ['nav.subAudit', 'Security and change log.'],
  '/dashboard/anomalies': ['nav.subAnomalies', 'Open risk flags across modules.'],
  '/dashboard/anomaly-center': ['nav.subAnomalyCenter', 'Investigate and close anomalies.'],
  '/dashboard/users': ['nav.subUsers', 'Staff directory, roles and plant access.'],
  '/dashboard/access': ['Permissions, late-entry approval, backup and history.', 'Permissions, late-entry approval, backup and history.'],
  '/dashboard/blacklist': ['nav.subBlacklist', 'Restricted persons, vehicles and vendors.'],
  '/dashboard/admin/uploads': ['nav.subUploadHistory', 'Bulk import history and rollbacks.'],
  '/dashboard/daily-log': ['nav.subDailyLog', 'Daily unit sheets by plant.'],
};

/**
 * Normalize dynamic detail paths to their parent list route before the
 * exact-match profileCanAccess() check (and title lookups). Semantics are
 * unchanged: the QR detail used to be an in-page panel on the list route, so
 * list access has always implied detail access.
 */
function guardPath(p: string): string {
  if (p.startsWith('/dashboard/purchase/qr/')) return '/dashboard/purchase/qr';
  return p;
}

/** Purchase tab paths — used to check if a restricted profile has any purchase access */
const PURCHASE_TAB_PATHS = [
  '/dashboard/purchase/far',
  '/dashboard/purchase/maint',
  '/dashboard/purchase/activity',
  '/dashboard/purchase/storereq',
  '/dashboard/purchase/purchase',
  '/dashboard/purchase/book',
  '/dashboard/purchase/qr',
  '/dashboard/purchase/marine',
  '/dashboard/purchase/labour',
];

export function DashboardLayout() {
  const { t } = useTranslation();
  const { user, signOut, session, loading: authLoading } = useAuth();
  const { isViewingAs, activeProfile, switchProfile, authResolved, can, devBypass } = useRoleContext();
  const { isPersonBlacklisted, notifyActivity, tableReady: blacklistReady } = useBlacklist();
  const location = useLocation();
  const navigate = useNavigate();
  // Mobile sidebar drawer (md+ shows the sidebar permanently).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Close the drawer whenever the route changes.
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);
  // v2 collapsed rail (md+ only), persisted per device.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('suntek.sidebarCollapsed') === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => {
    try { localStorage.setItem('suntek.sidebarCollapsed', c ? '0' : '1'); } catch { /* private mode */ }
    return !c;
  });

  // Detect if the currently previewed profile is blacklisted
  const blacklistEntry = blacklistReady ? isPersonBlacklisted(activeProfile.name) : null;
  // Severity policy: LOW = monitor only (no access block, admin just gets alerts);
  // MEDIUM / HIGH / CRITICAL = restrict dashboard access.
  const restrictsAccess = !!blacklistEntry && blacklistEntry.severity !== 'low';

  // Fire a one-time notification when admin switches to a blacklisted profile
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (blacklistEntry && notifiedRef.current !== blacklistEntry.id) {
      notifiedRef.current = blacklistEntry.id;
      notifyActivity(blacklistEntry, `Dashboard accessed via role preview as ${activeProfile.roleLabel}`);
    }
  }, [blacklistEntry?.id]);

  // Production auth gate: a real Supabase session is required to reach the
  // management dashboard. In development we leave it open so the role/profile
  // switcher ("view-as") demo works without standing up auth.
  //
  // IMPORTANT: this guard must run AFTER every hook above — returning early
  // before a hook call changes the hook count between renders and crashes React
  // (Minified React error #300). All hooks are unconditional; only the render
  // output below is gated.
  if (import.meta.env.PROD && !authLoading && !session) {
    // Preserve the intended destination (e.g. a deep-linked ticket) for post-login return.
    const to = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={to} replace />;
  }

  // While the session / profile is still resolving, show a loader instead of the
  // locked "Access Restricted" fallback (which flashes — or sticks — otherwise).
  if (!authResolved || authLoading) {
    return <BrandLoader label="Opening your workspace…" />;
  }

  const path = location.pathname;
  // Dynamic detail paths (e.g. /purchase/qr/:key) resolve titles + access via
  // their parent list route.
  const lookupPath = guardPath(path);

  // ── Page titles & breadcrumbs ──────────────────────────────────────────────
  const tl = (l: L) => t(l[0], l[1]);
  const tCrumb = (segs: readonly L[]) => segs.map(tl).join(' · ');

  let title = tl(PAGE_TITLES[lookupPath] ?? ['nav.operationsDashboard', 'Operations dashboard']);
  let breadcrumb = tCrumb(BREADCRUMBS[lookupPath] ?? [C_WORKSPACE, ['nav.overview', 'Overview']]);
  let subtitle: string | undefined = PAGE_SUBTITLES[lookupPath] ? tl(PAGE_SUBTITLES[lookupPath]) : undefined;

  if (path.startsWith('/dashboard/purchase')) {
    const sub = PURCHASE_SUBPAGES[lookupPath] ?? PURCHASE_SUBPAGES['/dashboard/purchase/far'];
    title = tl(sub.title);
    breadcrumb = tCrumb(sub.breadcrumb);
    subtitle = sub.subtitle ? tl(sub.subtitle) : undefined;
  }

  // ── Route-level access guard ───────────────────────────────────────────────
  //
  // Standalone-only roles (night_manager, factory_operator) have no dashboard access.
  // For other roles, check allowedDashboardRoutes via profileCanAccess().
  //
  // Special case: /dashboard/purchase (the accordion root) itself isn't in any
  // profile's allowedDashboardRoutes — it immediately redirects to the first
  // sub-tab. We allow it through if the profile has ANY purchase sub-tab access.
  //
  const isPurchaseRoot = path === '/dashboard/purchase';
  const hasSomePurchaseAccess = PURCHASE_TAB_PATHS.some((p) =>
    profileCanAccess(activeProfile, p)
  );

  // User Management is reachable by anyone with a user/role-management capability
  // (e.g. a delegated unit head), not only via an explicit route grant.
  const isUserMgmt = path === '/dashboard/users';
  const isAccess = path === '/dashboard/access';
  const canAccessRoute =
    !activeProfile.standaloneOnly &&
    (isPurchaseRoot ? hasSomePurchaseAccess
      : isUserMgmt ? (can('manage_users') || can('manage_roles') || profileCanAccess(activeProfile, lookupPath))
      : isAccess ? (isAdminProfile(activeProfile) || isManagementProfile(activeProfile))
      : profileCanAccess(activeProfile, lookupPath));

  // Post-login landing: a locked user who hits the Overview ('/dashboard') they
  // can't see is sent straight to their own home section, instead of bouncing
  // off the Access Restricted screen. Scoped to the index so other restricted
  // navigation still shows the explanatory page.
  if (
    !canAccessRoute &&
    path === '/dashboard' &&
    activeProfile.homeRoute !== '/dashboard' &&
    profileCanAccess(activeProfile, activeProfile.homeRoute)
  ) {
    return <Navigate to={activeProfile.homeRoute} replace />;
  }

  return (
    <SearchPaletteProvider>
    <div className="app-shell" data-sidebar-collapsed={collapsed ? 'true' : undefined} style={{ minHeight: '100vh' }}>
      <MobileTableStack />
      <Sidebar
        user={user}
        onSignOut={signOut}
        mobileOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
      />

      {/* Mobile drawer backdrop */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <main className="min-h-screen min-w-0 p-3 sm:p-4 md:p-7 ml-0 md:ml-[var(--sidebar-width,260px)] transition-[margin] duration-200">
        <div className="max-w-[1500px] mx-auto min-w-0">
          <TopBar title={title} breadcrumb={breadcrumb} subtitle={subtitle} onMenu={() => setSidebarOpen(true)} />

          {/* DEV-ONLY: no Supabase session → the shell shows the demo admin
              profile, but the database sees an ANONYMOUS caller, so every
              RLS-scoped table returns zero rows and the app looks empty even
              though the data is there. Say so loudly: this is otherwise
              indistinguishable from "the database is broken". */}
          {devBypass && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 mb-5 bg-red-50 border border-red-200 rounded-2xl">
              <div className="text-[12.5px] text-red-700">
                <strong>Dev preview — not signed in.</strong> The database is returning no rows because
                row-level security hides everything from anonymous callers. Sign in to see real data.
              </div>
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="shrink-0 text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-red-600 text-white"
              >
                Sign in
              </button>
            </div>
          )}

          {/* "Viewing as" banner — appears when not in Admin mode */}
          {isViewingAs && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 mb-5 bg-orange-50 border border-orange-200 rounded-lg">
              <div className="flex items-center gap-2.5">
                <div
                  className={[
                    'w-7 h-7 rounded-full flex-shrink-0',
                    'bg-gradient-to-br',
                    activeProfile.avatarFrom,
                    activeProfile.avatarTo,
                    'flex items-center justify-center',
                    'text-white font-bold text-[10px]',
                  ].join(' ')}
                >
                  {activeProfile.initials}
                </div>
                <div className="text-[13px] leading-tight">
                  <span className="font-semibold text-orange-900">
                    {t('nav.viewingAs', { defaultValue: 'Viewing as {{role}}', role: activeProfile.roleLabel })}
                  </span>
                  <span className="text-orange-600"> · {activeProfile.name}</span>
                  {activeProfile.plant && (
                    <span className="text-orange-400"> · {displayLocationName(activeProfile.plant)}</span>
                  )}
                </div>
              </div>
              <button
                className="text-[12px] font-bold px-3 py-1.5 rounded-full bg-orange-500 text-white hover:bg-orange-600 transition-colors whitespace-nowrap flex-shrink-0"
                onClick={() => {
                  switchProfile('admin');
                  navigate('/dashboard');
                }}
              >
                {t('nav.backToAdmin', '← Back to Admin')}
              </button>
            </div>
          )}

          {/* Route guard: blacklist (severity ≥ medium) → access check → content */}
          {canAccessRoute
            ? restrictsAccess && blacklistEntry
              ? <BlacklistedOverlay entry={blacklistEntry} onBack={() => { switchProfile('admin'); navigate('/dashboard'); }} />
              : (
                <>
                <ErrorBoundary key={path} label={title}>
                  <div className="page-enter">
                    <Outlet />
                  </div>
                </ErrorBoundary>
                <LateEntryHost />
                </>
              )
            : <RestrictedAccess />
          }

          <Footer />
        </div>
      </main>
      <BatchFlowTourHost />
    </div>
    </SearchPaletteProvider>
  );
}
