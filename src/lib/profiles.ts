/**
 * Mock profile definitions for role-based dashboard preview.
 *
 * RULES for allowedDashboardRoutes:
 *  - Use ['*'] for unrestricted (admin only)
 *  - List EXACT route strings — no broad prefixes like '/dashboard/purchase'
 *    because that would expose all sub-tabs unintentionally
 *  - Purchase sub-tabs must be listed individually: '/dashboard/purchase/far' etc.
 *  - profileCanAccess() matches exact OR child paths (startsWith + '/')
 *  - Omitting '/dashboard' means the Overview page is hidden for that role
 */

export interface MockProfile {
  id: string;
  name: string;
  /**
   * The underlying role-template id this profile derives its permissions from.
   * For built-in role archetypes this equals `id`. For DB-provisioned users
   * (whose `id` is a per-person `db_<uuid>`) this is the role they were created
   * under — so notifications addressed to either the person OR their role both
   * reach them. Unset on the static archetypes (treated as === id).
   */
  baseRoleId?: string;
  /**
   * The Supabase auth user id (auth.users.id) backing this directory entry, when
   * it's a provisioned login. Lets the logged-in session map itself exactly to
   * its `db_<uuid>` directory identity without relying on name matching.
   */
  authUserId?: string;
  /** When this person's account was provisioned (user_accounts.created_at). Used
   * as a notification floor so a new user doesn't inherit pre-account history.
   * Unset on the static archetypes (they see everything). */
  accountCreatedAt?: string;
  role: string;
  roleLabel: string;
  roleDescription: string;
  initials: string;
  /** Full Tailwind class e.g. 'from-orange-300' */
  avatarFrom: string;
  /** Full Tailwind class e.g. 'to-orange-500' */
  avatarTo: string;
  plant?: string;
  /** Where to land after switching to this profile */
  homeRoute: string;
  /** Exact dashboard routes this profile can access. ['*'] = all. */
  allowedDashboardRoutes: string[];
  /** True = no dashboard at all, uses a standalone app */
  standaloneOnly: boolean;
  accessNote?: string;
  /** Granted "special allowances" (privileged capabilities), e.g. ['manage_users'].
   * Admin (allowedDashboardRoutes includes '*') implicitly has every capability. */
  capabilities: string[];
}

/**
 * The privileged capabilities ("special allowances") an admin can grant to a
 * role. They are OFF by default and unlocking them in the Role editor requires a
 * password step-up. Extend this list to add more powers later.
 */
export const CAPABILITIES: { key: string; label: string; description: string }[] = [
  { key: 'manage_users', label: 'Manage users', description: 'Create, edit, deactivate users and assign their roles' },
  { key: 'manage_roles', label: 'Manage roles & permissions', description: 'Create/edit roles, levels and dashboard access' },
  { key: 'allocate_night_duty', label: 'Allocate night duty', description: 'Schedule operators beneath them onto night-duty shifts' },
  // Grants the technician's side of the maintenance workflow to any role (e.g.
  // Operator / Technical Team) without cloning the technician role. Every
  // maintenance action used to be hardcoded to the 'technician_shd' slug, which
  // silently locked out every other role the client created.
  { key: 'perform_maintenance', label: 'Log & complete maintenance work', description: 'Do the technician side of maintenance: fill in a raised ticket, request parts or start an in-house repair, upload completion proof, mark periodic maintenance complete, and revise & resubmit a ticket the unit head sent back' },
  { key: 'view_asset_profile', label: 'View asset QR profile', description: 'Open an asset’s digital profile (details + maintenance history) by scanning its QR code' },
  { key: 'generate_asset_qr', label: 'Generate & print asset QR', description: 'Generate, regenerate, download and print QR codes for fixed assets' },
  { key: 'view_asset_analytics', label: 'View asset analytics', description: 'See repair statistics and trend charts on an asset profile' },
  { key: 'add_stock_purchase', label: 'Add purchases to stock', description: 'Record a purchase (vendor, amount, invoice) and add the bought items to the stock register' },
  { key: 'resolve_stock_anomaly', label: 'Resolve stock anomalies', description: 'Review Stock Register anomalies and mark them confirmed / resolved / false positive (with a mandatory comment)' },
  { key: 'complete_periodic_maintenance', label: 'Mark Complete (periodic maintenance)', description: 'Upload completion photo and mark periodic / scheduled maintenance as complete. Toggle this on any role that should do that work.' },
  { key: 'return_repairs', label: 'Return repaired items', description: 'Record repaired parts coming back from a vendor and add them to repaired stock' },
  { key: 'reverse_repair_return', label: 'Reverse repair returns', description: 'Reverse a recorded repair return with an offsetting stock movement (history is preserved)' },
  // Destructive and irreversible — deliberately the last entry, and granted to
  // nobody by default. Admin roles hold it implicitly via is_admin (see
  // profileHasCapability / has_capability), which is what the client asked for:
  // "restricted to authorised administrator accounts".
  { key: 'delete_user', label: 'Delete user profiles', description: 'Delete a user from User Management. The profile is hidden from the app and the person can no longer log in; the record is retained for audit and can be restored. Cannot delete yourself or the last remaining administrator.' },
  { key: 'delete_import_batch', label: 'Delete uploaded data', description: 'Delete the records imported through an incorrect CSV / Excel upload, so a corrected file can be uploaded. Only rows from that file are removed; manual entries are never touched. Every deletion is audited.' },
];

/**
 * True if the profile holds the privileged capability.
 *
 * The `'*'` route wildcard is held ONLY by the Owner/Admin role (every other role,
 * incl. Management, uses an explicit route list), so it's the admin signal → admin
 * implicitly holds EVERY capability, including new ones. All other roles get only
 * the capabilities explicitly granted to them.
 */
export function profileHasCapability(profile: MockProfile, cap: string): boolean {
  if (profile.allowedDashboardRoutes.includes('*')) return true;
  return (profile.capabilities || []).includes(cap);
}

/**
 * A row from the `roles` table — the single source of truth for RBAC.
 * Mirrors Database['public']['Tables']['roles']['Row'].
 */
export interface RoleRow {
  id: string;            // text PK, slug ('admin', 'unit_head', …)
  label: string;
  level: string;         // tier id — 'L0' (admin) … 'L4' (entry); see the tiers table
  description: string | null;
  home_route: string;
  allowed_routes: string[]; // exact route strings; ['*'] = all
  standalone_only: boolean;
  is_admin: boolean;
  is_system: boolean;
  capabilities: string[]; // granted special allowances
  avatar_from: string | null;
  avatar_to: string | null;
  sort_order: number | null;
}

/** Derive 2-letter initials from a person's name. */
export function initialsFrom(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

/**
 * Avatar gradient palette. These exact class strings are SAFELISTED in
 * tailwind.config.js — Tailwind can't see DB-sourced class names, so any gradient
 * used here must also be in that safelist or it gets purged (white avatar bug).
 */
export const AVATAR_PALETTE: [string, string][] = [
  ['from-orange-300', 'to-orange-500'],
  ['from-blue-400', 'to-blue-600'],
  ['from-teal-400', 'to-teal-600'],
  ['from-indigo-400', 'to-indigo-600'],
  ['from-purple-400', 'to-purple-600'],
  ['from-lime-400', 'to-lime-600'],
  ['from-cyan-400', 'to-cyan-600'],
  ['from-fuchsia-400', 'to-fuchsia-600'],
  ['from-rose-400', 'to-rose-600'],
  ['from-amber-400', 'to-amber-600'],
];

/** Deterministic gradient for a role/user that has no avatar color set. */
export function avatarFor(key: string): [string, string] {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * Map a `roles` table row → the MockProfile shape consumed throughout the app.
 * `overrides` (name, ids, plant, etc. for a provisioned user) are applied last.
 * Initials are derived from the final name.
 */
export function roleToProfile(role: RoleRow, overrides?: Partial<MockProfile>): MockProfile {
  const name = overrides?.name ?? '';
  const [fallbackFrom, fallbackTo] = avatarFor(role.id);
  const base: MockProfile = {
    id: role.id,
    name,
    role: role.level,
    roleLabel: role.label,
    roleDescription: role.description ?? '',
    initials: initialsFrom(name),
    avatarFrom: role.avatar_from || fallbackFrom,
    avatarTo: role.avatar_to || fallbackTo,
    homeRoute: role.home_route,
    allowedDashboardRoutes: role.allowed_routes ?? [],
    standaloneOnly: role.standalone_only,
    capabilities: role.capabilities ?? [],
  };
  const merged = { ...base, ...overrides };
  // Always recompute initials from the resolved name (override may set name).
  merged.initials = initialsFrom(merged.name);
  return merged;
}

/**
 * SAFETY-NET fallback only — NOT seed data. Used solely so the owner is never
 * locked out of the dashboard if the `roles` table fails to load entirely. The
 * real role catalog lives in the DB; this grants full access as a last resort.
 */
export const ADMIN_FALLBACK: MockProfile = {
  id: 'admin',
  name: '',
  role: 'L0',   // top of the ladder since migration 64 (was L4/L5)
  roleLabel: 'Owner · Admin',
  roleDescription: 'Full access to all modules and data',
  initials: '',
  avatarFrom: 'from-orange-300',
  avatarTo: 'to-orange-500',
  homeRoute: '/dashboard',
  allowedDashboardRoutes: ['*'],
  standaloneOnly: false,
  capabilities: ['manage_users', 'manage_roles'],
};

/**
 * Returns true if the given profile can access the given route.
 *
 * Matching rules:
 *  1. ['*'] in allowedDashboardRoutes → always true (admin)
 *  2. EXACT match only — '/dashboard' does NOT grant access to '/dashboard/batches'
 *
 * Why exact match: Prefix matching caused a critical bug where Unit Head (who has
 * '/dashboard' in their routes) was granted access to '/dashboard/night-entry' and
 * '/dashboard/batch-entry' because those paths start with '/dashboard/'.
 * Those are L1 operator entry terminals — Unit Head views boards, not entry forms.
 *
 * All allowed routes are listed explicitly, so prefix matching is not needed.
 */
export function profileCanAccess(profile: MockProfile, route: string): boolean {
  if (profile.allowedDashboardRoutes.includes('*')) return true;
  return profile.allowedDashboardRoutes.includes(route);
}
