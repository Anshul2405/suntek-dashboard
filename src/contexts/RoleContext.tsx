import React, { createContext, useContext, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { roleToProfile, ADMIN_FALLBACK, profileHasCapability } from '../lib/profiles';
import type { MockProfile, RoleRow } from '../lib/profiles';
import { supabase } from '../lib/supabase';
import type { Database } from '../lib/database.types';
import { applyLanguage, hasStoredLanguage } from '../i18n';

type DbUser = Pick<
  Database['public']['Tables']['user_accounts']['Row'],
  'id' | 'name' | 'role_id' | 'role_label' | 'plant_name' | 'access_note' | 'auth_user_id' | 'created_at'
>;

/** The DB profile data we resolve for the logged-in user (before role mapping). */
type SessionProfile = { role: string | null; name: string | null };

type RolesStatus = 'loading' | 'ready' | 'failed';

/**
 * Fail-closed identity for a logged-in user whose profiles.role doesn't match any
 * role in the catalog (missing/unknown role). Grants NO dashboard access — never
 * default an unrecognized login to admin.
 */
const LOCKED_FALLBACK: MockProfile = {
  id: 'locked',
  name: 'Restricted',
  // Bottom of the ladder. Since migration 64 the ladder runs L0 (admin) → L4
  // (entry), so the least-privileged tier is L4, not L1.
  role: 'L4',
  roleLabel: 'No access',
  roleDescription: 'No role assigned — contact admin',
  initials: '?',
  avatarFrom: 'from-slate-300',
  avatarTo: 'to-slate-500',
  homeRoute: '/dashboard',
  allowedDashboardRoutes: [],
  standaloneOnly: false,
  capabilities: [],
};

interface RoleContextValue {
  /** The profile whose access/views are currently in effect. */
  activeProfile: MockProfile;
  /**
   * Every id the active profile answers to for notifications/tagging: their
   * primary id, their role-template id, and their per-person `db_<uuid>` twin
   * if one exists in the directory. A notification addressed to ANY of these
   * belongs to this person. Always non-empty (at least `[activeProfile.id]`).
   */
  activeIdentityIds: string[];
  /**
   * The active person's SINGLE personal identity — their `db_<uuid>` when they
   * are a provisioned user, otherwise their profile id. Unlike `activeProfile.id`
   * (which is the shared role-template id for provisioned users), this is unique
   * per person, so it's what "is this note mine / mark it seen / don't tag
   * myself" must key on. Two different technicians get two different personIds.
   */
  activePersonId: string;
  /**
   * When the active person's account was created — notifications older than this
   * are hidden so a freshly-provisioned user doesn't inherit the whole backlog.
   * null for the static archetypes / dev (they see everything).
   */
  activeAccountFloor: string | null;
  /** False until the session/profile has been resolved (show a loader, not the
   * locked fallback, while this is false). */
  authResolved: boolean;
  /** The logged-in user's own profile (who they actually are). */
  authProfile: MockProfile | null;
  allProfiles: MockProfile[];
  /** The role catalog from the `roles` table (sorted by sort_order). */
  roles: RoleRow[];
  /** Load state of the role catalog: 'loading' | 'ready' | 'failed'. */
  rolesStatus: RolesStatus;
  /** Re-fetch the role catalog (e.g. after admin edits roles). */
  refreshRoles: () => Promise<void>;
  switchProfile: (profileId: string) => void;
  /** True when the active profile differs from the user's own profile (admin preview). */
  isViewingAs: boolean;
  /** True only when the current user may switch/preview roles (admin or dev bypass). */
  canSwitch: boolean;
  /**
   * DEV-ONLY: there is no Supabase session, so the UI is presenting the demo
   * admin profile. The database still sees an ANONYMOUS caller, so every
   * RLS-scoped table (tickets, activity, assets, stock…) returns zero rows —
   * the app looks empty even though the data is there. Surfaced so the shell
   * can say so out loud instead of looking silently broken.
   */
  devBypass: boolean;
  /** Does the active profile hold a privileged capability (admin/'*' = all)?
   * e.g. can('manage_users'), can('manage_roles'). */
  can: (capability: string) => boolean;
}

const RoleContext = createContext<RoleContextValue | null>(null);

/**
 * All ids a person answers to: their own id, their role-template id, and the
 * per-person `db_<uuid>` twin that the taggable directory exposes for them
 * (matched by name). This bridges the two identity spaces — a user resolved to
 * a role-template id at login still receives notifications tagged to their
 * personal directory id, and vice-versa.
 */
function identitiesFor(profile: MockProfile, directory: MockProfile[]): string[] {
  const ids = new Set<string>([profile.id]);
  if (profile.baseRoleId) ids.add(profile.baseRoleId);
  const key = profile.name.trim().toLowerCase();
  const twin = directory.find((p) => p.name.trim().toLowerCase() === key);
  if (twin) {
    ids.add(twin.id);
    if (twin.baseRoleId) ids.add(twin.baseRoleId);
  }
  return [...ids];
}

export function RoleProvider({ children }: { children: React.ReactNode }) {
  // ── Role catalog (single source of truth for RBAC) ──────────────────────────
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [rolesStatus, setRolesStatus] = useState<RolesStatus>('loading');
  // DB directory (active user_accounts rows).
  const [dbUsers, setDbUsers] = useState<DbUser[]>([]);

  // The DB profile data resolved for the logged-in user (role id + name), before
  // it's mapped through the role catalog. null = no session / still resolving.
  const [sessionProfile, setSessionProfile] = useState<SessionProfile | null>(null);
  // Every role id the logged-in user holds (multi-role via user_roles). Their
  // effective access is the UNION of these roles; empty = single-role fallback.
  const [sessionRoleIds, setSessionRoleIds] = useState<string[]>([]);
  // True once the session resolution attempt has completed (with or without a user).
  const [sessionResolved, setSessionResolved] = useState(false);
  // Admin-only "preview as" selection. null = view as self.
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(null);
  // The logged-in Supabase auth user id — the exact link to this person's
  // directory (db) identity, used to bridge notification ids. null = no session.
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  // The auth user whose saved language we've already applied this session. Auth
  // events (token refresh, tab focus) fire resolveFromSession repeatedly — we
  // must apply the DB language only ONCE per login, never re-apply it, so it
  // can't clobber a language the user switched to at runtime.
  const langAppliedForRef = useRef<string | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── Load the role catalog ───────────────────────────────────────────────────
  const refreshRoles = useCallback(async () => {
    const { data, error } = await supabase
      .from('roles')
      .select('*')
      .order('sort_order')
      .returns<RoleRow[]>();
    if (error) {
      setRolesStatus('failed');
      return;
    }
    setRoles(data ?? []);
    setRolesStatus('ready');
  }, []);

  useEffect(() => { refreshRoles(); }, [refreshRoles]);

  // Fast lookup id → role row.
  const roleMap = useMemo(() => {
    const m = new Map<string, RoleRow>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  // ── Resolve the logged-in user's DB profile (role id + name) ─────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadSessionRoles(userId: string) {
      try {
        const { data: acct } = await supabase
          .from('user_accounts').select('id').eq('auth_user_id', userId).limit(1)
          .returns<{ id: string }[]>();
        const accountId = acct?.[0]?.id;
        if (!accountId) {
          if (!cancelled) setSessionRoleIds([]);
          return;
        }
        const { data: urs } = await supabase
          .from('user_roles').select('role_id').eq('user_account_id', accountId)
          .returns<{ role_id: string }[]>();
        if (!cancelled) setSessionRoleIds((urs ?? []).map((r) => r.role_id));
      } catch {
        if (!cancelled) setSessionRoleIds([]);
      }
    }

    async function resolveFromSession(userId: string | null) {
      if (!cancelled) setSessionUserId(userId);
      if (!userId) {
        langAppliedForRef.current = null; // signed out → re-apply on next login
        if (!cancelled) { setSessionProfile(null); setSessionRoleIds([]); setSessionResolved(true); }
        return;
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('role, plant_id, name, preferred_language')
        .eq('id', userId)
        .maybeSingle()
        .returns<{ role: string | null; plant_id: string | null; name: string | null; preferred_language: string | null }>();
      if (cancelled) return;

      // Transient fetch failure (flaky mobile network) → retry instead of failing
      // closed to "No access". The loader stays up until it resolves.
      if (error) {
        retryRef.current = setTimeout(() => { if (!cancelled) resolveFromSession(userId); }, 1500);
        return;
      }

      // Language source of truth = the user's local choice (localStorage). The
      // DB preference only SEEDS the language on a fresh device that has no
      // local choice yet — so a refresh/token-refresh/tab-focus can never
      // override a language the user picked. Applied at most once per login.
      if (langAppliedForRef.current !== userId) {
        langAppliedForRef.current = userId;
        if (!hasStoredLanguage()) applyLanguage(data?.preferred_language);
      }

      setSessionProfile({ role: data?.role ?? null, name: data?.name ?? null });

      // Load the user's full role set (multi-role). Additive: on any failure we
      // keep the empty set and fall back to the single primary role — never
      // reducing access.
      await loadSessionRoles(userId);

      setSessionResolved(true);
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      resolveFromSession(session?.user?.id ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setPreviewProfileId(null); // reset any preview on login/logout
      resolveFromSession(session?.user?.id ?? null);
    });

    // Admin may grant a second role while this person is already logged in.
    // Re-read user_roles when the tab becomes visible so Store Req / etc.
    // appear without forcing a logout.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      supabase.auth.getSession().then(({ data: { session } }) => {
        const uid = session?.user?.id;
        if (uid) loadSessionRoles(uid);
      });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(retryRef.current);
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // ── DB directory — built from active user_accounts rows ─────────────────────
  useEffect(() => {
    async function loadDbUsers() {
      const { data } = await supabase
        .from('user_accounts')
        .select('id, name, role_id, role_label, plant_name, access_note, auth_user_id, created_at')
        .eq('is_active', true)
        .returns<DbUser[]>();
      if (data) setDbUsers(data);
    }
    loadDbUsers();
  }, []);

  // The directory of all real (provisioned) people, mapped through the role
  // catalog. A user whose role_id isn't in the catalog is mapped to a locked
  // (no-access) profile so they still appear but can't be impersonated into access.
  const directory = useMemo<MockProfile[]>(() => {
    if (rolesStatus !== 'ready') return [];
    const out: MockProfile[] = [];
    for (const u of dbUsers) {
      const role = u.role_id ? roleMap.get(u.role_id) : undefined;
      const overrides: Partial<MockProfile> = {
        id: `db_${u.id}`,
        name: u.name,
        baseRoleId: u.role_id ?? undefined, // keep the role link so role-targeted notifications still reach this person
        authUserId: u.auth_user_id ?? undefined, // exact session ↔ directory link
        accountCreatedAt: u.created_at ?? undefined, // notification floor
        plant: u.plant_name ?? undefined,
        accessNote: u.access_note ?? undefined,
      };
      if (role) {
        out.push(roleToProfile(role, overrides));
      } else {
        // Unknown role → a locked directory entry (no access), still taggable.
        out.push({
          ...LOCKED_FALLBACK,
          ...overrides,
          name: u.name,
          roleLabel: u.role_label || LOCKED_FALLBACK.roleLabel,
          initials: LOCKED_FALLBACK.initials,
        });
      }
    }
    return out;
  }, [dbUsers, roleMap, rolesStatus]);

  const allProfiles = directory;

  // The logged-in user's own identity, derived from their DB profile + the catalog.
  // Multi-role: display (label/level/avatar) comes from the PRIMARY role
  // (profiles.role); access is the UNION of every role's routes + capabilities.
  const authProfile = useMemo<MockProfile | null>(() => {
    if (!sessionUserId || !sessionProfile) return null;
    const role = sessionProfile.role ? roleMap.get(sessionProfile.role) : undefined;
    if (role) {
      const base = roleToProfile(role, { name: sessionProfile.name ?? '' });
      const extraRoles = sessionRoleIds
        .map((id) => roleMap.get(id))
        .filter((r): r is RoleRow => !!r);
      const all = [role, ...extraRoles.filter((r) => r.id !== role.id)];
      if (all.length > 1) {
        const routes = all.some((r) => r.allowed_routes?.includes('*'))
          ? ['*']
          : [...new Set(all.flatMap((r) => r.allowed_routes ?? []))];
        const capabilities = [...new Set(all.flatMap((r) => r.capabilities ?? []))];
        return { ...base, allowedDashboardRoutes: routes, capabilities };
      }
      return base;
    }
    // Role not found in the catalog.
    if (rolesStatus === 'failed' && sessionProfile.role === 'admin') {
      // Catalog failed to load entirely → don't lock the owner out.
      return { ...ADMIN_FALLBACK, name: sessionProfile.name || 'Owner' };
    }
    if (rolesStatus !== 'ready') return null; // still loading — hold for the catalog
    return { ...LOCKED_FALLBACK, name: sessionProfile.name || LOCKED_FALLBACK.name };
  }, [sessionUserId, sessionProfile, roleMap, rolesStatus, sessionRoleIds]);

  // False until BOTH the session resolution and the role catalog load have
  // settled — so the UI shows a loader instead of flashing the locked fallback.
  const authResolved = sessionResolved && rolesStatus !== 'loading';

  // Who can preview/switch: a real admin login, OR the dev bypass (no session in
  // a dev build, where Login lets you skip auth to demo the role switcher).
  const isAdmin = authProfile?.id === 'admin';
  const devBypass = import.meta.env.DEV && sessionResolved && !sessionUserId;
  const canSwitch = isAdmin || devBypass;

  // An admin profile sourced from the catalog (fallback if catalog unavailable).
  const adminProfile = useMemo<MockProfile>(() => {
    const role = roleMap.get('admin');
    return role ? roleToProfile(role, { name: 'Owner' }) : { ...ADMIN_FALLBACK, name: 'Owner' };
  }, [roleMap]);

  // The user's own identity. In a dev bypass we present as admin (the demo owner).
  const selfProfile: MockProfile = authProfile
    ?? (devBypass ? adminProfile : LOCKED_FALLBACK);

  // Active = (admin's preview selection) else self. Non-admins can never deviate.
  const activeProfile: MockProfile = useMemo(() => {
    if (canSwitch && previewProfileId) {
      return allProfiles.find((p) => p.id === previewProfileId) ?? selfProfile;
    }
    return selfProfile;
  }, [canSwitch, previewProfileId, allProfiles, selfProfile]);

  // Every id the active person answers to (self id + role id + db twin id).
  const activeIdentityIds = useMemo(() => {
    const ids = new Set(identitiesFor(activeProfile, directory));
    // Exact bridge for the logged-in self: map this auth session straight to its
    // directory `db_<uuid>` identity (name-independent, the robust link). Only
    // when viewing as self — an admin previewing someone else keeps their ids.
    if (sessionUserId && activeProfile.id === selfProfile.id) {
      const mine = directory.find((p) => p.authUserId === sessionUserId);
      if (mine) {
        ids.add(mine.id);
        if (mine.baseRoleId) ids.add(mine.baseRoleId);
      }
    }
    return [...ids];
  }, [activeProfile, directory, sessionUserId, selfProfile]);

  // The active person's unique personal id (their db twin if provisioned, else
  // their profile id). NEVER the shared role id — used for "is this mine /
  // mark seen / exclude self" so two same-role people stay distinct.
  const activePersonId = useMemo(() => {
    if (activeProfile.id.startsWith('db_')) return activeProfile.id; // already personal
    if (sessionUserId && activeProfile.id === selfProfile.id) {
      const mine = directory.find((p) => p.authUserId === sessionUserId);
      if (mine) return mine.id; // exact auth link
    }
    const key = activeProfile.name.trim().toLowerCase();
    const twin = directory.find((p) => p.name.trim().toLowerCase() === key);
    return twin?.id ?? activeProfile.id; // name twin, else the profile id
  }, [activeProfile, directory, sessionUserId, selfProfile]);

  // The active person's provisioning date (notification floor). Resolved from
  // whichever directory entry matches their personal id; null for archetypes.
  const activeAccountFloor = useMemo(() => {
    if (activeProfile.accountCreatedAt) return activeProfile.accountCreatedAt;
    const mine = directory.find((p) => p.id === activePersonId);
    return mine?.accountCreatedAt ?? null;
  }, [activeProfile, directory, activePersonId]);

  function switchProfile(profileId: string) {
    if (!canSwitch) return; // locked users cannot change their role
    // Switching back to self clears the preview.
    setPreviewProfileId(profileId === selfProfile.id ? null : profileId);
  }

  return (
    <RoleContext.Provider
      value={{
        activeProfile,
        activeIdentityIds,
        activePersonId,
        activeAccountFloor,
        authResolved,
        authProfile,
        allProfiles,
        roles,
        rolesStatus,
        refreshRoles,
        switchProfile,
        canSwitch,
        devBypass,
        can: (capability: string) => profileHasCapability(activeProfile, capability),
        isViewingAs: activeProfile.id !== selfProfile.id,
      }}
    >
      {children}
    </RoleContext.Provider>
  );
}

export function useRoleContext(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error('useRoleContext must be used inside <RoleProvider>');
  return ctx;
}
