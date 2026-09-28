import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useRoleContext } from './RoleContext';
import { storeScopeFilter } from '../lib/store/registers';

/**
 * PlantScopeContext — the logged-in user's DATA scope (Phase 1, app-layer).
 *
 * A user's scope = the plants they belong to (`user_plants`), optionally narrowed
 * to specific units within those plants (`user_units`), OR global (`is_global` /
 * Owner-Admin / dev bypass) which sees everything. This is the dimension the app
 * discarded before; here it drives query filtering, create-time stamping, and
 * notification delivery.
 *
 * When an admin uses "view as", scope follows the previewed person's plant
 * membership so QA matches what that employee sees on the floor.
 *
 * This is the visible/testable half. Phase 2 enforces the same rules in the DB
 * with RLS so they can't be bypassed via the API.
 */

export interface PlantRow {
  id: string;
  name: string;
  /** Geofence centre + radius (night-duty check-in). Null until seeded. */
  lat?: number | null;
  lng?: number | null;
  geofence_radius_m?: number | null;
  /** Hierarchy — populated by migration 57. Undefined before it is applied. */
  location_id?: string | null;
  company_name?: string | null;
  entity_name?: string | null;
  factory_code?: string | null;
  is_factory?: boolean | null;
  is_active?: boolean | null;
}
export interface UnitRow { id: string; plant_id: string; name: string; code: string | null }
export interface LocationRow { id: string; state: string; name: string; code: string | null }
export interface StoreRow { id: string; location_id: string | null; name: string; code: string | null; is_active?: boolean | null }

const NIL_UUID = '00000000-0000-0000-0000-000000000000'; // matches no row (fail-closed)
const EMPTY_IDS: string[] = []; // stable ref so scope memoization doesn't churn each render

type AccountMembership = {
  isGlobal: boolean;
  plantIds: string[];
  unitIds: string[];
  storeIds: string[];
};

/** Resolve plant/unit/store grants for a user_accounts row (with legacy plant_id / plant_name fallbacks). */
async function resolveAccountMembership(accountId: string): Promise<AccountMembership | null> {
  const { data: acct } = await supabase
    .from('user_accounts')
    .select('id, is_global, plant_id, plant_name')
    .eq('id', accountId)
    .limit(1)
    .returns<{ id: string; is_global: boolean | null; plant_id: string | null; plant_name: string | null }[]>();
  const row = acct?.[0];
  if (!row) return null;
  if (row.is_global) return { isGlobal: true, plantIds: [], unitIds: [], storeIds: [] };

  const [{ data: ups }, { data: uus }, uss] = await Promise.all([
    supabase.from('user_plants').select('plant_id').eq('user_account_id', row.id).returns<{ plant_id: string }[]>(),
    supabase.from('user_units').select('unit_id').eq('user_account_id', row.id).returns<{ unit_id: string }[]>(),
    supabase.from('user_stores').select('store_id').eq('user_account_id', row.id).returns<{ store_id: string }[]>(),
  ]);

  let plantIds = (ups ?? []).map((r) => r.plant_id);
  if (plantIds.length === 0 && row.plant_id) plantIds = [row.plant_id];
  if (plantIds.length === 0 && row.plant_name) {
    const { data: pl } = await supabase.from('plants').select('id').eq('name', row.plant_name).limit(1).returns<{ id: string }[]>();
    if (pl?.[0]) plantIds = [pl[0].id];
  }

  return {
    isGlobal: false,
    plantIds,
    unitIds: (uus ?? []).map((r) => r.unit_id),
    storeIds: (uss.data ?? []).map((r) => r.store_id),
  };
}

interface PlantScopeValue {
  /** True once plants/units are loaded and the user's scope is resolved. */
  ready: boolean;
  /** Sees every plant (Owner/Admin, dev bypass, or a user flagged is_global). */
  isGlobal: boolean;
  /** Plant ids the user may see/act on. For a global user this is every plant. */
  plantIds: string[];
  /** Unit ids the user is restricted to. Empty = all units of their plants. */
  unitIds: string[];
  /** All plants (labels + pickers). */
  plants: PlantRow[];
  /** All units (labels + pickers). */
  units: UnitRow[];
  /** State → location tier (migration 57). Empty until that migration runs. */
  locations: LocationRow[];
  /** All stores (migration 59). Empty until that migration runs. */
  stores: StoreRow[];
  /**
   * The store a factory draws from, via factory_store_access. At Rehla all
   * three factories resolve to the SAME store — that is the whole point. For a
   * one-factory-one-store site it is the factory's own store, so every caller
   * behaves exactly as it did before stores existed.
   */
  storeIdFor: (plantId: string | null | undefined) => string | null;
  /** Stores the user may act on: granted directly, or via a factory they belong to. */
  allowedStores: StoreRow[];
  /**
   * Apply the STORE scope to a Supabase query. Use this — never scopeQuery() —
   * for any table carrying a store id: store_items, store_stock_months,
   * store_stock_events, store_stock_anomalies, stock_purchase_receipts,
   * repair_return_receipts, maintenance_store_requests, import_batches.
   *
   * A ticked store means the whole store, whatever the user's role and whoever
   * owns the stock. Rows with no store still answer to the factory grant, so
   * pre-migration-59 data and factory-owned records (FAR / PM batches) keep
   * working. No-op for global users; fails closed when the user has neither.
   */
  storeQuery: <T>(query: T, opts?: { storeCol?: string; plantCol?: string | null }) => T;
  /** Plants the user may pick when creating a record (all if global). */
  allowedPlants: PlantRow[];
  /** Units within one plant the user may pick (respects unit restriction). */
  allowedUnits: (plantId: string | null | undefined) => UnitRow[];
  /** Is a (plant, unit?) row inside the user's scope? */
  inScope: (plantId: string | null | undefined, unitId?: string | null) => boolean;
  /**
   * Apply the scope to a Supabase query. No-op for global users. Adds a plant
   * filter, and (when unitCol is given and the user is unit-restricted) also
   * limits to their units OR unit-less rows.
   */
  scopeQuery: <T>(query: T, opts?: { plantCol?: string; unitCol?: string }) => T;
  refresh: () => void;
}

const PlantScopeContext = createContext<PlantScopeValue | null>(null);

export function PlantScopeProvider({ children }: { children: React.ReactNode }) {
  const { canSwitch, authResolved, isViewingAs, activeProfile } = useRoleContext();

  const [plants, setPlants] = useState<PlantRow[]>([]);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [plantStore, setPlantStore] = useState<{ plant_id: string; store_id: string }[]>([]);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [refDataReady, setRefDataReady] = useState(false);

  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [membership, setMembership] = useState<{ isGlobal: boolean; plantIds: string[]; unitIds: string[] } | null>(null);
  const [scopeReady, setScopeReady] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Reference data: plants + units + (once migrated) locations and stores.
  //
  // The hierarchy columns and the store tables arrive in migrations 57 and 59.
  // Every read below degrades gracefully if they are absent, so the app keeps
  // working against a database where those migrations have not yet been run —
  // plants fall back to the columns that have always existed, and locations /
  // stores simply stay empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const richPlants = await supabase
        .from('plants')
        .select('id, name, lat, lng, geofence_radius_m, location_id, company_name, entity_name, factory_code, is_factory, is_active')
        .order('name')
        .returns<PlantRow[]>();
      const p = richPlants.error
        ? await supabase.from('plants').select('id, name, lat, lng, geofence_radius_m').order('name').returns<PlantRow[]>()
        : richPlants;

      const [u, loc, st, fsa] = await Promise.all([
        supabase.from('units').select('id, plant_id, name, code').order('name').returns<UnitRow[]>(),
        supabase.from('locations').select('id, state, name, code').order('name').returns<LocationRow[]>(),
        // Retired stores are kept (migration 60 deactivates the per-factory
        // Rehla registers rather than deleting them, so history still resolves)
        // but must never appear in a picker — otherwise the store-access list
        // shows three identical "Rehla Store" rows next to the real shared one.
        // `is_active.is.null` covers a store row created before the column
        // existed. Same rule as fetchActivePlants().
        supabase.from('stores').select('id, location_id, name, code, is_active')
          .or('is_active.is.null,is_active.eq.true').order('name').returns<StoreRow[]>(),
        supabase.from('factory_store_access').select('plant_id, store_id').returns<{ plant_id: string; store_id: string }[]>(),
      ]);

      if (cancelled) return;
      // Retired factories stay in the table so history keeps resolving, but they
      // must not appear in any picker.
      setPlants((p.data ?? []).filter(r => r.is_active !== false));
      setUnits(u.data ?? []);
      setLocations(loc.data ?? []);
      setStores(st.data ?? []);
      setPlantStore(fsa.data ?? []);
      setRefDataReady(true);
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  // Track the logged-in auth user id (independent of RoleContext's preview state).
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setAuthUserId(session?.user?.id ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) =>
      setAuthUserId(session?.user?.id ?? null),
    );
    return () => subscription.unsubscribe();
  }, []);

  // Resolve the user's membership. Admins are global unless previewing someone else.
  useEffect(() => {
    let cancelled = false;
    const applyMembership = (m: AccountMembership) => {
      if (cancelled) return;
      setMembership({ isGlobal: m.isGlobal, plantIds: m.plantIds, unitIds: m.unitIds });
      setStoreIds(m.storeIds);
      setScopeReady(true);
    };
    (async () => {
      if (!authResolved) return;

      if (canSwitch && !isViewingAs) {
        applyMembership({ isGlobal: true, plantIds: [], unitIds: [], storeIds: [] });
        return;
      }

      if (canSwitch && isViewingAs) {
        const previewAccountId = activeProfile.id.startsWith('db_') ? activeProfile.id.slice(3) : null;
        if (previewAccountId) {
          const resolved = await resolveAccountMembership(previewAccountId);
          if (resolved) { applyMembership(resolved); return; }
        }
        if (activeProfile.plant) {
          const { data: pl } = await supabase.from('plants').select('id').eq('name', activeProfile.plant).limit(1).returns<{ id: string }[]>();
          if (cancelled) return;
          const pid = pl?.[0]?.id;
          applyMembership({ isGlobal: false, plantIds: pid ? [pid] : [], unitIds: [], storeIds: [] });
          return;
        }
        applyMembership({ isGlobal: false, plantIds: [], unitIds: [], storeIds: [] });
        return;
      }

      if (!authUserId) {
        applyMembership({ isGlobal: false, plantIds: [], unitIds: [], storeIds: [] });
        return;
      }

      const { data: acct } = await supabase
        .from('user_accounts')
        .select('id')
        .eq('auth_user_id', authUserId)
        .limit(1)
        .returns<{ id: string }[]>();
      const row = acct?.[0];
      if (!row) {
        applyMembership({ isGlobal: false, plantIds: [], unitIds: [], storeIds: [] });
        return;
      }
      const resolved = await resolveAccountMembership(row.id);
      if (resolved) applyMembership(resolved);
      else applyMembership({ isGlobal: false, plantIds: [], unitIds: [], storeIds: [] });
    })();
    return () => { cancelled = true; };
  }, [authResolved, canSwitch, authUserId, isViewingAs, activeProfile.id, activeProfile.plant, nonce]);

  const isGlobal = membership?.isGlobal ?? false;
  const allPlantIds = useMemo(() => plants.map((p) => p.id), [plants]);
  const plantIds = useMemo(
    () => (isGlobal ? allPlantIds : (membership?.plantIds ?? EMPTY_IDS)),
    [isGlobal, allPlantIds, membership],
  );
  const unitIds = useMemo(() => membership?.unitIds ?? EMPTY_IDS, [membership]);

  const plantIdSet = useMemo(() => new Set(plantIds), [plantIds]);
  const unitIdSet = useMemo(() => new Set(unitIds), [unitIds]);

  const inScope = useCallback(
    (plantId: string | null | undefined, unitId?: string | null) => {
      if (isGlobal) return true;
      if (!plantId || !plantIdSet.has(plantId)) return false;
      // Unit-restricted users: a row tagged to a unit must be one of theirs;
      // unit-less (plant-level) rows are always visible within the plant.
      if (unitIdSet.size > 0 && unitId) return unitIdSet.has(unitId);
      return true;
    },
    [isGlobal, plantIdSet, unitIdSet],
  );

  const allowedPlants = useMemo(
    () => (isGlobal ? plants : plants.filter((p) => plantIdSet.has(p.id))),
    [isGlobal, plants, plantIdSet],
  );

  const allowedUnits = useCallback(
    (plantId: string | null | undefined) => {
      if (!plantId) return [];
      let list = units.filter((u) => u.plant_id === plantId);
      if (!isGlobal && unitIdSet.size > 0) list = list.filter((u) => unitIdSet.has(u.id));
      return list;
    },
    [units, isGlobal, unitIdSet],
  );

  const scopeQuery = useCallback(
    <T,>(query: T, opts?: { plantCol?: string; unitCol?: string }): T => {
      if (isGlobal) return query;
      const plantCol = opts?.plantCol ?? 'plant_id';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = query;
      q = plantIds.length ? q.in(plantCol, plantIds) : q.eq(plantCol, NIL_UUID);
      if (opts?.unitCol && unitIdSet.size > 0) {
        q = q.or(`${opts.unitCol}.in.(${unitIds.join(',')}),${opts.unitCol}.is.null`);
      }
      return q as T;
    },
    [isGlobal, plantIds, unitIds, unitIdSet],
  );

  // ── Stores ────────────────────────────────────────────────────────────────
  // storeIdFor is the single place that answers "where does this factory's
  // stock live". One row per factory ⇒ its own store (today's behaviour); three
  // Rehla rows ⇒ the same shared store.
  const storeByPlant = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of plantStore) if (!m.has(r.plant_id)) m.set(r.plant_id, r.store_id);
    return m;
  }, [plantStore]);

  const storeIdFor = useCallback(
    (plantId: string | null | undefined) => (plantId ? storeByPlant.get(plantId) ?? null : null),
    [storeByPlant],
  );

  // Reachable either directly (user_stores) or through a factory the user is in.
  const allowedStoreIds = useMemo(() => {
    if (isGlobal) return new Set(stores.map((s) => s.id));
    const s = new Set(storeIds);
    for (const pid of plantIds) { const sid = storeByPlant.get(pid); if (sid) s.add(sid); }
    return s;
  }, [isGlobal, stores, storeIds, plantIds, storeByPlant]);

  const allowedStores = useMemo(
    () => (isGlobal ? stores : stores.filter((s) => allowedStoreIds.has(s.id))),
    [isGlobal, stores, allowedStoreIds],
  );

  const storeQuery = useCallback(
    <T,>(query: T, opts?: { storeCol?: string; plantCol?: string | null }): T => {
      if (isGlobal) return query;
      const filter = storeScopeFilter([...allowedStoreIds], plantIds, opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = query;
      // No grant of either kind → match nothing, rather than everything.
      if (!filter) return q.eq(opts?.storeCol ?? 'store_id', NIL_UUID) as T;
      return q.or(filter) as T;
    },
    [isGlobal, allowedStoreIds, plantIds],
  );

  const value: PlantScopeValue = {
    ready: refDataReady && scopeReady,
    isGlobal,
    plantIds,
    unitIds,
    plants,
    units,
    locations,
    stores,
    storeIdFor,
    allowedStores,
    storeQuery,
    allowedPlants,
    allowedUnits,
    inScope,
    scopeQuery,
    refresh,
  };

  return <PlantScopeContext.Provider value={value}>{children}</PlantScopeContext.Provider>;
}

export function usePlantScope(): PlantScopeValue {
  const ctx = useContext(PlantScopeContext);
  if (!ctx) throw new Error('usePlantScope must be used inside <PlantScopeProvider>');
  return ctx;
}
