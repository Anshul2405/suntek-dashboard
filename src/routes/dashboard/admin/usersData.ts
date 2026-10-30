import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchActivePlants } from '../../../lib/plants';

/** A user row for display — a user_accounts row (+ plants join). */
export interface DisplayUser {
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
  is_global?: boolean | null;
  created_at: string | null;
  auth_user_id?: string | null;
  login_enabled?: boolean | null;
  preferred_language?: string | null;
}

export interface Directory {
  users: DisplayUser[];
  plants: { id: string; name: string }[];
  units: { id: string; plant_id: string; name: string }[];
  tiers: { id: string; label: string; rank: number }[];
  loading: boolean;
  reload: () => Promise<void>;
}

type Snapshot = Pick<Directory, 'users' | 'plants' | 'units' | 'tiers'>;

/** One read of the people list + plants / units / tiers (no state here). */
async function readDirectory(): Promise<Snapshot> {
  const [usersRes, { data: plantsData }, { data: unitsData }, { data: tiersData }] = await Promise.all([
    // RLS already hides soft-deleted rows (migration 75); the filter keeps the intent obvious.
    supabase.from('user_accounts').select('*, plants(name)').or('is_deleted.is.null,is_deleted.eq.false').order('name', { ascending: true }).returns<DisplayUser[]>(),
    fetchActivePlants<{ id: string; name: string }>('id, name'),
    supabase.from('units').select('id, plant_id, name').order('name').returns<{ id: string; plant_id: string; name: string }[]>(),
    supabase.from('tiers').select('id, label, rank').order('rank').returns<{ id: string; label: string; rank: number }[]>(),
  ]);
  // The plants(name) embed can fail (stale relationship); never let it blank the list.
  let usersData = usersRes.data;
  if (usersRes.error) {
    console.error('[UserManagement] user_accounts join (plants) failed — plain select. Error:', usersRes.error);
    const retry = await supabase.from('user_accounts').select('*').order('name', { ascending: true }).returns<DisplayUser[]>();
    usersData = retry.data;
  }
  return { users: usersData || [], plants: plantsData || [], units: unitsData || [], tiers: tiersData || [] };
}

/** The people list + plants / units / tiers the Modify screen needs (was inside UserManagement). */
export function useDirectory(): Directory {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const apply = useCallback((d: Snapshot) => setSnap((prev) => ({
    ...d,
    // Keep the last good plants / tiers if a read comes back empty.
    plants: d.plants.length ? d.plants : prev?.plants ?? [],
    tiers: d.tiers.length ? d.tiers : prev?.tiers ?? [],
  })), []);
  const reload = useCallback(async () => { apply(await readDirectory()); }, [apply]);
  useEffect(() => {
    let alive = true;
    void readDirectory().then((d) => { if (alive) apply(d); });
    return () => { alive = false; };
  }, [apply]);
  return { users: snap?.users ?? [], plants: snap?.plants ?? [], units: snap?.units ?? [], tiers: snap?.tiers ?? [], loading: !snap, reload };
}
