import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { useRoleContext } from '../contexts/RoleContext';

/**
 * Every value a row's "raised by" may hold for the person on screen: their name
 * (older rows) and their auth user id (store_requisitions.raised_by is a uuid).
 * While an admin previews someone else, only that person's ids count.
 */
export function useMyIdentity(): { name: string; ids: string[]; authUserId: string | null } {
  const { activeProfile, isViewingAs } = useRoleContext();
  const [sessionUid, setSessionUid] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => { if (alive) setSessionUid(data.session?.user?.id ?? null); });
    return () => { alive = false; };
  }, []);
  const authUserId = activeProfile.authUserId ?? (isViewingAs ? null : sessionUid);
  const ids = [activeProfile.name, authUserId].filter((v): v is string => !!v);
  return { name: activeProfile.name, ids, authUserId };
}
