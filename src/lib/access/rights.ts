/**
 * Access rights at Busy's depth, mapped onto dashboard screens and tabs
 * (User Management → Menu rights / Add·Modify·Delete / Back-date limits).
 *
 *  Menu rights   what a person can SEE: sidebar sections (roles.allowed_routes)
 *                and, inside a gated page, its tabs (ops_settings.tabs).
 *  Verbs         View | Add | Edit | Delete per module (ops_settings.modules).
 *  Back days     how far before today (IST) an entry date may go, per module.
 *  People        a person's own yes / no beats their roles (ops_settings.people).
 *
 * Owner/Admin always. Everything else is fail-closed: before the saved settings
 * have been read, only Admin gets a tab or a verb.
 */
import {
  canDeleteModule, canEditModule, personOverride, roleAllowed,
  type ModuleKey, type OpsSettings, type Verb,
} from '../opsControls';
import { isAdminProfile, profileCanAccess, type MockProfile } from '../profiles';
import { billBufferDays } from '../datePolicy';

// ── Sections (sidebar pages) ─────────────────────────────────────────────────
// Built from the live routes in App.tsx. `group` is the Menu rights tree branch.
export interface SectionDef { route: string; label: string; labelKey: string; group: SectionGroup }
export type SectionGroup = 'overview' | 'factory' | 'operations' | 'intelligence' | 'entry' | 'admin';

export const SECTION_GROUPS: { key: SectionGroup; label: string; labelKey: string }[] = [
  { key: 'overview', label: 'Overview & To-Do', labelKey: 'rights.grpOverview' },
  { key: 'factory', label: 'Factory', labelKey: 'rights.grpFactory' },
  { key: 'operations', label: 'Operations', labelKey: 'rights.grpOperations' },
  { key: 'intelligence', label: 'Intelligence', labelKey: 'rights.grpIntelligence' },
  { key: 'entry', label: 'Plant entry screens', labelKey: 'rights.grpEntry' },
  { key: 'admin', label: 'Admin', labelKey: 'rights.grpAdmin' },
];

export const ALL_SECTIONS: SectionDef[] = [
  { route: '/dashboard', label: 'Overview', labelKey: 'userMgmt.sec_overview', group: 'overview' },
  { route: '/dashboard/todo', label: 'To-Do', labelKey: 'rights.secTodo', group: 'overview' },
  { route: '/dashboard/purchase/far', label: 'Fixed Asset Register', labelKey: 'userMgmt.sec_fixedAssetRegister', group: 'factory' },
  { route: '/dashboard/purchase/qr', label: 'Asset QR Codes', labelKey: 'userMgmt.sec_assetQrCodes', group: 'factory' },
  { route: '/dashboard/purchase/maint', label: 'Maintenance', labelKey: 'userMgmt.sec_maintenance', group: 'factory' },
  { route: '/dashboard/purchase/activity', label: 'Activity Log', labelKey: 'userMgmt.sec_plantActivityLog', group: 'factory' },
  { route: '/dashboard/purchase/storereq', label: 'Store Requisitions', labelKey: 'userMgmt.sec_storeRequisitions', group: 'factory' },
  { route: '/dashboard/purchase/purchase', label: 'Purchase Orders', labelKey: 'userMgmt.sec_purchaseOrders', group: 'factory' },
  { route: '/dashboard/purchase/marine', label: 'Marine Insurance', labelKey: 'userMgmt.sec_marineInsurance', group: 'factory' },
  { route: '/dashboard/purchase/labour', label: 'Labour Costs', labelKey: 'userMgmt.sec_labourCosts', group: 'factory' },
  { route: '/dashboard/batches', label: 'Batch Sheets', labelKey: 'userMgmt.sec_batchSheets', group: 'factory' },
  { route: '/dashboard/night-manager', label: 'Night Manager Board', labelKey: 'userMgmt.sec_nightManagerBoard', group: 'factory' },
  { route: '/dashboard/purchase/book', label: 'Purchase book', labelKey: 'rights.secPurchaseBook', group: 'operations' },
  { route: '/dashboard/sales', label: 'Sales', labelKey: 'userMgmt.sec_sales', group: 'operations' },
  { route: '/dashboard/customers', label: 'Customers', labelKey: 'userMgmt.sec_customers', group: 'operations' },
  { route: '/dashboard/stock', label: 'CPM Stock', labelKey: 'userMgmt.sec_cpmStock', group: 'operations' },
  { route: '/dashboard/oil-ratio', label: 'Oil Ratio Reference', labelKey: 'userMgmt.sec_oilRatio', group: 'operations' },
  { route: '/dashboard/anomalies', label: 'Anomaly Detection', labelKey: 'userMgmt.sec_anomalyDetection', group: 'intelligence' },
  { route: '/dashboard/anomaly-center', label: 'Anomaly Operations Center', labelKey: 'userMgmt.sec_anomalyOpsCenter', group: 'intelligence' },
  { route: '/dashboard/cost-intelligence', label: 'Cost & Margin Intelligence', labelKey: 'userMgmt.sec_costMarginIntel', group: 'intelligence' },
  { route: '/dashboard/benchmarking', label: 'Multi-Plant Benchmarking', labelKey: 'userMgmt.sec_benchmarking', group: 'intelligence' },
  { route: '/dashboard/predictive-qc', label: 'Predictive QC', labelKey: 'userMgmt.sec_predictiveQc', group: 'intelligence' },
  { route: '/dashboard/working-capital', label: 'Working Capital & Cash', labelKey: 'userMgmt.sec_workingCapital', group: 'intelligence' },
  { route: '/dashboard/owner', label: 'Owner Intelligence', labelKey: 'rights.secOwner', group: 'intelligence' },
  { route: '/dashboard/night-entry', label: 'Night Check-in (entry)', labelKey: 'userMgmt.sec_nightCheckinEntry', group: 'entry' },
  { route: '/dashboard/batch-entry', label: 'Batch Logger (entry)', labelKey: 'userMgmt.sec_batchLoggerEntry', group: 'entry' },
  { route: '/dashboard/daily-log', label: 'Daily Unit Log', labelKey: 'userMgmt.sec_dailyUnitLog', group: 'entry' },
  { route: '/dashboard/warehouse-entry', label: 'Warehouse Console (entry)', labelKey: 'userMgmt.sec_warehouseConsoleEntry', group: 'entry' },
  { route: '/dashboard/audit', label: 'Audit Trail', labelKey: 'userMgmt.sec_auditTrail', group: 'admin' },
  { route: '/dashboard/blacklist', label: 'Blacklist Registry', labelKey: 'userMgmt.sec_blacklistRegistry', group: 'admin' },
];

// ── Gated tabs ───────────────────────────────────────────────────────────────
// Ticking a page does NOT grant its tabs: each tab is its own tick.
export const BOOK_ROUTE = '/dashboard/purchase/book';
export const BOOK_TABS = ['purchases', 'payments', 'paraffin', 'requirements', 'dispatch', 'kolkata', 'shd'] as const;
export type BookTab = (typeof BOOK_TABS)[number];

export interface TabDef { key: string; label: string; labelKey: string }
export const GATED_TABS: Record<string, TabDef[]> = {
  [BOOK_ROUTE]: [
    { key: 'purchases', label: 'Purchases', labelKey: 'book.tabPurchases' },
    { key: 'payments', label: 'Payments', labelKey: 'book.tabPayments' },
    { key: 'paraffin', label: 'Paraffin payments', labelKey: 'book.tabParaffin' },
    { key: 'requirements', label: 'Requirements', labelKey: 'book.tabRequirements' },
    { key: 'dispatch', label: 'Dispatch', labelKey: 'book.tabDispatch' },
    // NKG and Kolkata are one sales branch (Sidak, 29 Oct 2026); key stays `kolkata`.
    { key: 'kolkata', label: 'NKG · Kolkata', labelKey: 'book.tabKolkata' },
    { key: 'shd', label: 'SHD', labelKey: 'book.tabShd' },
  ],
};

/**
 * Pages that have tabs but are NOT gated per tab yet (they follow the page):
 * Maintenance (periodic / emergency / schedule / incidents), Store Req
 * (requirements / stock / scrap), Warehouse (stock / requisition), Upload
 * History (uploads / audit), Payments stage tabs and Anomaly Center status tabs
 * (filters, not separate data).
 */
export const UNGATED_TAB_PAGES = [
  '/dashboard/purchase/maint', '/dashboard/purchase/storereq', '/warehouse', '/dashboard/admin/uploads',
];
/** Names for the pages above that are not sidebar sections. */
export const UNGATED_TAB_LABELS: Record<string, { label: string; labelKey: string }> = {
  '/warehouse': { label: 'Warehouse', labelKey: 'rights.pgWarehouse' },
  '/dashboard/admin/uploads': { label: 'Upload History', labelKey: 'nav.uploadHistory' },
};

// ── Verbs ────────────────────────────────────────────────────────────────────
export interface VerbModuleDef {
  key: ModuleKey;
  label: string;
  labelKey: string;
  /** The page that is this module's View. */
  route: string;
  /** For a Purchase book tab: the tab that must be visible too. */
  tab?: string;
  /** Verbs that have a real button on that screen. */
  verbs: Verb[];
}

export const VERB_MODULES: VerbModuleDef[] = [
  { key: 'maintenance', label: 'Maintenance tickets', labelKey: 'rights.modMaintenance', route: '/dashboard/purchase/maint', verbs: ['add', 'edit', 'delete'] },
  { key: 'store_req', label: 'Store requisitions', labelKey: 'rights.modStoreReq', route: '/dashboard/purchase/storereq', verbs: ['add'] },
  { key: 'stock', label: 'Stock register', labelKey: 'rights.modStock', route: '/dashboard/purchase/storereq', verbs: ['edit', 'delete'] },
  { key: 'purchase', label: 'Add purchase to stock', labelKey: 'rights.modPurchase', route: '/dashboard/purchase/storereq', verbs: ['add'] },
  { key: 'batch', label: 'Batch sheets', labelKey: 'rights.modBatch', route: '/dashboard/batches', verbs: ['add', 'delete'] },
  { key: 'far', label: 'Fixed assets (FAR)', labelKey: 'rights.modFar', route: '/dashboard/purchase/far', verbs: ['add', 'edit'] },
  { key: 'activity', label: 'Activity Log (+ Log activity)', labelKey: 'rights.modActivity', route: '/dashboard/purchase/activity', verbs: ['add'] },
  { key: 'payments', label: 'Payments', labelKey: 'rights.modPayments', route: BOOK_ROUTE, tab: 'payments', verbs: ['add'] },
  { key: 'dispatch', label: 'Dispatch', labelKey: 'rights.modDispatch', route: BOOK_ROUTE, tab: 'dispatch', verbs: ['add'] },
];

// ── Back-date limits ─────────────────────────────────────────────────────────
// Modules whose save carries a date a person picks. Future dates are never
// blocked by this — back-date is only "how far before today".
export const BACKDATE_MODULES: { key: string; label: string; labelKey: string }[] = [
  { key: 'purchase', label: 'Add purchase (bill date)', labelKey: 'rights.bdPurchase' },
  { key: 'payments', label: 'Payments (pay date)', labelKey: 'rights.bdPayments' },
  { key: 'dispatch', label: 'Dispatch (dispatch date)', labelKey: 'rights.bdDispatch' },
  { key: 'activity', label: '+ Log activity (date)', labelKey: 'rights.bdActivity' },
];

// ── Decisions ────────────────────────────────────────────────────────────────

/** Role ids this person holds (multi-role), never their person id. */
export function roleIdsOf(profile: MockProfile): string[] {
  return profile.roleIds?.length ? profile.roleIds : [profile.baseRoleId || profile.id];
}

/** Can a role with these allowed routes open this page? (Purchase book still follows Purchase Orders / Marine.) */
export function routesOpen(routes: string[] | undefined, route: string): boolean {
  const r = routes || [];
  if (r.includes('*') || r.includes(route)) return true;
  if (route === BOOK_ROUTE) return r.includes('/dashboard/purchase/purchase') || r.includes('/dashboard/purchase/marine');
  return false;
}

/** Roles that can open a page today (for "start from today's behaviour" seeding). */
export function rolesThatCanOpen(roles: { id: string; allowed_routes?: string[] | null }[], route: string): string[] {
  return roles.filter((r) => routesOpen(r.allowed_routes ?? [], route)).map((r) => r.id);
}

/** Roles Admin has decided tabs for on this page (an explicit list, even an empty one). */
export function configuredTabRoles(settings: OpsSettings, route: string): Set<string> {
  const lists = settings.tabs?.[route] || {};
  return new Set([...(settings.tabRoles?.[route] || []), ...Object.values(lists).flat()]);
}

/** Look up a role's allowed routes (from the roles catalogue); undefined = unknown. */
export type RoleRoutes = (roleId: string) => string[] | undefined;

/**
 * May this person see this tab of a gated page?
 * - Owner/Admin: always. Before the saved rights load: no (fail-closed).
 * - The person's own Yes / No wins.
 * - A role Admin has configured for this page: only its ticked tabs.
 * - A role never configured that can open the page: every tab (today's view),
 *   so shipping this never hides the book from anyone.
 */
export function canSeeTab(settings: OpsSettings, profile: MockProfile, personId: string | null | undefined, route: string, tab: string, roleRoutes?: RoleRoutes): boolean {
  if (isAdminProfile(profile)) return true;
  if (!settings.loaded) return false;
  if (!profileCanAccess(profile, route)) return false;
  const own = personOverride(settings, personId, 'tabs', `${route}#${tab}`);
  if (own !== undefined) return own;
  const configured = configuredTabRoles(settings, route);
  const granted = settings.tabs?.[route]?.[tab] || [];
  return roleIdsOf(profile).some((id) => {
    if (configured.has(id)) return granted.includes(id);
    const routes = roleRoutes?.(id);
    return routes === undefined || routesOpen(routes, route);
  });
}

/** The tabs of a page this person may see, in page order. */
export function allowedTabs(settings: OpsSettings, profile: MockProfile, personId: string | null | undefined, route: string, roleRoutes?: RoleRoutes): string[] {
  return (GATED_TABS[route] || []).map((t) => t.key).filter((tab) => canSeeTab(settings, profile, personId, route, tab, roleRoutes));
}

/** The tab to show: the one asked for if granted, else the first granted one (null = none). */
export function pickTab(asked: string | null | undefined, allowed: string[]): string | null {
  return asked && allowed.includes(asked) ? asked : allowed[0] ?? null;
}

/** Does this role see this tab (no person override)? Unconfigured roles see all. */
export function roleSeesTab(settings: OpsSettings, roleId: string, route: string, tab: string): boolean {
  if (!configuredTabRoles(settings, route).has(roleId)) return true;
  return (settings.tabs?.[route]?.[tab] || []).includes(roleId);
}

/**
 * Admin ticks / unticks one tab for one role. The first touch writes the role's
 * whole list (starting from "every tab") and marks the role as configured, so
 * the other tabs keep showing. Roles never touched are never written.
 */
export function setRoleTab(settings: OpsSettings, roleId: string, route: string, tab: string, on: boolean): OpsSettings {
  const lists = { ...(settings.tabs?.[route] || {}) };
  const wasConfigured = configuredTabRoles(settings, route).has(roleId);
  for (const t of (GATED_TABS[route] || []).map((x) => x.key)) {
    const cur = lists[t] || [];
    const hasIt = wasConfigured ? cur.includes(roleId) : true;
    const want = t === tab ? on : hasIt;
    lists[t] = want ? [...new Set([...cur, roleId])] : cur.filter((x) => x !== roleId);
  }
  const roles = [...new Set([...(settings.tabRoles?.[route] || []), roleId])];
  return { ...settings, tabs: { ...settings.tabs, [route]: lists }, tabRoles: { ...settings.tabRoles, [route]: roles } };
}

/**
 * Add / Edit / Delete on a module. A Purchase-book module also needs its tab:
 * a hidden tab with Add ticked is still no.
 */
export function canDo(settings: OpsSettings, profile: MockProfile, personId: string | null | undefined, module: ModuleKey, verb: Verb, roleRoutes?: RoleRoutes): boolean {
  if (isAdminProfile(profile)) return true;
  if (!settings.loaded) return false;
  const def = VERB_MODULES.find((m) => m.key === module);
  if (def && !profileCanAccess(profile, def.route)) return false;
  // A hidden Purchase-book tab has no Add, even if Add is ticked.
  if (def?.tab && !canSeeTab(settings, profile, personId, def.route, def.tab, roleRoutes)) return false;
  if (verb === 'edit') return canEditModule(settings, profile, module, personId);
  if (verb === 'delete') return canDeleteModule(settings, profile, module, personId);
  const own = personOverride(settings, personId, 'verbs', `${module}.add`);
  if (own !== undefined) return own;
  const list = settings.modules[module]?.add;
  // undefined = never configured: today's button rules (the screen + any
  // capability the button already checks). [] = Admin only. ids = those roles.
  if (list === undefined) return true;
  return roleAllowed(list, profile);
}

/**
 * Admin ticks / unticks Add for one role. The first touch of a module starts
 * from today's behaviour (every role that can open the screen), so one click
 * never takes Add away from the rest of the floor. Untouched modules stay
 * undefined.
 */
export function setRoleAdd(settings: OpsSettings, roles: { id: string; allowed_routes?: string[] | null }[], module: ModuleKey, roleId: string, on: boolean): OpsSettings {
  const g = settings.modules[module] || { edit: [], delete: [] };
  const def = VERB_MODULES.find((m) => m.key === module);
  const base = g.add ?? (def ? rolesThatCanOpen(roles, def.route) : []);
  const add = on ? [...new Set([...base, roleId])] : base.filter((x) => x !== roleId);
  return { ...settings, modules: { ...settings.modules, [module]: { ...g, add } } };
}

/**
 * Days before today an entry date may go for this module without Management's
 * approval. Per module if set, else the default buffer; a plant's own number
 * (Jharkhand, Sikandrabad…) applies on top — the tighter one wins.
 */
export function backDaysFor(settings: OpsSettings, module: string, plantIds: (string | null | undefined)[] = []): number {
  const own = settings.backDays?.[module];
  const base = typeof own === 'number' ? own : settings.bufferDays;
  const plant = billBufferDays(plantIds, settings.bufferDaysByPlant, base);
  return Math.min(base, plant);
}

/** A person's sidebar routes after their own yes / no. Revokes apply from any copy; grants only once loaded. */
export function applyPersonSections(profile: MockProfile, settings: OpsSettings, personId: string | null | undefined): MockProfile {
  if (!personId || isAdminProfile(profile)) return profile;
  const own = settings.people?.[personId]?.sections;
  if (!own || !Object.keys(own).length) return profile;
  const routes = new Set(profile.allowedDashboardRoutes);
  for (const [route, yes] of Object.entries(own)) {
    if (yes === false) routes.delete(route);
    else if (yes === true && settings.loaded) routes.add(route);
  }
  return { ...profile, allowedDashboardRoutes: [...routes] };
}
