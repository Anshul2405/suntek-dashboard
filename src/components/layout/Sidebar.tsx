import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AuthUser } from '../../hooks/useAuth';
import { useRoleContext } from '../../contexts/RoleContext';
import { useAnomalies } from '../../contexts/AnomalyContext';
import { useTodo } from '../../contexts/TodoContext';
import { useSearchPalette } from '../../contexts/SearchPaletteContext';
import { canViewBatchFacet, canViewBatchRegister, hasBatchFacetCaps, isAdminProfile, isManagementProfile, profileCanAccess } from '../../lib/profiles';
import { SuntekLogo } from '../brand/SuntekLogo';

interface SidebarProps {
  user: AuthUser | null;
  onSignOut: () => void;
  /** Drawer open state on mobile (md+ is always shown). */
  mobileOpen?: boolean;
  /** Close the mobile drawer (called after navigation). */
  onClose?: () => void;
  /** v2 collapsed rail (md+ only — the mobile drawer always renders full). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

/** A sidebar dropdown child. `nav` overrides the click target when it must differ
 *  from `path` (e.g. to carry a ?ctx marker that disambiguates a shared route).
 *  `children` turns the item into a nested sub-accordion (e.g. FAR → Fixed Assets / QR). */
type NavItem = { key: string; path: string; nav?: string; children?: NavItem[] };

/**
 * Factory dropdown children — order matters (first visible item is the accordion
 * default). Paths are explicit because the children mix the Purchase nested
 * routes (/dashboard/purchase/*) with top-level routes (Batch Sheet, Night Manager).
 * `key` is the i18n label key. Routing/permissions are unchanged — this only
 * regroups how the links are presented.
 */
const FACTORY_ITEMS: NavItem[] = [
  { key: 'nav.far', path: '/dashboard/purchase/far', children: [
    { key: 'nav.asset',   path: '/dashboard/purchase/far' },
    { key: 'nav.qrCodes', path: '/dashboard/purchase/qr'  },
  ] },
  { key: 'nav.maintenance',    path: '/dashboard/purchase/maint'    },
  { key: 'nav.activityLog',    path: '/dashboard/purchase/activity' },
  { key: 'nav.storeReq',       path: '/dashboard/purchase/storereq' },
  { key: 'nav.purchaseOrders', path: '/dashboard/purchase/purchase' },
  { key: 'nav.marineInsurance', path: '/dashboard/purchase/marine'  },
  { key: 'nav.labour',         path: '/dashboard/purchase/labour'   },
  { key: 'nav.batchSheet',     path: '/dashboard/batches'           },
  { key: 'nav.nightManager',   path: '/dashboard/night-manager'     },
];

/**
 * Operations dropdown children. Purchase reuses the Purchase Orders page for now
 * and is expected to grow its own sub-modules later. CP and Stock is the CPM Stock
 * board (display rename only — same /dashboard/stock route).
 */
const OPERATIONS_ITEMS: NavItem[] = [
  // Purchase reuses the same page as Factory's "Purchase Order". They share a
  // route, so we tag this one with ?ctx=ops (`nav`) — the highlight logic reads
  // that marker to light up ONLY the entry the user actually opened, not both.
  { key: 'nav.purchase',        path: '/dashboard/purchase/purchase', nav: '/dashboard/purchase/purchase?ctx=ops' },
  { key: 'nav.sales',           path: '/dashboard/sales'             },
  { key: 'nav.customerHistory', path: '/dashboard/customers'         },
  { key: 'nav.cpAndStock',      path: '/dashboard/stock'             },
];

/** The route shared by Factory→"Purchase Order" and Operations→"Purchase". */
const SHARED_PO_ROUTE = '/dashboard/purchase/purchase';

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconGrid() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  );
}
function IconCheckSquare() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 11 12 14 22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  );
}
function IconBox() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    </svg>
  );
}
function IconCart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
      <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>
    </svg>
  );
}
function IconFlask() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 3h6"/><path d="M10 3v6L4 21h16L14 9V3"/>
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
    </svg>
  );
}
function IconWarehouse() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}
function IconClipboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
      <line x1="9" y1="12" x2="15" y2="12"/>
      <line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  );
}
function IconActivity() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2 2 7l10 5 10-5-10-5z"/>
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>
    </svg>
  );
}
function IconRadar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12 19 5"/>
    </svg>
  );
}
function IconShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="sb-hide text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-6 mb-2 px-3">
      {label}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export function Sidebar({ user, onSignOut, mobileOpen = false, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { activeProfile, can } = useRoleContext();
  const { criticalCount } = useAnomalies();
  const { totalCount: todoCount } = useTodo();
  const { openPalette } = useSearchPalette();

  // A dropdown defaults open when the current route is one of its children.
  const inGroup = (paths: string[]) =>
    paths.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'));
  // The shared Purchase route belongs to Factory unless the user arrived via
  // Operations (marked with ?ctx=ops). This lets Factory and Operations — which
  // share that one route — highlight/expand independently instead of together.
  const onSharedPO = location.pathname === SHARED_PO_ROUTE;
  const viaOps = onSharedPO && new URLSearchParams(location.search).get('ctx') === 'ops';
  const [factoryOpen, setFactoryOpen] = useState(
    onSharedPO ? !viaOps : inGroup(FACTORY_ITEMS.map((i) => i.path))
  );
  const [operationsOpen, setOperationsOpen] = useState(
    onSharedPO ? viaOps : inGroup(OPERATIONS_ITEMS.map((i) => i.path))
  );
  // FAR nested sub-accordion inside Factory (Fixed Assets · QR Code).
  const [farOpen, setFarOpen] = useState(
    inGroup(['/dashboard/purchase/far', '/dashboard/purchase/qr'])
  );
  // Reference dropdown (Daily Unit Log · Oil Ratio Table · Audit Log).
  const [refOpen, setRefOpen] = useState(
    inGroup(['/dashboard/daily-log', '/dashboard/oil-ratio', '/dashboard/audit'])
  );

  // Monitoring "Intelligence" accordion holds the analytical pages; Anomaly
  // Detection sits outside it as a peer. Open by default when on any of them.
  const MONITORING_PATHS = [
    '/dashboard/predictive-qc',
    '/dashboard/cost-intelligence',
    '/dashboard/working-capital',
    '/dashboard/benchmarking',
    '/dashboard/owner',
    '/dashboard/anomaly-center',
  ];
  const [monitoringOpen, setMonitoringOpen] = useState(
    MONITORING_PATHS.some((p) => location.pathname.startsWith(p))
  );
  // Monitoring section dropdown (wraps the Intelligence accordion + Anomaly Detection).
  const [monSectionOpen, setMonSectionOpen] = useState(
    inGroup([...MONITORING_PATHS, '/dashboard/anomalies'])
  );
  // Admin section dropdown — expanded by default per requirement.
  const [adminOpen, setAdminOpen] = useState(true);

  // Technical Team (factory_operator) — Factory (Batch Sheet + Activity) / Operations / Logs.
  // Also match provisioned users whose base role is factory_operator (id is db_<uuid>).
  const isOperator =
    activeProfile.id === 'factory_operator' || activeProfile.baseRoleId === 'factory_operator';
  const [opsOpen, setOpsOpen] = useState(location.pathname === '/dashboard/stock');
  const [logsOpen, setLogsOpen] = useState(location.pathname === '/dashboard/daily-log');
  const [plantOpen, setPlantOpen] = useState(
    location.pathname === '/dashboard/batches' ||
    location.pathname.startsWith('/dashboard/purchase/maint') ||
    location.pathname.startsWith('/dashboard/purchase/storereq') ||
    location.pathname.startsWith('/dashboard/purchase/activity')
  );

  /** True if the active profile can access this exact route (or its children). */
  const canSee = (route: string) => profileCanAccess(activeProfile, route);

  // Extra plant links Technical may hold beyond Batch Sheet (e.g. Maintenance).
  const showOperatorMaint = isOperator && canSee('/dashboard/purchase/maint');
  const showOperatorStoreReq = isOperator && canSee('/dashboard/purchase/storereq');
  const showOperatorActivity = isOperator && canSee('/dashboard/purchase/activity');
  // Always show Factory for Technical so Batch Sheet is reachable there.
  const showOperatorPlant = isOperator;

  // ── Section visibility ──────────────────────────────────────────────────────
  //
  // WORKSPACE  =  Overview + Factory dropdown + Operations dropdown (+ role entry terminals)
  // REFERENCE  =  Oil Ratio Table · Audit Log
  //
  // Factory groups the physical-plant modules (FAR, Maintenance, Activity, Store
  // Req, PO, Batch Sheet, Night Manager). Operations groups the commercial modules
  // (Purchase, Sales, Customer History, CP and Stock). Both are gated per-child by
  // canSee(), so a role only sees the children it could already reach — no route or
  // permission change, only presentation.

  const showOverview = canSee('/dashboard');
  // Personal work queue — available to every profile that has the route granted.
  const showTodo = canSee('/dashboard/todo');

  // A Factory item is visible if the role can reach it (or, for a nested group like
  // FAR, any of its children).
  const factoryVisible = (it: NavItem) =>
    it.children ? it.children.some((c) => canSee(c.path)) : canSee(it.path);
  const visibleFactoryItems    = FACTORY_ITEMS.filter(factoryVisible);
  const visibleOperationsItems = OPERATIONS_ITEMS.filter((it) => canSee(it.path));
  // Technical Team uses its own Batch / Operations / Logs branch — hide the
  // admin-style Factory + Operations accordions so Batch Sheet isn't listed twice
  // and "Batch" isn't confused with Factory → Batch Sheet.
  const showFactory    = !isOperator && visibleFactoryItems.length > 0;
  const showOperations = !isOperator && visibleOperationsItems.length > 0;

  // L1 entry views — shown ONLY for the specific role that owns the task, as flat
  // items. Admin/Unit Head monitor via the Factory boards, not entry terminals.
  const showWarehouseEntry = activeProfile.id === 'warehouse_manager';
  const showNightEntry     = activeProfile.id === 'night_manager';
  // Daily log upload: admin + unit_head only. The Technical Team (factory_operator)
  // is the Batch Logger — their only job is "Log Reading" (batch-entry), and
  // /dashboard/daily-log isn't in their allowed routes, so it must not appear.
  const showDailyLog = isAdminProfile(activeProfile) || activeProfile.id === 'unit_head' || activeProfile.baseRoleId === 'unit_head';

  // Flat entry terminals live below the dropdowns (operators use their own branch).
  // Daily Unit Log now lives in the Reference dropdown, not here.
  const showEntryTerminals = showWarehouseEntry || showNightEntry;

  // Workspace section header — visible if any workspace item is visible.
  const showWorkspace = showTodo || showOverview || showFactory || showOperations || isOperator || showEntryTerminals;

  // Reference dropdown — Daily Unit Log · Oil Ratio Table · Audit Log.
  const showOilRatio = canSee('/dashboard/oil-ratio');
  const showAudit    = canSee('/dashboard/audit');
  const showReference = showDailyLog || showOilRatio || showAudit;

  // Monitoring items
  const showAnomalies = canSee('/dashboard/anomalies');
  const showOwner = isAdminProfile(activeProfile);

  // Intelligence accordion sub-tabs — order matters (first visible is the
  // accordion default target). Anomaly Detection is intentionally NOT here;
  // it stays a peer of the accordion below.
  const INTELLIGENCE_TABS = [
    { key: 'nav.predictiveQc',      path: '/dashboard/predictive-qc',     show: canSee('/dashboard/predictive-qc')     },
    { key: 'nav.costMargin',        path: '/dashboard/cost-intelligence', show: canSee('/dashboard/cost-intelligence') },
    { key: 'nav.workingCapital',    path: '/dashboard/working-capital',   show: canSee('/dashboard/working-capital')   },
    { key: 'nav.benchmarking',      path: '/dashboard/benchmarking',      show: canSee('/dashboard/benchmarking')      },
    { key: 'nav.ownerIntelligence', path: '/dashboard/owner',             show: showOwner                              },
    { key: 'nav.anomalyCenter',     path: '/dashboard/anomaly-center',    show: canSee('/dashboard/anomaly-center')    },
  ].filter((it) => it.show);

  const showIntelligence = INTELLIGENCE_TABS.length > 0;

  // Admin section — user management + blacklist + upload history
  // User Management shows for anyone who can manage users or roles (delegated too).
  const showAdmin = can('manage_users') || can('manage_roles');
  const showBlacklist = isAdminProfile(activeProfile) || activeProfile.id === 'unit_head' || activeProfile.baseRoleId === 'unit_head';
  // Upload History is where an incorrect CSV/Excel import gets undone. Shown to
  // whoever holds the capability; the RPC checks it again server-side, so this
  // only controls whether the link appears.
  const showUploads = can('delete_import_batch');
  const showAccess = isAdminProfile(activeProfile) || isManagementProfile(activeProfile);

  const isActive = (path: string) => {
    if (path === '/dashboard') return location.pathname === '/dashboard';
    return location.pathname.startsWith(path);
  };

  // Child highlight. For the route shared by Factory→Purchase Order and
  // Operations→Purchase, only the entry the user opened (tracked by ?ctx=ops)
  // lights up — never both. Same idea for Batch Logger vs Reading History (?tab=).
  const itemActive = (it: NavItem) => {
    if (it.path === SHARED_PO_ROUTE) {
      if (!onSharedPO) return false;
      const isOpsEntry = it.nav?.includes('ctx=ops') ?? false;
      return isOpsEntry ? viaOps : !viaOps;
    }
    if (it.path === '/dashboard/batch-entry' && it.nav?.includes('tab=')) {
      if (location.pathname !== '/dashboard/batch-entry') return false;
      const want = new URLSearchParams(it.nav.split('?')[1] ?? '').get('tab') || 'reading';
      const have = new URLSearchParams(location.search).get('tab') || 'reading';
      return want === have;
    }
    return isActive(it.path);
  };

  // A Factory item is active if it (or, for a nested group, any child) is active.
  const factoryItemActive = (it: NavItem) => it.children ? it.children.some((c) => isActive(c.path)) : itemActive(it);
  // Parent-dropdown highlight: active when any visible child is active.
  const factoryActive    = visibleFactoryItems.some(factoryItemActive);
  const operationsActive = visibleOperationsItems.some(itemActive);

  function navTo(path: string) {
    navigate(path);
    onClose?.(); // close the mobile drawer after navigating
  }

  return (
    <aside
      className={`sidebar-v2 ${collapsed ? 'collapsed ' : ''}fixed left-0 top-0 bottom-0 p-5 overflow-y-auto z-50 flex flex-col transition-[transform,width] duration-200 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      style={{ width: 'var(--sidebar-width, 260px)' }}
      onClickCapture={(e) => {
        // Collapsed rail: any click (except the collapse toggle itself) expands
        // the sidebar first so accordions/labels are visible again.
        if (collapsed && !(e.target as HTMLElement).closest('[data-collapse-btn]')) {
          onToggleCollapse?.();
        }
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 mb-6 shrink-0">
        <SuntekLogo size={40} />
        <div className="sb-hide min-w-0">
          <div className="font-heading font-semibold text-[16px] leading-tight text-white tracking-tight">Suntek</div>
          <div className="text-slate-400 text-[11px] tracking-wide">Plant ERP</div>
        </div>
      </div>

      {/* Quick Search — quiet, not orange hero */}
      <button
        className="rounded-lg px-3 py-2 text-[13px] font-medium flex items-center gap-2 mb-3 w-full shrink-0 border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white cursor-pointer"
        title={`${t('nav.quickSearch')} (⌘K)`}
        onClick={() => { openPalette(); onClose?.(); }}
      >
        <IconSearch />
        <span className="sb-hide flex-1 text-left">{t('nav.quickSearch')}</span>
        <kbd className="sb-hide text-[10px] text-slate-400 bg-transparent border border-white/10 rounded px-1.5 py-0.5">⌘K</kbd>
      </button>

      {/* ── WORKSPACE ─────────────────────────────────────────────────────── */}
      {showWorkspace && <SectionHeader label={t('section.workspace')} />}
      <nav className="flex flex-col gap-1">

        {/* Overview */}
        {showOverview && (
          <a
            className={`nav-link${location.pathname === '/dashboard' ? ' active' : ''}`}
            onClick={() => navTo('/dashboard')}
          >
            <IconGrid />
            <span>{t('nav.overview')}</span>
          </a>
        )}

        {/* To-Do — personal work queue */}
        {showTodo && (
          <a
            className={`nav-link${location.pathname === '/dashboard/todo' ? ' active' : ''}`}
            onClick={() => navTo('/dashboard/todo')}
          >
            <IconCheckSquare />
            <span>{t('nav.todo')}</span>
            {todoCount > 0 && (
              <span className="pill-count" style={{ background: '#F97316', color: '#fff' }}>
                {todoCount > 9 ? '9+' : todoCount}
              </span>
            )}
          </a>
        )}

        {/* Factory accordion — FAR · Maintenance · Activity · Store Req · PO · Batch Sheet · Night Manager */}
        {showFactory && (
          <>
            <a
              className={`nav-link${factoryActive ? ' active' : ''}`}
              onClick={() => {
                setFactoryOpen((o) => !o);
                if (!factoryOpen) navTo(visibleFactoryItems[0].nav ?? visibleFactoryItems[0].path);
              }}
            >
              <IconBox />
              <span>{t('nav.factory')}</span>
              <svg
                className="ml-auto transition-transform duration-200"
                style={{ transform: factoryOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                width="11" height="11" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.4"
              >
                <path d="m9 6 6 6-6 6"/>
              </svg>
            </a>

            {factoryOpen && (
              <div className="nav-sub">
                {visibleFactoryItems.map((it) => {
                  // Nested sub-accordion (FAR → Fixed Assets / QR Code).
                  if (it.children) {
                    const kids = it.children.filter((c) => canSee(c.path));
                    return (
                      <React.Fragment key={it.path}>
                        <a
                          className={`nav-link${factoryItemActive(it) ? ' active' : ''}`}
                          onClick={() => { setFarOpen((o) => !o); if (!farOpen) navTo(kids[0].path); }}
                        >
                          <span>{t(it.key)}</span>
                          <svg className="ml-auto transition-transform duration-200" style={{ transform: farOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
                        </a>
                        {farOpen && (
                          <div className="nav-sub">
                            {kids.map((c) => (
                              <a key={c.path} className={`nav-link${isActive(c.path) ? ' active' : ''}`} onClick={() => navTo(c.path)}>
                                {t(c.key)}
                              </a>
                            ))}
                          </div>
                        )}
                      </React.Fragment>
                    );
                  }
                  return (
                    <a
                      key={it.path}
                      className={`nav-link${itemActive(it) ? ' active' : ''}`}
                      onClick={() => navTo(it.nav ?? it.path)}
                    >
                      {t(it.key)}
                    </a>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Operations accordion — Purchase · Sales · Customer History · CP and Stock */}
        {showOperations && (
          <>
            <a
              className={`nav-link${operationsActive ? ' active' : ''}`}
              onClick={() => {
                setOperationsOpen((o) => !o);
                if (!operationsOpen) navTo(visibleOperationsItems[0].nav ?? visibleOperationsItems[0].path);
              }}
            >
              <IconCart />
              <span>{t('section.operations')}</span>
              <svg
                className="ml-auto transition-transform duration-200"
                style={{ transform: operationsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                width="11" height="11" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.4"
              >
                <path d="m9 6 6 6-6 6"/>
              </svg>
            </a>

            {operationsOpen && (
              <div className="nav-sub">
                {visibleOperationsItems.map((it) => (
                  <a
                    key={it.path}
                    className={`nav-link${itemActive(it) ? ' active' : ''}`}
                    onClick={() => navTo(it.nav ?? it.path)}
                  >
                    {t(it.key)}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      {/* ── Technical Team (factory_operator) — Factory / Operations / Logs ── */}
      {isOperator && (
      <nav className="flex flex-col gap-1">

        {/* Operations — CP/Stock */}
        {canSee('/dashboard/stock') && (
          <>
            <a
              className={`nav-link${isActive('/dashboard/stock') ? ' active' : ''}`}
              onClick={() => { setOpsOpen((o) => !o); if (!opsOpen) navTo('/dashboard/stock'); }}
            >
              <IconFlask />
              <span>{t('section.operations')}</span>
              <svg className="ml-auto transition-transform duration-200" style={{ transform: opsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
            </a>
            {opsOpen && (
              <div className="nav-sub">
                <a className={`nav-link${isActive('/dashboard/stock') ? ' active' : ''}`} onClick={() => navTo('/dashboard/stock')}>{t('nav.cpAndStock')}</a>
              </div>
            )}
          </>
        )}

        {/* Plant — only when Technical was also granted Maintenance / Store Req */}
        {showOperatorPlant && (
          <>
            <a
              className={`nav-link${(isActive('/dashboard/batches') || isActive('/dashboard/purchase/maint') || isActive('/dashboard/purchase/storereq') || isActive('/dashboard/purchase/activity')) ? ' active' : ''}`}
              onClick={() => {
                setPlantOpen((o) => !o);
                if (!plantOpen) {
                  navTo(canViewBatchRegister(activeProfile)
                    ? '/dashboard/batches'
                    : '/dashboard/batch-entry?tab=reading');
                }
              }}
            >
              <IconBox />
              <span>{t('nav.factory')}</span>
              <svg className="ml-auto transition-transform duration-200" style={{ transform: plantOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
            </a>
            {plantOpen && (
              <div className="nav-sub">
                {(!hasBatchFacetCaps(activeProfile) || canViewBatchFacet(activeProfile, 'mat') || canViewBatchFacet(activeProfile, 'sheet')) && (
                  <a className={`nav-link${isActive('/dashboard/batches') ? ' active' : ''}`} onClick={() => navTo('/dashboard/batches')}>{t('nav.batchSheet')}</a>
                )}
                {hasBatchFacetCaps(activeProfile) && canViewBatchFacet(activeProfile, 'raw') && (
                  <a className={`nav-link${isActive('/dashboard/batch-entry') && (new URLSearchParams(location.search).get('tab') || 'reading') === 'reading' ? ' active' : ''}`} onClick={() => navTo('/dashboard/batch-entry?tab=reading')}>{t('nav.logReading', 'Log reading')}</a>
                )}
                {hasBatchFacetCaps(activeProfile) && canViewBatchFacet(activeProfile, 'sheet') && (
                  <a className={`nav-link${isActive('/dashboard/batch-entry') && new URLSearchParams(location.search).get('tab') === 'create-sheet' ? ' active' : ''}`} onClick={() => navTo('/dashboard/batch-entry?tab=create-sheet')}>{t('nav.createBatchSheet', 'Create Batch Sheet')}</a>
                )}
                {showOperatorActivity && (
                  <a className={`nav-link${isActive('/dashboard/purchase/activity') ? ' active' : ''}`} onClick={() => navTo('/dashboard/purchase/activity')}>{t('nav.activityLog')}</a>
                )}
                {showOperatorMaint && (
                  <a className={`nav-link${isActive('/dashboard/purchase/maint') ? ' active' : ''}`} onClick={() => navTo('/dashboard/purchase/maint')}>{t('nav.maintenance')}</a>
                )}
                {showOperatorStoreReq && (
                  <a className={`nav-link${isActive('/dashboard/purchase/storereq') ? ' active' : ''}`} onClick={() => navTo('/dashboard/purchase/storereq?tab=stock')}>{t('nav.storeReq')}</a>
                )}
              </div>
            )}
          </>
        )}

        {canSee('/dashboard/daily-log') && (
          <>
            <a
              className={`nav-link${isActive('/dashboard/daily-log') ? ' active' : ''}`}
              onClick={() => {
                setLogsOpen((o) => !o);
                if (!logsOpen) navTo('/dashboard/daily-log');
              }}
            >
              <IconClipboard />
              <span>{t('nav.logs')}</span>
              <svg className="ml-auto transition-transform duration-200" style={{ transform: logsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
            </a>
            {logsOpen && (
              <div className="nav-sub">
                <a className={`nav-link${isActive('/dashboard/daily-log') ? ' active' : ''}`} onClick={() => navTo('/dashboard/daily-log')}>{t('nav.dailyUnitLog')}</a>
              </div>
            )}
          </>
        )}
      </nav>
      )}

      {/* ── Role-scoped entry terminals — flat items for the single role that owns each ── */}
      {!isOperator && showEntryTerminals && (
      <nav className="flex flex-col gap-1 mt-1">

        {/* Warehouse Console — embedded entry view for Warehouse Manager role */}
        {showWarehouseEntry && (
          <a
            className={`nav-link${isActive('/dashboard/warehouse-entry') ? ' active' : ''}`}
            onClick={() => navTo('/dashboard/warehouse-entry')}
          >
            <IconWarehouse />
            <span>{t('nav.warehouseConsole')}</span>
            <span className="pill-count" style={{ background: '#F0FDF4', color: '#16A34A' }}>{t('nav.pillEntry', 'entry')}</span>
          </a>
        )}

        {/* Night Check-in — embedded view for Night Manager role */}
        {showNightEntry && (
          <a
            className={`nav-link${isActive('/dashboard/night-entry') ? ' active' : ''}`}
            onClick={() => navTo('/dashboard/night-entry')}
          >
            <IconMoon />
            <span>{t('nav.nightCheckin')}</span>
            <span className="pill-count" style={{ background: 'rgba(255,255,255,0.08)', color: '#94A3B8' }}>{t('nav.pillEntry', 'entry')}</span>
          </a>
        )}

      </nav>
      )}

      {/* ── REFERENCE (dropdown) — Daily Unit Log · Oil Ratio Table · Audit Log ── */}
      {showReference && (
      <nav className="flex flex-col gap-1">
        <a
          className={`nav-link${inGroup(['/dashboard/daily-log', '/dashboard/oil-ratio', '/dashboard/audit']) ? ' active' : ''}`}
          onClick={() => {
            setRefOpen((o) => !o);
            if (!refOpen) {
              const first = showDailyLog ? '/dashboard/daily-log' : showOilRatio ? '/dashboard/oil-ratio' : '/dashboard/audit';
              navTo(first);
            }
          }}
        >
          <IconLayers />
          <span>{t('section.reference')}</span>
          <svg className="ml-auto transition-transform duration-200" style={{ transform: refOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
        </a>
        {refOpen && (
          <div className="nav-sub">
            {showDailyLog && (
              <a className={`nav-link${isActive('/dashboard/daily-log') ? ' active' : ''}`} onClick={() => navTo('/dashboard/daily-log')}>
                <span>{t('nav.dailyUnitLog')}</span>
              </a>
            )}
            {showOilRatio && (
              <a className={`nav-link${isActive('/dashboard/oil-ratio') ? ' active' : ''}`} onClick={() => navTo('/dashboard/oil-ratio')}>
                <span>{t('nav.oilRatioTable')}</span>
              </a>
            )}
            {showAudit && (
              <a className={`nav-link${isActive('/dashboard/audit') ? ' active' : ''}`} onClick={() => navTo('/dashboard/audit')}>
                <span>{t('nav.auditLog')}</span>
              </a>
            )}
          </div>
        )}
      </nav>
      )}

      {/* ── MONITORING (dropdown) — wraps the Intelligence accordion + Anomaly Detection ── */}
      {(showIntelligence || showAnomalies) && (
        <nav className="flex flex-col gap-1">

          <a
            className={`nav-link${inGroup([...MONITORING_PATHS, '/dashboard/anomalies']) ? ' active' : ''}`}
            onClick={() => {
              setMonSectionOpen((o) => !o);
              if (!monSectionOpen) navTo(showIntelligence ? INTELLIGENCE_TABS[0].path : '/dashboard/anomalies');
            }}
          >
            <IconRadar />
            <span>{t('section.monitoring')}</span>
            <svg className="ml-auto transition-transform duration-200" style={{ transform: monSectionOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
          </a>

          {monSectionOpen && (
          <div className="nav-sub">

          {/* Intelligence accordion — analytical pages, collapsed like Purchase */}
          {showIntelligence && (
            <>
              <a
                className={`nav-link${MONITORING_PATHS.some((p) => location.pathname.startsWith(p)) ? ' active' : ''}`}
                onClick={() => {
                  setMonitoringOpen((o) => !o);
                  if (!monitoringOpen) navTo(INTELLIGENCE_TABS[0].path);
                }}
              >
                <IconActivity />
                <span>{t('nav.intelligence')}</span>
                <svg
                  className="ml-auto transition-transform duration-200"
                  style={{ transform: monitoringOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  width="11" height="11" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.4"
                >
                  <path d="m9 6 6 6-6 6"/>
                </svg>
              </a>

              {monitoringOpen && (
                <div className="nav-sub">
                  {INTELLIGENCE_TABS.map((it) => (
                    <a
                      key={it.path}
                      className={`nav-link${isActive(it.path) ? ' active' : ''}`}
                      onClick={() => navTo(it.path)}
                    >
                      {t(it.key)}
                    </a>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Anomaly Detection — peer of the accordion, never inside it */}
          {showAnomalies && (
            <a
              className={`nav-link${isActive('/dashboard/anomalies') ? ' active' : ''}`}
              onClick={() => navTo('/dashboard/anomalies')}
            >
              <IconAlert />
              <span>{t('nav.anomalyDetection')}</span>
              {criticalCount > 0 && (
                <span className="pill-count" style={{ background: '#FEF2F2', color: '#DC2626' }}>
                  {criticalCount > 9 ? '9+' : criticalCount}
                </span>
              )}
            </a>
          )}
          </div>
          )}
        </nav>
      )}

      {/* ── ADMIN (dropdown) — expanded by default ────────────────────────── */}
      {(showAdmin || showBlacklist || showUploads || showAccess) && (
      <nav className="flex flex-col gap-1">
        <a
          className={`nav-link${(isActive('/dashboard/users') || isActive('/dashboard/access') || isActive('/dashboard/blacklist') || isActive('/dashboard/admin/uploads')) ? ' active' : ''}`}
          onClick={() => {
            setAdminOpen((o) => !o);
            if (!adminOpen) navTo(showAdmin ? '/dashboard/users' : showBlacklist ? '/dashboard/blacklist' : '/dashboard/admin/uploads');
          }}
        >
          <IconShield />
          <span>{t('section.admin')}</span>
          <svg className="ml-auto transition-transform duration-200" style={{ transform: adminOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m9 6 6 6-6 6"/></svg>
        </a>
        {adminOpen && (
          <div className="nav-sub">
            {showAdmin && (
              <a className={`nav-link${isActive('/dashboard/users') ? ' active' : ''}`} onClick={() => navTo('/dashboard/users')}>
                <span>{t('nav.userManagement')}</span>
              </a>
            )}
            {showBlacklist && (
              <a className={`nav-link${isActive('/dashboard/blacklist') ? ' active' : ''}`} onClick={() => navTo('/dashboard/blacklist')}>
                <span>{t('nav.blacklist')}</span>
              </a>
            )}
            {showAccess && (
              <a className={`nav-link${isActive('/dashboard/access') ? ' active' : ''}`} onClick={() => navTo('/dashboard/access')}>
                <span>{t('nav.accessBackup', 'Access & backup')}</span>
              </a>
            )}
            {showUploads && (
              <a className={`nav-link${isActive('/dashboard/admin/uploads') ? ' active' : ''}`} onClick={() => navTo('/dashboard/admin/uploads')}>
                <span>{t('nav.uploadHistory', 'Upload History')}</span>
              </a>
            )}
          </div>
        )}
      </nav>
      )}

      {/* ── User card — shows active profile, not real auth user ──────────── */}
      <div className="sb-hide mt-6 p-2.5 rounded-lg border border-white/8 bg-white/[0.04]">
        <div className="flex items-center gap-2.5">
          <div
            className="w-9 h-9 rounded-lg flex-shrink-0 bg-[#EF6C00] flex items-center justify-center text-white font-bold text-xs"
          >
            {activeProfile.initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold leading-tight truncate text-white">
              {activeProfile.name}
            </div>
            <div className="text-[11px] text-slate-400">{activeProfile.roleLabel}</div>
            {activeProfile.plant && (
              <div className="text-[10px] text-slate-500 truncate">{activeProfile.plant}</div>
            )}
            {activeProfile.accessNote && (
              <div className="text-[9px] text-slate-500 truncate mt-0.5" title={activeProfile.accessNote}>
                {activeProfile.accessNote}
              </div>
            )}
          </div>
        </div>
        {/* Sign out lives in the top-right avatar menu (ProfileSwitcher), not here. */}
      </div>

      {/* ── Collapse toggle — pinned to the bottom, md+ only ──────────────── */}
      <button
        data-collapse-btn
        className="nav-link hidden md:flex mt-auto pt-4 shrink-0 w-full"
        style={{ marginTop: 'auto' }}
        title={t('nav.collapseMenu')}
        onClick={() => onToggleCollapse?.()}
      >
        <svg
          width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="transition-transform duration-200 shrink-0"
          style={{ transform: collapsed ? 'rotate(180deg)' : undefined }}
        >
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        <span className="sb-hide">{t('nav.collapseMenu')}</span>
      </button>
    </aside>
  );
}
