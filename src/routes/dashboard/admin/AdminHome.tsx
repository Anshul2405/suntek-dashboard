import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRoleContext } from '../../../contexts/RoleContext';
import { isAdminProfile, isManagementProfile } from '../../../lib/profiles';
import { AccessControl } from '../AccessControl';
import { useDirectory } from './usersData';
import { UserList } from './UserList';
import { ModifyUser, type ModifyTarget } from './ModifyUser';

type Extra = 'backup' | 'latebills' | 'purchasers';
const EXTRAS: Extra[] = ['backup', 'latebills', 'purchasers'];

/**
 * User Management, the Busy way:
 *   User list  →  Modify user (details + User Controls + Menu Rights tree + Back dated entries, one Save / Quit).
 * A role template opens in the same Modify screen. Backup, late bills and
 * purchasers are not Menu Rights: a thin link at the top.
 *
 * URL: ?user=<id|new> · ?role=<id|new> · ?view=roles · ?tab=backup|latebills|purchasers
 * (old links ?tab=people|menu|verbs|backdate land on the list; ?tab=roles on role templates).
 */
export function AdminHome() {
  const { t } = useTranslation();
  const { activeProfile, can, roles } = useRoleContext();
  const [params, setParams] = useSearchParams();
  const dir = useDirectory();
  const [dirty, setDirty] = useState(false);
  const admin = isAdminProfile(activeProfile);
  const mgmt = isManagementProfile(activeProfile);
  const canList = can('manage_users') || can('manage_roles');
  const canExtras = admin || mgmt;

  const userParam = params.get('user');
  const roleParam = params.get('role');
  const tabParam = params.get('tab');
  const extra = EXTRAS.includes(tabParam as Extra) && canExtras ? (tabParam as Extra) : null;
  const view: 'people' | 'roles' = params.get('view') === 'roles' || tabParam === 'roles' ? 'roles' : 'people';
  const target: ModifyTarget | null = userParam ? { kind: 'person', id: userParam } : roleParam && can('manage_roles') ? { kind: 'role', id: roleParam } : null;

  const go = useCallback((next: Record<string, string>) => {
    if (dirty && !window.confirm(t('um.discard', 'Discard the changes on this screen?'))) return false;
    setDirty(false);
    setParams(next);
    return true;
  }, [dirty, setParams, t]);

  // Busy's top bar: [User list ▾] [Modify] [◀ Prev] [Next ▶]
  const [picked, setPicked] = useState('');
  const pickValue = target ? `${target.kind}:${target.id}` : picked;
  const ring = view === 'roles' || target?.kind === 'role'
    ? roles.map((r) => `role:${r.id}`)
    : dir.users.map((u) => `person:${u.id}`);
  const openKey = (key: string) => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (!id) return;
    go(kind === 'role' ? { role: id } : { user: id });
  };
  const step = (d: 1 | -1) => {
    if (!ring.length) return;
    const i = ring.indexOf(pickValue);
    openKey(ring[(i + d + ring.length) % ring.length] ?? ring[0]);
  };

  if (!canList && !canExtras) {
    return <div className="card2 p-6 text-sm text-slate-600">{t('admin.noTabs', 'Nothing here is open to your login.')}</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="bz bz-box flex flex-wrap items-center gap-2 px-2 py-1.5" data-testid="um-topbar">
        {canList && (<>
          <button type="button" className={`bz-btn ${!target && !extra ? 'bz-btn-primary' : ''}`} onClick={() => go(view === 'roles' ? { view: 'roles' } : {})}>{t('um.userList', 'User list')}</button>
          <select className="bz-in max-w-[320px] max-sm:max-w-none" aria-label={t('um.pickSubject', 'Pick a person or role template')} value={pickValue}
            onChange={(e) => { if (target) openKey(e.target.value); else setPicked(e.target.value); }}>
            <option value="">{t('um.pickSubject', 'Pick a person or role template')}</option>
            {target?.kind === 'person' && target.id === 'new' && <option value="person:new">{t('um.addUser', 'Add User')}</option>}
            {target?.kind === 'role' && target.id === 'new' && <option value="role:new">{t('um.addRole', 'Add Role template')}</option>}
            <optgroup label={t('um.users', 'Users')}>
              {dir.users.map((u) => <option key={u.id} value={`person:${u.id}`}>{u.name}{u.role_label ? ` · ${u.role_label}` : ''}</option>)}
            </optgroup>
            {can('manage_roles') && (
              <optgroup label={t('um.roleTemplates', 'Role templates')}>
                {roles.map((r) => <option key={r.id} value={`role:${r.id}`}>{r.label}</option>)}
              </optgroup>
            )}
          </select>
          <button type="button" className="bz-btn" disabled={!pickValue} onClick={() => openKey(pickValue)}>{t('um.modify', 'Modify')}</button>
          <button type="button" className="bz-btn" aria-label={t('um.prev', 'Previous')} onClick={() => step(-1)}>◀</button>
          <button type="button" className="bz-btn" aria-label={t('um.next', 'Next')} onClick={() => step(1)}>▶</button>
        </>)}
          {canExtras && (
            <span className="ml-auto flex flex-wrap gap-x-3 text-[12px] max-sm:ml-0">
              <button type="button" className={`underline ${extra === 'backup' ? 'font-bold' : 'text-slate-600'} max-sm:min-h-[44px]`} onClick={() => go({ tab: 'backup' })}>{t('admin.tabBackup', 'Backup')}</button>
              <button type="button" className={`underline ${extra === 'latebills' ? 'font-bold' : 'text-slate-600'} max-sm:min-h-[44px]`} onClick={() => go({ tab: 'latebills' })}>{t('admin.tabLateBills', 'Late bills & categories')}</button>
              {admin && <button type="button" className={`underline ${extra === 'purchasers' ? 'font-bold' : 'text-slate-600'} max-sm:min-h-[44px]`} onClick={() => go({ tab: 'purchasers' })}>{t('um.purchasers', 'Purchasers')}</button>}
            </span>
          )}
      </div>

      {extra === 'backup' && <AccessControl part="backup" />}
      {extra === 'latebills' && <AccessControl part="lateBills" />}
      {extra === 'purchasers' && <AccessControl part="purchasers" />}
      {!extra && canList && target && (
        <ModifyUser
          key={`${target.kind}:${target.id}`}
          target={target}
          dir={dir}
          setDirty={setDirty}
          onQuit={() => { setDirty(false); setParams(target.kind === 'role' ? { view: 'roles' } : {}); }}
          onSaved={(next) => { setDirty(false); setParams(next.kind === 'role' ? { role: next.id } : { user: next.id }, { replace: true }); }}
        />
      )}
      {!extra && canList && !target && (
        <UserList
          dir={dir}
          view={view}
          onView={(v) => go(v === 'roles' ? { view: 'roles' } : {})}
          onOpen={(kind, id) => go(kind === 'role' ? { role: id } : { user: id })}
          onAdd={(kind) => go(kind === 'role' ? { role: 'new' } : { user: 'new' })}
        />
      )}
      {!extra && !canList && <div className="card2 p-6 text-sm text-slate-600">{t('um.pickExtra', 'Pick Backup or Late bills above.')}</div>}
    </div>
  );
}
