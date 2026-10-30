import { useMemo } from 'react';
import { useRoleContext } from '../../contexts/RoleContext';
import { useOpsSettings, type ModuleKey, type Verb } from '../opsControls';
import { isAdminProfile } from '../profiles';
import { allowedTabs, backDaysFor, canDo, canSeeTab } from './rights';

/** The active person's rights (User Management), bound to their profile + person id. */
export function useRights() {
  const { activeProfile, activePersonId, roles } = useRoleContext();
  const ops = useOpsSettings();
  return useMemo(() => {
    // Each role's own pages, so a never-configured role keeps every tab only
    // where that role can open the page.
    const roleRoutes = (id: string) => roles.find((r) => r.id === id)?.allowed_routes;
    return {
      /** False until the saved settings are read (non-admins get no tab / verb meanwhile). */
      loaded: !!ops.loaded || isAdminProfile(activeProfile),
      canSeeTab: (route: string, tab: string) => canSeeTab(ops, activeProfile, activePersonId, route, tab, roleRoutes),
      tabs: (route: string) => allowedTabs(ops, activeProfile, activePersonId, route, roleRoutes),
      can: (module: ModuleKey, verb: Verb) => canDo(ops, activeProfile, activePersonId, module, verb, roleRoutes),
      backDays: (module: string, plantIds: (string | null | undefined)[] = []) => backDaysFor(ops, module, plantIds),
    };
  }, [ops, activeProfile, activePersonId, roles]);
}
