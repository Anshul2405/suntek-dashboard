import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Users, UserCheck, Shield, Settings, Pencil, History as HistoryIcon, Trash2, UserX, UserPlus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchActivePlants } from '../../lib/plants';
import { humanizeError } from '../../lib/errors';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { insertRows, updateRows, callRpc } from '../../lib/db';
import { createLogin, updateLogin, deleteLoginIdentity } from '../../lib/adminUsers';
import { useMentionNotifier } from '../../lib/mentions';
import { useBlacklistGuard } from '../../lib/blacklist/guard';
import { useRoleContext } from '../../contexts/RoleContext';
import { CAPABILITIES, profileHasCapability } from '../../lib/profiles';
import type { RoleRow } from '../../lib/profiles';
import { useStepUp } from '../../lib/useStepUp';
import { logUserAccountEvent, LANGUAGE_OPTIONS } from '../../lib/userEvents';
import { SlidePanel, PanelField, PanelInput, PanelPasswordInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, PanelFooter } from '../../components/SlidePanel';
import { useToast } from '../../components/ui/toast';
import { usePagination } from '../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination, WorkCard } from '../../components/v2';
import { useSortable } from '../../components/ui/useSortable';
import { ThV2 as Th } from '../../components/v2';

interface UserEvent {
  id: string;
  action: string;
  details: string | null;
  actor_name: string | null;
  actor_role: string | null;
  created_at: string;
}

/** A user row for display — a user_accounts row (+ plants join) or a built-in system profile. */
interface DisplayUser {
  id: string;
  name: string;
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
  role_id: string | null;
  role_label: string | null;
  plant_id?: string | null;
  plant_name: string | null;
  plants?: { name: string | null } | null;
  designation: string | null;
  access_note: string | null;
  is_active: boolean;
  created_at: string | null;
  auth_user_id?: string | null;
  login_enabled?: boolean | null;
  preferred_language?: string | null;
  _isSystem?: boolean;
}

// ── Role options ──────────────────────────────────────────────────────────────

type RoleOption = { id: string; label: string; level: string };

// Every dashboard section a role's `allowed_routes` can grant. The union of all
// routes across the seeded roles, with human labels — used by the Role Manager's
// permission checkbox list.
// `label` is the English default; `labelKey` is resolved via t() at render time
// (this list lives outside the component, so it can't call the hook itself).
const ALL_DASHBOARD_SECTIONS: { route: string; label: string; labelKey: string }[] = [
  { route: '/dashboard',                  label: 'Overview',                   labelKey: 'userMgmt.sec_overview' },
  { route: '/dashboard/batches',          label: 'Batch Sheets',               labelKey: 'userMgmt.sec_batchSheets' },
  { route: '/dashboard/stock',            label: 'CPM Stock',                  labelKey: 'userMgmt.sec_cpmStock' },
  { route: '/dashboard/night-manager',    label: 'Night Manager Board',        labelKey: 'userMgmt.sec_nightManagerBoard' },
  { route: '/dashboard/night-entry',      label: 'Night Check-in (entry)',     labelKey: 'userMgmt.sec_nightCheckinEntry' },
  { route: '/dashboard/batch-entry',      label: 'Batch Logger (entry)',       labelKey: 'userMgmt.sec_batchLoggerEntry' },
  { route: '/dashboard/daily-log',        label: 'Daily Unit Log',             labelKey: 'userMgmt.sec_dailyUnitLog' },
  { route: '/dashboard/warehouse-entry',  label: 'Warehouse Console (entry)',  labelKey: 'userMgmt.sec_warehouseConsoleEntry' },
  { route: '/dashboard/sales',            label: 'Sales',                      labelKey: 'userMgmt.sec_sales' },
  { route: '/dashboard/customers',        label: 'Customers',                  labelKey: 'userMgmt.sec_customers' },
  { route: '/dashboard/anomalies',        label: 'Anomaly Detection',          labelKey: 'userMgmt.sec_anomalyDetection' },
  { route: '/dashboard/anomaly-center',   label: 'Anomaly Operations Center',  labelKey: 'userMgmt.sec_anomalyOpsCenter' },
  { route: '/dashboard/cost-intelligence',label: 'Cost & Margin Intelligence', labelKey: 'userMgmt.sec_costMarginIntel' },
  { route: '/dashboard/benchmarking',     label: 'Multi-Plant Benchmarking',   labelKey: 'userMgmt.sec_benchmarking' },
  { route: '/dashboard/predictive-qc',    label: 'Predictive QC',              labelKey: 'userMgmt.sec_predictiveQc' },
  { route: '/dashboard/working-capital',  label: 'Working Capital & Cash',     labelKey: 'userMgmt.sec_workingCapital' },
  { route: '/dashboard/oil-ratio',        label: 'Oil Ratio Reference',        labelKey: 'userMgmt.sec_oilRatio' },
  { route: '/dashboard/audit',            label: 'Audit Trail',                labelKey: 'userMgmt.sec_auditTrail' },
  { route: '/dashboard/blacklist',        label: 'Blacklist Registry',         labelKey: 'userMgmt.sec_blacklistRegistry' },
  { route: '/dashboard/purchase/far',     label: 'Fixed Asset Register',       labelKey: 'userMgmt.sec_fixedAssetRegister' },
  { route: '/dashboard/purchase/qr',      label: 'Asset QR Codes',             labelKey: 'userMgmt.sec_assetQrCodes' },
  { route: '/dashboard/purchase/maint',   label: 'Maintenance',                labelKey: 'userMgmt.sec_maintenance' },
  { route: '/dashboard/purchase/activity',label: 'Activity Log',               labelKey: 'userMgmt.sec_plantActivityLog' },
  { route: '/dashboard/purchase/storereq',label: 'Store Requisitions',         labelKey: 'userMgmt.sec_storeRequisitions' },
  { route: '/dashboard/purchase/purchase',label: 'Purchase Orders',            labelKey: 'userMgmt.sec_purchaseOrders' },
  { route: '/dashboard/purchase/marine',  label: 'Marine Insurance',           labelKey: 'userMgmt.sec_marineInsurance' },
  { route: '/dashboard/purchase/labour',  label: 'Labour Costs',               labelKey: 'userMgmt.sec_labourCosts' },
];

// Fallback only. The real ladder comes from the `tiers` table (see levelOptions
// below) — this list was already stale, missing the top tier entirely, which is
// exactly what hard-coding a hierarchy gets you.
const LEVEL_OPTIONS_FALLBACK = ['L0', 'L1', 'L2', 'L3', 'L4'];

/** Auto-derive a slug id from a role label. */
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Seniority runs L0 (top) → L4 (entry), so the warmest colour is L0.
//
// Tiers are ADMIN-MANAGED DATA: they can be renamed, renumbered or added to, so
// this map can never be exhaustive. Always read it through levelColor(), which
// falls back to a neutral swatch — a missing colour must never take the page
// down. It used to: one unguarded lookup here crashed User Management with
// "undefined is not an object (evaluating 'r.bg')" for any tier the map did not
// know, which is exactly what happened to a build that predated the L0 renumber.
const LEVEL_NEUTRAL = { bg: '#F1F5F9', color: '#64748B' };
const LEVEL_COLOR: Record<string, { bg: string; color: string }> = {
  L0: { bg: '#FEF2F2', color: '#DC2626' },
  L1: { bg: '#FFF7ED', color: '#EA580C' },
  L2: { bg: '#EFF6FF', color: '#2563EB' },
  L3: { bg: '#F0FDF4', color: '#16A34A' },
  L4: { bg: '#F5F3FF', color: '#7C3AED' },
};

/** Swatch for a tier id. Never returns undefined. */
function levelColor(level: string | null | undefined): { bg: string; color: string } {
  return (level && LEVEL_COLOR[level]) || LEVEL_NEUTRAL;
}

// Colours only — the visible label is translated at the render site.
const STATUS_CFG = {
  active:   { label: 'Active',   bg: '#DCFCE7', color: '#16A34A' },
  inactive: { label: 'Inactive', bg: '#F1F5F9', color: '#94A3B8' },
};

function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const BLANK_FORM = {
  name: '', mobile: '', email: '', whatsapp: '',
  // role_id = PRIMARY role (drives display + login); role_ids = full multi-role set.
  // No default role — the admin must pick one, and the first picked becomes primary.
  role_id: '', role_ids: [] as string[],
  plant: '', designation: '',
  access_note: '', is_active: true,
  login_enabled: false, password: '',
  preferred_language: 'en',
  // Data scope (27_plant_unit_scoping.sql): which plants/units this user may see.
  is_global: false,
  plant_ids: [] as string[],
  unit_ids: [] as string[],
  store_ids: [] as string[],
};

// ── Component ─────────────────────────────────────────────────────────────────

/** One row of the Actions dropdown. `tone` colours the destructive and
 *  status-changing entries so Delete is never mistaken for Edit. */
function MenuItem({ icon, label, onClick, tone = 'plain' }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'plain' | 'danger' | 'warn' | 'good';
}) {
  const colour = tone === 'danger' ? '#DC2626' : tone === 'warn' ? '#B45309' : tone === 'good' ? '#16A34A' : '#334155';
  const [hover, setHover] = useState(false);
  return (
    <button
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: hover ? (tone === 'danger' ? '#FEF2F2' : '#F8FAFC') : 'transparent',
        color: colour, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', textAlign: 'left',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      {label}
    </button>
  );
}

/**
 * Turn soft_delete_user()'s tagged exceptions into something an admin can act
 * on. Shown raw they read as Postgres noise — the same problem humanizeError
 * solves elsewhere.
 */
function describeDeleteUserError(message: string): string {
  if (message.includes('missing capability delete_user')) {
    return 'You do not have permission to delete users. This is restricted to administrators.';
  }
  if (message.includes('self_delete')) {
    return 'You cannot delete your own profile.';
  }
  if (message.includes('last_admin')) {
    return 'This is the only administrator left — deleting them would lock everyone out of User Management.';
  }
  if (message.includes('already_deleted')) {
    return 'This user has already been deleted. Refresh the list.';
  }
  if (message.includes('unknown_user')) {
    return 'That user no longer exists. Refresh the list.';
  }
  if (message.includes('not_authenticated')) {
    return 'Your session has expired — sign in again.';
  }
  return message;
}

export function UserManagement() {
  const { t } = useTranslation();
  const toast = useToast();
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const { activeProfile, roles, rolesStatus, refreshRoles, can } = useRoleContext();
  // Store master + factory→store mapping for the store-access picker.
  const { stores, storeIdFor } = usePlantScope();
  const { stepUp, modal: stepUpModal } = useStepUp();
  // Role dropdown options sourced from the live role catalog.
  const roleOptions: RoleOption[] = roles.map(r => ({ id: r.id, label: r.label, level: r.level }));
  const [users, setUsers] = useState<DisplayUser[]>([]);
  const [plants, setPlants] = useState<{ id: string; name: string }[]>([]);
  const [units, setUnits] = useState<{ id: string; plant_id: string; name: string }[]>([]);
  const [tiers, setTiers] = useState<{ id: string; label: string; rank: number }[]>([]);
  const [loading, setLoading] = useState(true);

  const [showPanel, setShowPanel] = useState(false);
  const [editingUser, setEditingUser] = useState<DisplayUser | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });

  // ── Actions menu + delete ─────────────────────────────────────────────────
  // The three buttons (Edit / Deactivate / History) were widening the Actions
  // column past the edge of the table; a fourth would have made it worse. One
  // gear opens all of them and leaves room for whatever comes next.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Viewport coordinates for the open menu. The menu is PORTALLED to
   *  document.body and positioned `fixed`, because the table sits inside a
   *  horizontally scrollable wrapper — an absolutely positioned child cannot
   *  escape an `overflow` ancestor, so the menu was being clipped at the edge of
   *  the card and the lower items were unreachable without scrolling. */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  /** The open menu's element, so the outside-click handler can tell an inside
   *  click from an outside one by containment rather than by event phase. */
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [deleteUser, setDeleteUser] = useState<DisplayUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const canDeleteUser = profileHasCapability(activeProfile, 'delete_user');

  // Close on any outside click or Escape — an open menu must never be something
  // you have to click again to dismiss.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => { setMenuFor(null); setMenuPos(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    /**
     * Outside-click, decided by CONTAINMENT — not by event phase.
     *
     * This was registered on `document` in the CAPTURE phase, which runs before
     * the clicked menu item's own React handler: the menu closed, the portal
     * unmounted, and the click never reached Edit/Deactivate/History/Delete.
     * Clicking any item did nothing at all. `stopPropagation` on the menu could
     * not save it, because capture had already fired.
     *
     * Bubble phase + a containment check is deterministic: the item's handler
     * runs first, and a click inside the menu is recognised and ignored here
     * instead of racing it. Also NOT on mousedown — closing there would unmount
     * the menu before the click could land on the item, the same bug wearing a
     * different hat.
     */
    const onDocClick = (e: MouseEvent) => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      close();
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    // A fixed-position menu is anchored to coordinates captured when it opened,
    // so any scroll would leave it floating away from its row. Close instead of
    // trying to track it — `capture` catches the table's own scroll container,
    // not just the window.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuFor]);

  /** Menu box size, used to decide whether it fits below the gear. Approximate
   *  is fine — it only picks a side; the browser draws the real height. */
  const MENU_W = 186;
  const MENU_H = 200;

  function openActionsMenu(e: React.MouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation();               // or the document close handler fires on this same click
    if (menuFor === id) { setMenuFor(null); setMenuPos(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    // Flip above the gear when there isn't room below — the last row of the
    // table is right at the bottom of the viewport, which is exactly where a
    // downward menu ran off screen.
    const top = (window.innerHeight - r.bottom < MENU_H)
      ? Math.max(8, r.top - MENU_H - 4)
      : r.bottom + 4;
    // Right-aligned to the gear, clamped so it never leaves the viewport.
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    setMenuPos({ top, left });
    setMenuFor(id);
  }

  /** Soft delete. No password step-up — the client asked for the confirmation
   *  dialog NOT to require one; the capability gate and the audit row are the
   *  controls. The RPC refuses self-deletion and the last remaining admin. */
  async function confirmDeleteUser() {
    if (!deleteUser || deleting) return;
    setDeleting(true);
    try {
      const { data, error } = await callRpc<{ ok: boolean }>('soft_delete_user', {
        p_user_id: deleteUser.id, p_actor_name: activeProfile.name,
      });
      if (error) throw new Error(describeDeleteUserError(error.message));
      if (!data?.ok) throw new Error(t('userMgmt.deleteFailed', 'User could not be deleted.'));

      // The directory row is flagged FIRST (above): that is what hides the person
      // and strips their data scope, and it must land even if the auth call then
      // fails. Now destroy the auth identity — without this they stay signed in
      // until their JWT expires, their reset links and OTPs keep working, and
      // their email stays claimed so no replacement account can reuse it.
      if (deleteUser.auth_user_id) {
        const authRes = await deleteLoginIdentity(deleteUser.auth_user_id, deleteUser.id);
        if (authRes.error) {
          // Deliberately not thrown: the profile IS deleted and hidden. But the
          // sign-in was not revoked, and saying so is the difference between an
          // admin knowing to retry and quietly believing access was removed.
          toast.error(t('userMgmt.deleteAuthFailed', {
            defaultValue: 'Profile deleted, but their sign-in could not be revoked ({{msg}}). They may stay logged in until it expires, and their email cannot be reused yet — retry the delete.',
            msg: authRes.error,
          }));
          setDeleteUser(null);
          await loadData();
          return;
        }
      }
      toast.success(t('userMgmt.deleteOk', 'User deleted successfully.'));
      setDeleteUser(null);
      await loadData();           // the list refreshes itself on success
    } catch (e) {
      // On failure the user stays visible and the row is untouched.
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  // History panel — per-profile action log
  const [historyUser, setHistoryUser] = useState<DisplayUser | null>(null);
  const [historyEvents, setHistoryEvents] = useState<UserEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function openHistory(u: DisplayUser) {
    setHistoryUser(u);
    setHistoryLoading(true);
    setHistoryEvents([]);
    const { data } = await supabase
      .from('user_account_events')
      .select('id, action, details, actor_name, actor_role, created_at')
      .eq('user_account_id', u.id)
      .order('created_at', { ascending: false })
      .returns<UserEvent[]>();
    setHistoryEvents(data || []);
    setHistoryLoading(false);
  }

  const actor = { actorName: activeProfile.name, actorRole: activeProfile.id };

  const [filterRole, setFilterRole] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [search, setSearch] = useState('');

  // ── Role Management (admin-only) ──────────────────────────────────────────
  const [showRoleManager, setShowRoleManager] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRow | null>(null); // null + showRoleForm = creating
  const [showRoleForm, setShowRoleForm] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
  const [deletingRoleId, setDeletingRoleId] = useState<string | null>(null);
  const [roleForm, setRoleForm] = useState<{
    label: string; id: string; level: string; home_route: string;
    standalone_only: boolean; allowed_routes: string[]; capabilities: string[];
  }>({ label: '', id: '', level: 'L4', home_route: '/dashboard', standalone_only: false, allowed_routes: [], capabilities: [] });
  // While creating, keep the slug auto-synced to the label until the user edits it.
  const [slugTouched, setSlugTouched] = useState(false);

  function openRoleAdd() {
    setEditingRole(null);
    setSlugTouched(false);
    setRoleForm({ label: '', id: '', level: 'L4', home_route: '/dashboard', standalone_only: false, allowed_routes: [], capabilities: [] });
    setShowRoleForm(true);
  }

  function openRoleEdit(r: RoleRow) {
    if (r.is_admin || r.is_system) return; // locked — full access, not editable
    setEditingRole(r);
    setSlugTouched(true);
    setRoleForm({
      label: r.label,
      id: r.id,
      level: r.level,
      home_route: r.home_route || '/dashboard',
      standalone_only: r.standalone_only,
      allowed_routes: r.allowed_routes?.includes('*') ? [] : (r.allowed_routes || []),
      capabilities: r.capabilities || [],
    });
    setShowRoleForm(true);
  }

  function toggleRoleRoute(route: string) {
    setRoleForm(f => ({
      ...f,
      allowed_routes: f.allowed_routes.includes(route)
        ? f.allowed_routes.filter(x => x !== route)
        : [...f.allowed_routes, route],
    }));
  }

  async function handleSaveRole() {
    const label = roleForm.label.trim();
    if (!label) { toast.error(t('userMgmt.errRoleNameRequired', 'Role name is required')); return; }
    const id = editingRole ? editingRole.id : (slugTouched ? slugify(roleForm.id) : slugify(label));
    if (!id) { toast.error(t('userMgmt.errRoleSlugRequired', 'A valid slug id is required')); return; }
    if (savingRole) return;
    setSavingRole(true);
    try {
      if (!editingRole && roles.some(r => r.id === id)) {
        toast.error(t('userMgmt.errRoleIdExists', { defaultValue: 'A role with id "{{id}}" already exists', id }));
        return;
      }
      const payload = {
        label,
        level: roleForm.level,
        home_route: roleForm.home_route.trim() || '/dashboard',
        allowed_routes: roleForm.allowed_routes,
        standalone_only: roleForm.standalone_only,
        capabilities: roleForm.capabilities,
      };
      if (editingRole) {
        const { error } = await updateRows('roles', payload).eq('id', editingRole.id);
        if (error) { toast.error(t('userMgmt.errSaveFailed', { msg: error.message })); return; }
      } else {
        const { error } = await insertRows('roles', {
          id, ...payload, is_admin: false, is_system: false,
          description: null, avatar_from: null, avatar_to: null,
          sort_order: (roles.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0)) + 1,
        });
        if (error) { toast.error(t('userMgmt.errRoleCreateFailed', { defaultValue: 'Create failed: {{msg}}', msg: error.message })); return; }
      }
      await refreshRoles();
      setShowRoleForm(false);
      setEditingRole(null);
      toast.success(editingRole ? t('userMgmt.roleUpdated', 'Role updated') : t('userMgmt.roleCreated', 'Role created'));
    } finally {
      setSavingRole(false);
    }
  }

  // Grant / revoke one allowance on a ROLE from the person's edit panel.
  // Same step-up as the role editor; writes the role row immediately.
  const [savingRoleCap, setSavingRoleCap] = useState(false);
  async function toggleRoleCapability(role: RoleRow, cap: string, grant: boolean) {
    if (!can('manage_roles') || savingRoleCap) return;
    const ok = await stepUp();
    if (!ok) return;
    setSavingRoleCap(true);
    try {
      const current = role.capabilities || [];
      const capabilities = grant ? [...new Set([...current, cap])] : current.filter(c => c !== cap);
      const { error } = await updateRows('roles', { capabilities }).eq('id', role.id);
      if (error) { toast.error(t('userMgmt.errSaveFailed', { msg: error.message })); return; }
      await refreshRoles();
      window.dispatchEvent(new Event('suntek:roles-changed'));
      toast.success(grant
        ? t('userMgmt.capGrantedOnRole', { defaultValue: 'Granted on role {{role}}', role: role.label })
        : t('userMgmt.capRevokedOnRole', { defaultValue: 'Revoked on role {{role}}', role: role.label }));
    } finally {
      setSavingRoleCap(false);
    }
  }

  async function handleDeleteRole(r: RoleRow) {
    if (r.is_admin || r.is_system) return;
    if (users.some(u => u.role_id === r.id)) {
      toast.error(t('userMgmt.errRoleInUse', { defaultValue: 'Cannot delete "{{label}}" — users are still assigned to it', label: r.label }));
      return;
    }
    if (!window.confirm(t('userMgmt.confirmDeleteRole', { defaultValue: 'Delete role "{{label}}"? This cannot be undone.', label: r.label }))) return;
    setDeletingRoleId(r.id);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('roles') as any).delete().eq('id', r.id);
      if (error) { toast.error(t('userMgmt.errRoleDeleteFailed', { defaultValue: 'Delete failed: {{msg}}', msg: error.message })); return; }
      await refreshRoles();
      toast.success(t('userMgmt.roleDeleted', 'Role deleted'));
    } finally {
      setDeletingRoleId(null);
    }
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    const [usersRes, { data: plantsData }, { data: unitsData }, { data: tiersData }] = await Promise.all([
      // RLS already hides soft-deleted rows (migration 75), so this filter is
      // belt-and-braces — it also makes the intent obvious to the next reader,
      // and keeps the list correct if that policy is ever relaxed.
      supabase.from('user_accounts').select('*, plants(name)').or('is_deleted.is.null,is_deleted.eq.false').order('created_at', { ascending: false }).returns<DisplayUser[]>(),
      fetchActivePlants<{ id: string; name: string }>('id, name'),
      supabase.from('units').select('id, plant_id, name').order('name').returns<{ id: string; plant_id: string; name: string }[]>(),
      supabase.from('tiers').select('id, label, rank').order('rank').returns<{ id: string; label: string; rank: number }[]>(),
    ]);
    // The plants(name) EMBED can fail (e.g. a stale PostgREST relationship after a
    // migration) and silently blank the whole list. Never let the join take down
    // the directory: on error, log it and reload without the join (plant name
    // still shows via the denormalized plant_name column).
    let usersData = usersRes.data;
    if (usersRes.error) {
      console.error('[UserManagement] user_accounts join (plants) failed — falling back to plain select. Error:', usersRes.error);
      const retry = await supabase.from('user_accounts').select('*').order('created_at', { ascending: false }).returns<DisplayUser[]>();
      if (retry.error) console.error('[UserManagement] user_accounts plain select ALSO failed:', retry.error);
      usersData = retry.data;
    }
    setUsers(usersData || []);
    if (plantsData?.length) setPlants(plantsData);
    setUnits(unitsData || []);
    if (tiersData?.length) setTiers(tiersData);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const total = users.length;
  const activeCount = users.filter(u => u.is_active).length;
  const roleBreakdown = roleOptions.map(r => ({
    ...r, count: users.filter(u => u.role_id === r.id).length,
  })).filter(r => r.count > 0);

  const filtered = users.filter(u => {
    if (filterRole !== 'all' && u.role_id !== filterRole) return false;
    if (filterStatus === 'active' && !u.is_active) return false;
    if (filterStatus === 'inactive' && u.is_active) return false;
    if (search) {
      const q = search.toLowerCase();
      return (u.name || '').toLowerCase().includes(q) ||
             (u.mobile || '').includes(q) ||
             (u.email || '').toLowerCase().includes(q) ||
             (u.designation || '').toLowerCase().includes(q);
    }
    return true;
  });
  const usersSort = useSortable(filtered, {
    name: u => u.name,
    mobile: u => u.mobile,
    whatsapp: u => u.whatsapp || u.mobile,
    email: u => u.email,
    role: u => u.role_label || roleOptions.find(r => r.id === u.role_id)?.label || u.role_id,
    level: u => roleOptions.find(r => r.id === u.role_id)?.level,
    plant: u => u.plants?.name || u.plant_name,
    designation: u => u.designation,
    status: u => (u.is_active ? 1 : 0),
    added: u => (u.created_at ? new Date(u.created_at) : null),
  }, { key: 'added', dir: 'desc' });
  const usersPg = usePagination(usersSort.sorted, { resetKey: `${search}|${filterRole}|${filterStatus}|${usersSort.sort.key}|${usersSort.sort.dir}` });

  function openAdd() {
    setEditingUser(null);
    setForm({ ...BLANK_FORM });
    setSaved(false);
    setShowPanel(true);
  }

  async function openEdit(u: any) {
    if (u._isSystem) return;
    setEditingUser(u);
    setForm({
      name: u.name || '',
      mobile: u.mobile || '',
      email: u.email || '',
      whatsapp: u.whatsapp || '',
      role_id: u.role_id && u.role_id !== 'night_manager' ? u.role_id : '',
      role_ids: u.role_id && u.role_id !== 'night_manager' ? [u.role_id] : [],
      plant: u.plants?.name || u.plant_name || '',
      designation: u.designation || '',
      access_note: u.access_note || '',
      is_active: u.is_active ?? true,
      login_enabled: !!u.auth_user_id || !!u.login_enabled,
      password: '',
      preferred_language: u.preferred_language || 'en',
      is_global: !!u.is_global,
      plant_ids: [],
      unit_ids: [],
      store_ids: [],
    });
    setSaved(false);
    setShowPanel(true);
    // Load this user's plant/unit memberships + roles for the pickers.
    const [{ data: ups }, { data: uus }, { data: urs }, ussRes] = await Promise.all([
      supabase.from('user_plants').select('plant_id').eq('user_account_id', u.id).returns<{ plant_id: string }[]>(),
      supabase.from('user_units').select('unit_id').eq('user_account_id', u.id).returns<{ unit_id: string }[]>(),
      supabase.from('user_roles').select('role_id').eq('user_account_id', u.id).returns<{ role_id: string }[]>(),
      // Absent before migration 59 — resolves with an error rather than throwing.
      supabase.from('user_stores').select('store_id').eq('user_account_id', u.id).returns<{ store_id: string }[]>(),
    ]);
    const uss = ussRes.data;
    // Keep the primary role first so it stays the display/login role. Drop the
    // retired night_manager role so it never re-appears as a selectable/primary role.
    const roleIds = (urs || []).map(r => r.role_id).filter(id => id !== 'night_manager');
    const primary = u.role_id && u.role_id !== 'night_manager' ? u.role_id : '';
    const ordered = primary ? [primary, ...roleIds.filter(id => id !== primary)] : roleIds;
    setForm(f => ({
      ...f,
      plant_ids: (ups || []).map(r => r.plant_id),
      unit_ids: (uus || []).map(r => r.unit_id),
      store_ids: (uss || []).map(r => r.store_id),
      role_ids: ordered.length ? ordered : f.role_ids,
      role_id: ordered[0] || '',
    }));
  }

  async function handleSave() {
    // A user needs a name and at least one contact identifier (email or phone).
    if (!form.name.trim() || (!form.email.trim() && !form.mobile.trim())) return;
    if (!form.role_ids.length) { toast.error(t('userMgmt.errSelectRole', 'Select at least one role')); return; }

    const existingAuthId = editingUser?.auth_user_id || null;
    // A brand-new login is being provisioned when login is enabled but no auth
    // user is linked yet (new user, or enabling login on an existing directory row).
    const provisioningNewLogin = form.login_enabled && !existingAuthId;
    if (provisioningNewLogin) {
      // Login can be by email OR phone — need at least one so the user can be found.
      if (!form.email.trim() && !form.mobile.trim()) { toast.error(t('userMgmt.errLoginIdentifierRequired')); return; }
      if (form.password.length < 8) { toast.error(t('userMgmt.errPasswordMin')); return; }
    }

    // Provisioning a login hits the admin edge function, which requires a REAL
    // admin session. Guard up-front so we never create a half-user (directory row
    // saved, login failed) when there's no session — e.g. the dev "enter
    // dashboard" bypass or an expired token.
    if (form.login_enabled) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error(t('userMgmt.errNoSessionForLogin')); return; }
    }

    // Primary plant (for the legacy plant_id/plant_name display columns) = the
    // first selected plant. The full set lives in user_plants (synced below).
    const primaryPlantId = form.is_global ? null : (form.plant_ids[0] || null);
    const primaryPlant = plants.find(p => p.id === primaryPlantId);
    const plant = plants.find(p => p.id === primaryPlantId); // for edge-fn login link
    const email = form.email.trim() || null;
    const payload = {
      name: form.name.trim(),
      mobile: form.mobile.trim(),
      email,
      whatsapp: form.whatsapp.trim() || null,
      role_id: form.role_id,
      role_label: roleOptions.find(r => r.id === form.role_id)?.label || form.role_id,
      plant_id: primaryPlantId,
      plant_name: primaryPlant?.name || null,
      designation: form.designation.trim() || null,
      access_note: form.access_note.trim() || null,
      is_active: form.is_active,
      is_global: form.is_global,
      preferred_language: form.preferred_language || 'en',
    };

    // 1) Save the directory row first (and capture its id for credential linking).
    let accountId = editingUser?.id || '';
    if (editingUser) {
      const { error } = await updateRows('user_accounts', payload).eq('id', editingUser.id);
      if (error) { toast.error(t('userMgmt.errUpdateFailed', { msg: error.message })); return; }
    } else {
      const { data, error } = await insertRows('user_accounts', payload).select('id').single();
      if (error) {
        const dupMobile = /duplicate|unique/i.test(error.message) && /mobile/i.test(error.message);
        toast.error(dupMobile ? t('userMgmt.errDuplicateMobile') : t('userMgmt.errSaveFailed', { msg: error.message }));
        return;
      }
      accountId = data?.id || '';
    }

    // 2) Provision / update the login via the service_role edge function.
    if (form.login_enabled) {
      if (existingAuthId) {
        const { error } = await updateLogin({
          auth_user_id: existingAuthId,
          user_account_id: accountId,
          email: email || undefined,
          password: form.password || undefined, // blank = keep current password
          name: form.name.trim(),
          role_id: form.role_id,
          plant_id: plant?.id || null,
        });
        if (error) {
          toast.error(humanizeError(error, { action: 'update this login', context: 'UserManagement.updateLogin' }));
          return;
        }
      } else {
        const { error } = await createLogin({
          user_account_id: accountId,
          email: email ?? undefined, // omit → phone-only login (synthetic auth email)
          password: form.password,
          name: form.name.trim(),
          role_id: form.role_id,
          plant_id: plant?.id || null,
        });
        if (error) {
          // Login provisioning failed. If we just inserted a brand-new directory
          // row for this user, roll it back so no half-created (login-disabled)
          // account is left behind — otherwise a retry hits the unique-phone
          // constraint and throws a confusing duplicate error.
          if (!editingUser && accountId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase.from('user_accounts') as any).delete().eq('id', accountId);
          }
          toast.error(humanizeError(error, { action: 'create this login', context: 'UserManagement.createLogin' }));
          return;
        }
      }
    }

    // 3) Sync plant/unit scope memberships (source of truth for data isolation).
    //    Replace-all: clear existing, then insert the current selection. A global
    //    user needs no memberships (they see everything).
    if (accountId) {
      // Role memberships (multi-role). Primary role_id is already on the row.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: delRolesErr } = await (supabase.from('user_roles') as any).delete().eq('user_account_id', accountId);
      if (delRolesErr) {
        toast.error(t('userMgmt.errRolesSync', { defaultValue: 'Could not update roles: {{msg}}', msg: delRolesErr.message }));
        return;
      }
      const roleIds = form.role_ids.length ? form.role_ids : (form.role_id ? [form.role_id] : []);
      if (roleIds.length) {
        const { error: insRolesErr } = await insertRows('user_roles', roleIds.map(rid => ({ user_account_id: accountId, role_id: rid })));
        if (insRolesErr) {
          toast.error(t('userMgmt.errRolesSync', { defaultValue: 'Could not update roles: {{msg}}', msg: insRolesErr.message }));
          return;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('user_plants') as any).delete().eq('user_account_id', accountId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('user_units') as any).delete().eq('user_account_id', accountId);
      // Store grants are rewritten the same way. Safe before migration 59 —
      // the table simply does not exist and the call resolves with an error.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('user_stores') as any).delete().eq('user_account_id', accountId);
      if (!form.is_global) {
        if (form.plant_ids.length) {
          await insertRows('user_plants', form.plant_ids.map(pid => ({ user_account_id: accountId, plant_id: pid })));
        }
        // Keep only units that belong to a selected plant.
        const validUnitIds = form.unit_ids.filter(uid => {
          const u = units.find(x => x.id === uid);
          return u && form.plant_ids.includes(u.plant_id);
        });
        if (validUnitIds.length) {
          await insertRows('user_units', validUnitIds.map(uid => ({ user_account_id: accountId, unit_id: uid })));
        }
        // Store access is stored as its own grant — NOT derived from the
        // factories above. That separation is the whole point: a shared-store
        // keeper can issue for three factories without gaining their FARs.
        if (form.store_ids.length) {
          await insertRows('user_stores', form.store_ids.map(sid => ({ user_account_id: accountId, store_id: sid })));
        }
      }
    }

    // Record the admin action in the profile history.
    if (editingUser) {
      const changed: string[] = [];
      if (form.name.trim() !== (editingUser.name || '')) changed.push('name');
      if (email !== (editingUser.email || null)) changed.push('email');
      if (form.mobile.trim() !== (editingUser.mobile || '')) changed.push('contact');
      if (form.role_id !== editingUser.role_id) changed.push('role');
      if ((form.preferred_language || 'en') !== (editingUser.preferred_language || 'en')) changed.push('language');
      if (form.login_enabled && form.password) changed.push('password reset');
      await logUserAccountEvent({
        userAccountId: accountId, targetName: form.name.trim(), targetEmail: email,
        action: form.login_enabled && form.password ? 'password_reset' : 'admin_update',
        details: changed.length ? `Admin updated: ${changed.join(', ')}` : 'Admin saved (no field changes)',
        ...actor,
      });
    } else {
      await logUserAccountEvent({
        userAccountId: accountId, targetName: form.name.trim(), targetEmail: email,
        action: 'created',
        details: `Created${form.login_enabled ? ' with login' : ' (directory only)'} · role ${roleOptions.find(r => r.id === form.role_id)?.label || form.role_id}`,
        ...actor,
      });
    }

    await notifyMentions(form.access_note, {
      entityType: 'user_account', entityId: editingUser?.id,
      entityLabel: t('userMgmt.entityLabel', { defaultValue: 'User · {{name}}', name: form.name.trim() }), route: '/dashboard/users',
    });
    const hits = await screenBlacklist(
      [{ value: form.name, label: t('userMgmt.colName') }, { value: form.designation, label: t('userMgmt.colDesignation') }],
      { workflow: 'User Management', source: 'entry', entityLabel: t('userMgmt.entityLabel', { defaultValue: 'User · {{name}}', name: form.name.trim() }) },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('userMgmt.blacklistHit', { defaultValue: '⚠ "{{value}}" ≈ blacklisted {{type}} "{{name}}" ({{pct}}%). Admin notified.', value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }
    setSaved(true);
    await loadData();
    setTimeout(() => {
      setShowPanel(false);
      setSaved(false);
      setForm({ ...BLANK_FORM });
      setEditingUser(null);
    }, 1400);
  }

  async function toggleStatus(u: DisplayUser) {
    if (u._isSystem) return;
    await updateRows('user_accounts', { is_active: !u.is_active }).eq('id', u.id);
    await loadData();
  }

  const selectedRole = roles.find(r => r.id === form.role_id);
  // Combined access preview — what the person will actually see after login.
  // The green card used to show ONLY the primary role, which made multi-role
  // grants look like they hadn't stuck (e.g. Store Manager + Purchase Manager
  // only listed "Procurement bills" even though Store Req was checked).
  const selectedRoles = useMemo(
    () => form.role_ids.map(id => roles.find(r => r.id === id)).filter((r): r is RoleRow => !!r),
    [form.role_ids, roles],
  );
  const unionRoutes = useMemo(() => {
    if (selectedRoles.some(r => r.allowed_routes?.includes('*'))) return ['*'] as string[];
    return [...new Set(selectedRoles.flatMap(r => r.allowed_routes ?? []))];
  }, [selectedRoles]);
  const unionSections = useMemo(
    () => ALL_DASHBOARD_SECTIONS.filter(s => unionRoutes.includes('*') || unionRoutes.includes(s.route)),
    [unionRoutes],
  );

  // Roles the current user may ASSIGN. Admins (manage_roles) can assign any role;
  // a delegate (manage_users only) can assign only roles at/below their own tier
  // that grant no capability they lack — so they can't escalate anyone above
  // themselves. Enforced again server-side by the admin-users edge function.
  const myRank = tiers.find(t => t.id === activeProfile.role)?.rank ?? Number.MAX_SAFE_INTEGER;
  const assignableRoles = roles.filter(r => {
    if (can('manage_roles')) return true;
    if (r.is_admin) return false;
    const rRank = tiers.find(t => t.id === r.level)?.rank ?? 0;
    if (rRank > myRank) return false;
    return (r.capabilities || []).every(c => (activeProfile.capabilities || []).includes(c));
  });

  return (
    <>
      {/* KPI row — same format as the Overview "Today's Work" cards */}
      <div className="grid grid-cols-12 gap-5 mb-5">
        <WorkCard
          className="col-span-12 lg:col-span-3"
          icon={<Users />}
          label={t('userMgmt.totalUsers')}
          value={total}
          caption={t('userMgmt.allRolesSub')}
        />
        <WorkCard
          className="col-span-12 lg:col-span-3"
          icon={<UserCheck />}
          label={t('userMgmt.active')}
          value={activeCount}
          caption={t('userMgmt.inactiveCount', { count: total - activeCount })}
        />
        <WorkCard className="col-span-12 lg:col-span-6" icon={<Shield />} label={<span className="inline-block mb-2">{t('userMgmt.byRole')}</span>}>
          <div className="flex flex-wrap gap-2">
            {roleBreakdown.length === 0 && <div className="text-[11px] text-slate-400">{t('userMgmt.noUsersYet')}</div>}
            {roleBreakdown.map(r => (
              <span key={r.id} className="badge bg-slate-100 text-slate-600" style={{ fontSize: 10.5 }}>
                {r.label} · {r.count}
              </span>
            ))}
          </div>
        </WorkCard>
      </div>

      {/* User table */}
      <div className="card2 p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <div className="text-base font-bold font-heading">{t('userMgmt.userAccounts')}</div>
            <div className="text-xs text-slate-500">{t('userMgmt.userAccountsSub')}</div>
          </div>
          <div className="flex gap-2">
            {can('manage_roles') && (
              <button
                className="pill px-4 py-2 font-semibold text-sm"
                style={{ border: '1.5px solid #E2E8F0', background: '#fff', color: '#475569', cursor: 'pointer' }}
                onClick={() => setShowRoleManager(true)}
              >
                ⚙ {t('userMgmt.manageRoles', 'Manage Roles')}
              </button>
            )}
            {can('manage_users') && (
              <button className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm" onClick={openAdd}>
                + {t('userMgmt.addUser')}
              </button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4 flex-wrap">
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('userMgmt.searchPlaceholder')}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, outline: 'none', fontFamily: 'inherit', minWidth: 220 }}
          />
          <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="all">{t('userMgmt.allRoles')}</option>
            {roleOptions.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="all">{t('userMgmt.allStatus')}</option>
            <option value="active">{t('userMgmt.active')}</option>
            <option value="inactive">{t('userMgmt.inactive')}</option>
          </select>
        </div>

        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <Th sortKey="name" s={usersSort}>{t('userMgmt.colName')}</Th>
                <Th sortKey="mobile" s={usersSort}>{t('userMgmt.colMobile')}</Th>
                <Th sortKey="whatsapp" s={usersSort}>{t('userMgmt.colWhatsApp')}</Th>
                <Th sortKey="email" s={usersSort}>{t('userMgmt.colEmail')}</Th>
                <Th sortKey="role" s={usersSort}>{t('userMgmt.colRole')}</Th>
                <Th sortKey="level" s={usersSort}>{t('userMgmt.colLevel')}</Th>
                <Th sortKey="plant" s={usersSort}>{t('userMgmt.colPlant')}</Th>
                <Th sortKey="designation" s={usersSort}>{t('userMgmt.colDesignation')}</Th>
                <Th sortKey="status" s={usersSort}>{t('userMgmt.colStatus')}</Th>
                <Th sortKey="added" s={usersSort} firstDir="desc">{t('userMgmt.colAdded')}</Th>
                <th>{t('userMgmt.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={11} className="text-center text-slate-400 py-6 text-sm">{t('userMgmt.loading')}</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={11} className="text-center text-slate-400 py-6 text-sm">
                  {total === 0 ? t('userMgmt.emptyNoUsers') : t('userMgmt.emptyNoMatch')}
                </td></tr>
              )}
              {usersPg.pageRows.map(u => {
                const ro = roleOptions.find(r => r.id === u.role_id);
                const lvl = levelColor(ro?.level);
                const sc = u.is_active ? STATUS_CFG.active : STATUS_CFG.inactive;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-slate-800">{u.name}</div>
                        {u._isSystem && (
                          <span className="badge" style={{ background: '#F1F5F9', color: '#94A3B8', fontSize: 10, padding: '1px 6px' }}>{t('userMgmt.builtIn')}</span>
                        )}
                      </div>
                      {u.designation && <div className="text-[11px] text-slate-400">{u.designation}</div>}
                    </td>
                    <td>
                      {u.mobile
                        ? <a href={`tel:${u.mobile}`} className="text-slate-700 hover:text-blue-600 text-sm">{u.mobile}</a>
                        : <span className="text-slate-300 text-sm">—</span>}
                    </td>
                    <td className="text-slate-500 text-xs">{u.whatsapp || u.mobile || <span className="text-slate-300">—</span>}</td>
                    <td className="text-slate-500 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span>{u.email || <span className="text-slate-300">—</span>}</span>
                        {!u._isSystem && u.auth_user_id && (
                          <span className="badge" style={{ background: '#EFF6FF', color: '#2563EB', fontSize: 9.5, padding: '1px 6px' }}>🔑 {t('userMgmt.login')}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ background: lvl.bg, color: lvl.color, fontSize: 11 }}>
                        {u.role_label || ro?.label || u.role_id}
                      </span>
                    </td>
                    <td>
                      <span className="badge" style={{ background: lvl.bg, color: lvl.color, fontSize: 11 }}>
                        {ro?.level || '—'}
                      </span>
                    </td>
                    <td className="text-slate-500 text-xs">{u.plants?.name || u.plant_name || <span className="text-slate-300">—</span>}</td>
                    <td className="text-slate-500 text-xs">{u.designation || <span className="text-slate-300">—</span>}</td>
                    <td>
                      <span className="badge" style={{ background: sc.bg, color: sc.color, fontWeight: 700 }}>{u.is_active ? t('userMgmt.active') : t('userMgmt.inactive')}</span>
                    </td>
                    <td className="text-slate-400 text-xs">{u._isSystem ? <span className="text-slate-300">—</span> : formatDate(u.created_at)}</td>
                    <td>
                      {u._isSystem ? (
                        <span className="text-[11px] text-slate-400 italic">{t('userMgmt.systemProfile')}</span>
                      ) : (
                        <button
                          aria-label={t('userMgmt.actions', 'Actions')}
                          aria-haspopup="menu"
                          aria-expanded={menuFor === u.id}
                          title={t('userMgmt.actions', 'Actions')}
                          onClick={e => openActionsMenu(e, u.id)}
                          style={{ padding: 6, borderRadius: 9, border: '1px solid #E2E8F0', background: menuFor === u.id ? '#F1F5F9' : '#fff', cursor: 'pointer', color: '#475569', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Settings size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TablePagination controls={usersPg.controls} />
        </div>
      </div>

      {/* ── Slide panel: Add / Edit user ────────────────────────────────────── */}
      <SlidePanel
        open={showPanel}
        onClose={() => { setShowPanel(false); setSaved(false); setEditingUser(null); }}
        title={editingUser ? t('userMgmt.editUser') : t('userMgmt.addUser')}
        subtitle={t('userMgmt.panelSubtitle')}
      >
        {/* Name + Mobile */}
        <PanelRow>
          <PanelField label={t('userMgmt.fullName')}>
            <PanelInput value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('userMgmt.fullNamePlaceholder')} />
          </PanelField>
          <PanelField label={t('userMgmt.mobileNumber')}>
            <PanelInput type="tel" value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} placeholder={t('userMgmt.mobilePlaceholder')} />
          </PanelField>
        </PanelRow>

        {/* WhatsApp + Email */}
        <PanelRow>
          <PanelField label={t('userMgmt.whatsappLabel')}>
            <PanelInput type="tel" value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} placeholder={t('userMgmt.whatsappPlaceholder')} />
          </PanelField>
          <PanelField label={t('userMgmt.emailLabel')}>
            <PanelInput type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder={t('userMgmt.emailPlaceholder')} />
          </PanelField>
        </PanelRow>
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: -8, marginBottom: 14 }}>
          {t('userMgmt.contactHint')}
        </div>

        {/* Role(s) — multi-select. First selected is the primary (display + login). */}
        <PanelField label={t('userMgmt.rolesLabel', 'Role(s)')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto', padding: 4, border: '1px solid #E2E8F0', borderRadius: 10 }}>
            {assignableRoles.map(r => {
              const on = form.role_ids.includes(r.id);
              const isPrimary = form.role_ids[0] === r.id;
              return (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, background: on ? '#EFF6FF' : 'transparent' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setForm(f => {
                      const role_ids = on ? f.role_ids.filter(x => x !== r.id) : [...f.role_ids, r.id];
                      return { ...f, role_ids, role_id: role_ids[0] || '' };
                    })}
                  />
                  <span style={{ flex: 1 }}>{r.level} · {r.label}</span>
                  {on && isPrimary && <span className="badge" style={{ background: '#EFF6FF', color: '#2563EB', fontSize: 9.5, padding: '1px 6px' }}>{t('userMgmt.primary', 'primary')}</span>}
                  {on && !isPrimary && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setForm(f => {
                          const role_ids = [r.id, ...f.role_ids.filter(x => x !== r.id)];
                          return { ...f, role_ids, role_id: r.id };
                        });
                      }}
                      style={{ fontSize: 10, fontWeight: 700, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >
                      {t('userMgmt.makePrimary', 'Make primary')}
                    </button>
                  )}
                </label>
              );
            })}
            {assignableRoles.length === 0 && <div style={{ fontSize: 11, color: '#94A3B8', padding: 6 }}>{t('userMgmt.noAssignableRoles', 'No roles you can assign.')}</div>}
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{t('userMgmt.rolesHint', 'First selected = primary (drives display + login). Access = the union of all selected.')}</div>
        </PanelField>

        {/* Schedule Setup (A6). Granted here, on the person, because that is
            where the admin is looking — but SAVED ON THEIR PRIMARY ROLE, the
            single source of truth for capabilities. Everyone on that role gets
            it, which the hint says out loud. */}
        {editingUser && form.role_id && can('manage_roles') && (() => {
          const role = roles.find(r => r.id === form.role_id);
          if (!role || role.is_admin) return null;
          const on = (role.capabilities || []).includes('manage_schedules');
          return (
            <PanelField label={t('userMgmt.scheduleSetupAccess', 'Schedule Setup access')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${on ? '#FDBA74' : '#E2E8F0'}`, background: on ? '#FFF7ED' : '#F8FAFC' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A' }}>{on ? '✓ ' : '🔒 '}{t('userMgmt.capManageSchedules', 'Add or delete schedule setup')}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>
                    {t('userMgmt.capManageSchedulesHint', { defaultValue: 'Saved on the role "{{role}}" — everyone with that role gets the Schedule Setup tab.', role: role.label })}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="toggle-manage-schedules"
                  aria-pressed={on}
                  disabled={savingRoleCap}
                  title={on ? t('userMgmt.revokeRequiresPassword', 'Revoke (requires password)') : t('userMgmt.grantRequiresPassword', 'Grant (requires password)')}
                  onClick={() => toggleRoleCapability(role, 'manage_schedules', !on)}
                  style={{ width: 44, height: 24, borderRadius: 12, background: on ? '#EA580C' : '#CBD5E1', border: 'none', cursor: savingRoleCap ? 'wait' : 'pointer', position: 'relative', flexShrink: 0 }}
                >
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left 0.2s', left: on ? 22 : 4 }} />
                </button>
              </div>
            </PanelField>
          );
        })()}

        {/* Combined access — union of every selected role, not just the primary. */}
        {selectedRoles.length > 0 && (
          <div style={{ marginBottom: 16, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#15803D', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {selectedRole
                ? `${selectedRole.level} · ${selectedRole.label}${selectedRoles.length > 1 ? ` + ${selectedRoles.length - 1} more` : ''}`
                : t('userMgmt.combinedAccess', 'Combined access')}
            </div>
            {selectedRoles.length > 1 && (
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>
                {t('userMgmt.rolesUnionHint', {
                  defaultValue: 'Primary: {{primary}}. Also: {{others}}. Menu = all of these combined.',
                  primary: selectedRole?.label || '—',
                  others: selectedRoles.filter(r => r.id !== form.role_id).map(r => r.label).join(', '),
                })}
              </div>
            )}
            {selectedRoles.length === 1 && (
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>
                {selectedRole?.description || t('userMgmt.customAccess', 'Custom access')}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
              {unionSections.length === 0 && (
                <span style={{ fontSize: 11, color: '#94A3B8' }}>{t('userMgmt.noSections', 'No dashboard sections on these roles.')}</span>
              )}
              {unionSections.map(s => (
                <span key={s.route} style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#DCFCE7', color: '#166534' }}>
                  {t(s.labelKey, s.label)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Designation */}
        <PanelField label={t('userMgmt.designationLabel')}>
          <PanelInput value={form.designation} onChange={e => setForm(f => ({ ...f, designation: e.target.value }))} placeholder={t('userMgmt.designationPlaceholder')} />
        </PanelField>

        {/* ── Data scope: which plants / units this user may see ─────────────── */}
        <div style={{ marginBottom: 16, background: '#F8FAFC', borderRadius: 12, border: '1px solid #E2E8F0', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{t('userMgmt.dataScope')}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{t('userMgmt.dataScopeHelper')}</div>
            </div>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, is_global: !f.is_global }))}
              title={t('userMgmt.allPlantsToggle')}
              style={{ width: 44, height: 24, borderRadius: 12, background: form.is_global ? '#2563EB' : '#CBD5E1', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
            >
              <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left 0.2s', left: form.is_global ? 22 : 4 }} />
            </button>
          </div>

          {form.is_global ? (
            <div style={{ fontSize: 11, color: '#2563EB', marginTop: 8, fontWeight: 600 }}>{t('userMgmt.allPlantsOn')}</div>
          ) : (
            <>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '12px 0 6px' }}>{t('userMgmt.plantsLabel')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {plants.map(p => {
                  const on = form.plant_ids.includes(p.id);
                  return (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, background: on ? '#EFF6FF' : '#fff', border: '1px solid #E2E8F0' }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setForm(f => {
                          const plant_ids = on ? f.plant_ids.filter(x => x !== p.id) : [...f.plant_ids, p.id];
                          // Drop any selected units whose plant is no longer selected.
                          const unit_ids = f.unit_ids.filter(uid => { const u = units.find(x => x.id === uid); return u && plant_ids.includes(u.plant_id); });
                          return { ...f, plant_ids, unit_ids };
                        })}
                      />
                      <span>{p.name}</span>
                    </label>
                  );
                })}
                {plants.length === 0 && <div style={{ fontSize: 11, color: '#94A3B8' }}>{t('userMgmt.noPlants')}</div>}
              </div>

              {/* No per-unit narrowing.
                  Chlorides and Plasticiser existed as sub-units of a single
                  'Rehla' plant. They are now separate factories (SCPL – Rehla
                  is chlorides, SPPL – Rehla is plasticiser), so factory access
                  already expresses what unit access used to. `units` and
                  user_units stay in the schema so historical tickets keep
                  resolving; they are simply no longer assignable. */}

              {/* ── Store access — a SEPARATE grant ─────────────────────────
                  Deliberately not derived from the factories above. A Rehla
                  store keeper serves SCPL, SPPL and SPPL(K) from one shared
                  register, but must NOT thereby gain their asset registers —
                  so store access is ticked here on its own.
                  Selecting no store still leaves the user reaching the store
                  of any factory they belong to, which is how every
                  one-factory-one-store site has always behaved. */}
              {stores.length > 0 && (
                <>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '12px 0 4px' }}>{t('userMgmt.storesLabel', 'Store access')}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 6 }}>
                    {t('userMgmt.storesHelper', 'Extra stores this user may issue from — e.g. a shared store serving several factories. Does NOT grant access to those factories\u2019 assets or maintenance.')}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {stores.map(st => {
                      const on = form.store_ids.includes(st.id);
                      // Reachable anyway through a selected factory — shown so
                      // the admin can see it is already covered.
                      const viaPlant = !on && form.plant_ids.some(pid => storeIdFor(pid) === st.id);
                      return (
                        <label key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, background: on ? '#EFF6FF' : '#fff', border: '1px solid #E2E8F0' }}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setForm(f => ({ ...f, store_ids: on ? f.store_ids.filter(x => x !== st.id) : [...f.store_ids, st.id] }))}
                          />
                          <span>{st.name}</span>
                          {viaPlant && <span style={{ fontSize: 10, color: '#94A3B8' }}>{t('userMgmt.storeViaFactory', '· via factory')}</span>}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Preferred language */}
        <PanelField label={t('userMgmt.preferredLanguage')}>
          <PanelSelect value={form.preferred_language} onChange={e => setForm(f => ({ ...f, preferred_language: e.target.value }))}>
            {LANGUAGE_OPTIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </PanelSelect>
        </PanelField>

        {/* Access note */}
        <PanelField label={t('userMgmt.accessNoteLabel')}>
          <PanelTextarea value={form.access_note} onChange={e => setForm(f => ({ ...f, access_note: e.target.value }))} placeholder={t('userMgmt.accessNotePlaceholder')} />
        </PanelField>

        {/* ── Login access ─────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 16, background: '#F8FAFC', borderRadius: 12, border: '1px solid #E2E8F0', padding: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
                {t('userMgmt.dashboardLogin')} {editingUser?.auth_user_id && <span style={{ fontSize: 11, color: '#16A34A', fontWeight: 700 }}>{t('userMgmt.accountExists')}</span>}
              </div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>
                {t('userMgmt.loginHelper')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, login_enabled: !f.login_enabled }))}
              style={{
                width: 44, height: 24, borderRadius: 12,
                background: form.login_enabled ? '#2563EB' : '#CBD5E1',
                border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
              }}
            >
              <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left 0.2s', left: form.login_enabled ? 22 : 4 }} />
            </button>
          </div>

          {form.login_enabled && (
            <div style={{ marginTop: 12 }}>
              {!form.email.trim() && !form.mobile.trim() && (
                <div style={{ fontSize: 11, color: '#DC2626', marginBottom: 8 }}>
                  {t('userMgmt.setLoginIdentifierWarn')}
                </div>
              )}
              <PanelField label={editingUser?.auth_user_id ? t('userMgmt.setNewPassword') : t('userMgmt.passwordLabel')}>
                <PanelPasswordInput
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editingUser?.auth_user_id ? t('userMgmt.passwordKeepPlaceholder') : t('userMgmt.passwordNewPlaceholder')}
                />
              </PanelField>
              <div style={{ fontSize: 11, color: '#94A3B8' }}>
                {t('userMgmt.accountActivatedHelper')}
              </div>
            </div>
          )}
        </div>

        {/* Active toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '12px 14px', background: '#F8FAFC', borderRadius: 12, border: '1px solid #E2E8F0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{t('userMgmt.accountActive')}</div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{t('userMgmt.accountActiveHelper')}</div>
          </div>
          <button
            onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
            style={{
              width: 44, height: 24, borderRadius: 12,
              background: form.is_active ? '#16A34A' : '#CBD5E1',
              border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
            }}
          >
            <div style={{
              width: 18, height: 18, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 3, transition: 'left 0.2s',
              left: form.is_active ? 22 : 4,
            }} />
          </button>
        </div>

        <PanelDivider />
        <PanelFooter
          saved={saved}
          onCancel={() => { setShowPanel(false); setEditingUser(null); }}
          onSave={handleSave}
          saveLabel={editingUser ? t('userMgmt.saveChanges') : t('userMgmt.addUser')}
          successLabel={editingUser ? t('userMgmt.userUpdated') : t('userMgmt.userAdded')}
          successSub={editingUser ? t('userMgmt.userUpdatedSub') : t('userMgmt.userAddedSub')}
          disabled={!form.name.trim() || (!form.email.trim() && !form.mobile.trim())}
          requiredHint={t('userMgmt.requiredHint')}
        />
      </SlidePanel>

      {/* ── Actions menu ──────────────────────────────────────────────────────
          Rendered through a PORTAL onto document.body. Kept inside the table
          cell it was clipped by the horizontally scrollable wrapper, so the
          lower items (History, Delete) were cut off and unreachable. A portal
          plus fixed positioning escapes every overflow ancestor. */}
      {menuFor && menuPos && (() => {
        const u = usersPg.pageRows.find(r => r.id === menuFor);
        if (!u) return null;
        return createPortal(
          <div
            role="menu"
            ref={menuRef}
            style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: MENU_W, zIndex: 1200, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, boxShadow: '0 12px 32px rgba(15,23,42,0.18)', padding: 5 }}
          >
            <MenuItem icon={<Pencil size={13} />} label={t('userMgmt.edit')}
              onClick={() => { setMenuFor(null); openEdit(u); }} />
            <MenuItem
              icon={u.is_active ? <UserX size={13} /> : <UserPlus size={13} />}
              label={u.is_active ? t('userMgmt.deactivate') : t('userMgmt.activate')}
              tone={u.is_active ? 'warn' : 'good'}
              onClick={() => { setMenuFor(null); toggleStatus(u); }} />
            <MenuItem icon={<HistoryIcon size={13} />} label={t('userMgmt.history')}
              onClick={() => { setMenuFor(null); openHistory(u); }} />
            {canDeleteUser && (
              <>
                <div style={{ height: 1, background: '#F1F5F9', margin: '4px 2px' }} />
                <MenuItem icon={<Trash2 size={13} />} label={t('userMgmt.delete', 'Delete')} tone="danger"
                  onClick={() => { setMenuFor(null); setDeleteUser(u); }} />
              </>
            )}
          </div>,
          document.body,
        );
      })()}

      {/* ── Delete confirmation ──────────────────────────────────────────────
          Deliberately NO password step-up: the client asked for this dialog not
          to require one. The capability gate, the RPC's self-delete and
          last-admin guards, and the audit row are the controls instead. */}
      {deleteUser && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
          onClick={() => !deleting && setDeleteUser(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 440, background: '#fff', borderRadius: 16, border: '1px solid #E2E8F0', boxShadow: '0 24px 60px rgba(0,0,0,0.28)', padding: 22 }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ width: 38, height: 38, borderRadius: '50%', background: '#FEE2E2', color: '#DC2626', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Trash2 size={18} />
              </span>
              <div>
                <div className="font-heading font-semibold" style={{ fontSize: 17 }}>
                  {t('userMgmt.deleteTitle', 'Delete this user?')}
                </div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>
                  {deleteUser.name}{deleteUser.email ? ` · ${deleteUser.email}` : ''}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 14, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: '12px 14px', fontSize: 13.5, lineHeight: 1.5, color: '#7F1D1D' }}>
              {t('userMgmt.deleteBody', 'You are about to delete this user profile. The user will no longer appear in the User Management interface. Do you want to continue?')}
            </div>

            {/* Said plainly, because "delete" and "recoverable" rarely go together
                and an admin should know which one this is. */}
            <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 10 }}>
              {t('userMgmt.deleteNote', 'The record is retained in the database for audit and can be restored by a developer if this was a mistake. The user is signed out and cannot log in again.')}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button
                onClick={() => setDeleteUser(null)} disabled={deleting}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1.5px solid #E2E8F0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: deleting ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={confirmDeleteUser} disabled={deleting}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: '#DC2626', color: '#fff', fontWeight: 700, fontSize: 13, cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.6 : 1, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {deleting
                  ? t('userMgmt.deleting', 'Deleting…')
                  : <><Trash2 size={14} />{t('userMgmt.deleteConfirm', 'Confirm Delete')}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History panel: who changed what on this profile ─────────────────── */}
      <SlidePanel
        open={!!historyUser}
        onClose={() => setHistoryUser(null)}
        title={t('userMgmt.profileHistory')}
        subtitle={historyUser ? `${historyUser.name} · ${t('userMgmt.panelSubtitleHistory')}` : ''}
      >
        {historyLoading ? (
          <div className="text-sm text-slate-400 py-6 text-center">{t('userMgmt.loading')}</div>
        ) : historyEvents.length === 0 ? (
          <div className="text-sm text-slate-400 py-6 text-center">{t('userMgmt.noHistory')}</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {historyEvents.map(ev => {
              const cfg = EVENT_CFG[ev.action] || { label: ev.action, labelKey: '', bg: '#F1F5F9', color: '#475569' };
              return (
                <div key={ev.id} style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px' }}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="badge" style={{ background: cfg.bg, color: cfg.color, fontSize: 10.5, fontWeight: 700 }}>{cfg.labelKey ? t(cfg.labelKey, cfg.label) : cfg.label}</span>
                    <span className="text-[11px] text-slate-400">{formatEventTime(ev.created_at)}</span>
                  </div>
                  {ev.details && <div className="text-[13px] text-slate-700 leading-snug">{ev.details}</div>}
                  <div className="text-[11px] text-slate-400 mt-1">
                    {t('userMgmt.by')} {ev.actor_name || t('userMgmt.unknown')}{ev.actor_role ? ` · ${ev.actor_role}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SlidePanel>

      {/* ── Role Manager: list roles, create / edit / delete ─────────────────── */}
      <SlidePanel
        open={showRoleManager}
        onClose={() => setShowRoleManager(false)}
        title={t('userMgmt.roleManager', 'Role Management')}
        subtitle={t('userMgmt.roleManagerSub', 'Define roles and what each can access')}
      >
        <div className="flex justify-end mb-3">
          <button className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm" onClick={openRoleAdd}>
            + {t('userMgmt.addRole', 'New Role')}
          </button>
        </div>
        <div className="flex flex-col gap-2.5">
          {rolesStatus === 'loading' && roles.length === 0 && (
            <div className="text-sm text-slate-400 py-6 text-center">{t('userMgmt.loading')}</div>
          )}
          {rolesStatus === 'failed' && (
            <div className="text-sm text-rose-500 py-6 text-center">
              {t('userMgmt.rolesLoadFailed', 'Could not load roles. Check the database connection and that the roles table exists.')}
            </div>
          )}
          {rolesStatus === 'ready' && roles.length === 0 && (
            <div className="text-sm text-slate-400 py-6 text-center">
              {t('userMgmt.noRoles', 'No roles yet. Click “New Role” to create one.')}
            </div>
          )}
          {roles.map(r => {
            const locked = r.is_admin || r.is_system;
            const lvl = levelColor(r.level);
            const userCount = users.filter(u => u.role_id === r.id).length;
            const access = r.allowed_routes?.includes('*')
              ? t('userMgmt.allSections', 'All sections')
              : t('userMgmt.sectionCount', { defaultValue: '{{count}} sections', count: r.allowed_routes?.length || 0 });
            return (
              <div key={r.id} style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '12px 14px' }}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="badge" style={{ background: lvl.bg, color: lvl.color, fontSize: 11, fontWeight: 700 }}>{r.level}</span>
                      <span className="font-semibold text-slate-800 text-sm">{r.label}</span>
                      {locked && (
                        <span className="badge" style={{ background: '#FFF7ED', color: '#EA580C', fontSize: 9.5, padding: '1px 6px' }}>🔒 {t('userMgmt.locked', 'Locked')}</span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {r.id} · {access} · {t('userMgmt.userCount', { defaultValue: '{{count}} users', count: userCount })}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      disabled={locked}
                      onClick={() => openRoleEdit(r)}
                      style={{ padding: '5px 12px', borderRadius: 10, border: '1px solid #E2E8F0', background: locked ? '#F8FAFC' : '#fff', fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', fontWeight: 600, color: locked ? '#CBD5E1' : '#475569' }}>
                      {t('userMgmt.edit')}
                    </button>
                    <button
                      disabled={locked || deletingRoleId === r.id}
                      onClick={() => handleDeleteRole(r)}
                      style={{ padding: '5px 12px', borderRadius: 10, border: `1px solid ${locked ? '#E2E8F0' : '#FECACA'}`, background: locked ? '#F8FAFC' : '#FEF2F2', fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', fontWeight: 600, color: locked ? '#CBD5E1' : '#DC2626' }}>
                      {deletingRoleId === r.id ? '…' : t('userMgmt.delete', 'Delete')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SlidePanel>

      {/* ── Role form: create / edit a role ──────────────────────────────────── */}
      <SlidePanel
        open={showRoleForm}
        onClose={() => { setShowRoleForm(false); setEditingRole(null); }}
        title={editingRole ? t('userMgmt.editRole', 'Edit Role') : t('userMgmt.addRole', 'New Role')}
        subtitle={t('userMgmt.roleFormSub', 'Name, level and dashboard access')}
      >
        <PanelRow>
          <PanelField label={t('userMgmt.roleNameLabel', 'Role name')}>
            <PanelInput
              value={roleForm.label}
              onChange={e => setRoleForm(f => ({
                ...f,
                label: e.target.value,
                id: editingRole || slugTouched ? f.id : slugify(e.target.value),
              }))}
              placeholder={t('userMgmt.roleNamePlaceholder', 'e.g. Quality Inspector')}
            />
          </PanelField>
          <PanelField label={t('userMgmt.roleSlugLabel', 'Slug / id')}>
            <PanelInput
              value={roleForm.id}
              disabled={!!editingRole}
              onChange={e => { setSlugTouched(true); setRoleForm(f => ({ ...f, id: e.target.value })); }}
              placeholder="quality_inspector"
            />
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('userMgmt.roleLevelLabel', 'Level')}>
            <PanelSelect value={roleForm.level} onChange={e => setRoleForm(f => ({ ...f, level: e.target.value }))}>
              {/* Ordered most-senior first. `rank` is what defines seniority —
                  it runs opposite to the id (L0 = rank 50), so sort on rank,
                  never on the id string. Shown as "L0 · Admin" so the level and
                  what it means are both visible. */}
              {(tiers.length
                ? [...tiers].sort((a, b) => b.rank - a.rank).map(tr => ({ value: tr.id, label: `${tr.id} · ${tr.label}` }))
                : LEVEL_OPTIONS_FALLBACK.map(l => ({ value: l, label: l })))
                .map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </PanelSelect>
          </PanelField>
          <PanelField label={t('userMgmt.roleHomeRouteLabel', 'Home route')}>
            <PanelInput value={roleForm.home_route} onChange={e => setRoleForm(f => ({ ...f, home_route: e.target.value }))} placeholder="/dashboard" />
          </PanelField>
        </PanelRow>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: '12px 14px', background: '#F8FAFC', borderRadius: 12, border: '1px solid #E2E8F0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{t('userMgmt.standaloneLabel', 'Standalone only')}</div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{t('userMgmt.standaloneHelper', 'No dashboard — uses a standalone app')}</div>
          </div>
          <button
            type="button"
            onClick={() => setRoleForm(f => ({ ...f, standalone_only: !f.standalone_only }))}
            style={{ width: 44, height: 24, borderRadius: 12, background: roleForm.standalone_only ? '#2563EB' : '#CBD5E1', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
          >
            <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left 0.2s', left: roleForm.standalone_only ? 22 : 4 }} />
          </button>
        </div>

        <PanelField label={t('userMgmt.allowedSectionsLabel', 'Dashboard sections this role can access')}>
          <p style={{ fontSize: 11, color: '#64748B', margin: '0 0 8px' }}>
            {t('userMgmt.activityLogGrantHint', 'Activity Log is also togglable from Factory → Activity Log (admin).')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 320, overflowY: 'auto', padding: 4 }}>
            {ALL_DASHBOARD_SECTIONS.map(s => {
              const on = roleForm.allowed_routes.includes(s.route);
              return (
                <label key={s.route} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, background: on ? '#EFF6FF' : 'transparent' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleRoleRoute(s.route)} />
                  <span>{t(s.labelKey, s.label)}</span>
                </label>
              );
            })}
          </div>
        </PanelField>

        {/* ── 🔒 Special allowances (privileged) ──────────────────────────────
            Locked by default. Granting one gives this role's holders admin-like
            power (e.g. create users), so toggling requires a password step-up. */}
        <PanelField label={t('userMgmt.specialAllowances', '🔒 Special allowances (privileged)')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {CAPABILITIES.map(c => {
              const on = roleForm.capabilities.includes(c.key);
              return (
                <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${on ? '#FDBA74' : '#E2E8F0'}`, background: on ? '#FFF7ED' : '#F8FAFC' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A' }}>{on ? '✓ ' : '🔒 '}{c.label}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{c.description}</div>
                  </div>
                  <button
                    type="button"
                    title={on ? t('userMgmt.revokeRequiresPassword', 'Revoke (requires password)') : t('userMgmt.grantRequiresPassword', 'Grant (requires password)')}
                    onClick={async () => {
                      // Granting OR revoking a privileged allowance is sensitive → step-up.
                      const ok = await stepUp();
                      if (!ok) return;
                      setRoleForm(f => ({
                        ...f,
                        capabilities: on ? f.capabilities.filter(x => x !== c.key) : [...f.capabilities, c.key],
                      }));
                    }}
                    style={{ width: 44, height: 24, borderRadius: 12, background: on ? '#EA580C' : '#CBD5E1', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}
                  >
                    <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left 0.2s', left: on ? 22 : 4 }} />
                  </button>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>
            {t('userMgmt.specialAllowancesHint', "Grants holders of this role admin-like powers — you'll confirm your password.")}
          </div>
        </PanelField>

        <PanelDivider />
        <PanelFooter
          saved={false}
          onCancel={() => { setShowRoleForm(false); setEditingRole(null); }}
          onSave={handleSaveRole}
          saveLabel={editingRole ? t('userMgmt.saveChanges') : t('userMgmt.addRole', 'Create Role')}
          successLabel=""
          successSub=""
          disabled={!roleForm.label.trim() || savingRole}
          requiredHint={t('userMgmt.requiredHint')}
        />
      </SlidePanel>

      {/* Password step-up modal (privileged allowance unlock) */}
      {stepUpModal}
    </>
  );
}

// `label` = English default; `labelKey` is resolved via t() at the render site.
const EVENT_CFG: Record<string, { label: string; labelKey: string; bg: string; color: string }> = {
  created:        { label: 'Created',        labelKey: 'userMgmt.evCreated',       bg: '#EFF6FF', color: '#2563EB' },
  self_update:    { label: 'Self update',    labelKey: 'userMgmt.evSelfUpdate',    bg: '#F5F3FF', color: '#7C3AED' },
  admin_update:   { label: 'Admin update',   labelKey: 'userMgmt.evAdminUpdate',   bg: '#FFF7ED', color: '#EA580C' },
  password_reset: { label: 'Password reset', labelKey: 'userMgmt.evPasswordReset', bg: '#FEF2F2', color: '#DC2626' },
  login_enabled:  { label: 'Login enabled',  labelKey: 'userMgmt.evLoginEnabled',  bg: '#F0FDF4', color: '#16A34A' },
  login_disabled: { label: 'Login disabled', labelKey: 'userMgmt.evLoginDisabled', bg: '#F1F5F9', color: '#64748B' },
};

function formatEventTime(d: string) {
  return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

