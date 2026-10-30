import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRoleContext } from '../../../contexts/RoleContext';
import { displayLocationName } from '../../../lib/plantLabels';
import type { Directory } from './usersData';

/**
 * Busy's user list: one row per person (or role template). Click a row — or
 * pick it above and press Modify — to open the Modify screen.
 */
export function UserList({ dir, view, onView, onOpen, onAdd }: {
  dir: Directory;
  view: 'people' | 'roles';
  onView: (v: 'people' | 'roles') => void;
  onOpen: (kind: 'person' | 'role', id: string) => void;
  onAdd: (kind: 'person' | 'role') => void;
}) {
  const { t } = useTranslation();
  const { roles, can } = useRoleContext();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const people = useMemo(() => dir.users.filter((u) => !needle
    || [u.name, u.mobile, u.email, u.designation, u.role_label, u.plants?.name || u.plant_name].some((x) => (x || '').toLowerCase().includes(needle))), [dir.users, needle]);
  const roleRows = useMemo(() => roles.filter((r) => !needle || r.label.toLowerCase().includes(needle) || r.id.includes(needle)), [roles, needle]);

  return (
    <section className="bz bz-box" data-testid="user-list">
      <div className="bz-head">
        <span className="flex items-center gap-1">
          <button type="button" className={`bz-btn ${view === 'people' ? 'bz-btn-primary' : ''}`} aria-pressed={view === 'people'} onClick={() => onView('people')}>{t('um.users', 'Users')} ({dir.users.length})</button>
          {can('manage_roles') && <button type="button" className={`bz-btn ${view === 'roles' ? 'bz-btn-primary' : ''}`} aria-pressed={view === 'roles'} onClick={() => onView('roles')}>{t('um.roleTemplates', 'Role templates')} ({roles.length})</button>}
        </span>
        <input className="bz-in max-w-[280px] max-sm:max-w-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('um.searchList', 'Search name, mobile, role, plant…')} aria-label={t('um.searchList', 'Search name, mobile, role, plant…')} />
      </div>
      <div className="overflow-x-auto">
        {view === 'people' ? (
          <table className="bz-list">
            <thead>
              <tr>
                <th style={{ width: 44 }}>{t('um.sno', 'S.No')}</th>
                <th>{t('userMgmt.colName')}</th>
                <th>{t('um.userType', 'User type (role) *').replace(' *', '')}</th>
                <th>{t('userMgmt.colMobile')}</th>
                <th>{t('um.plantBranch', 'Plant / branch')}</th>
                <th>{t('userMgmt.colDesignation')}</th>
                <th>{t('um.login', 'Login')}</th>
                <th>{t('um.active', 'Active')}</th>
              </tr>
            </thead>
            <tbody>
              {dir.loading && people.length === 0 && <tr><td colSpan={8} className="text-center text-slate-400">{t('userMgmt.loading')}</td></tr>}
              {!dir.loading && people.length === 0 && <tr><td colSpan={8} className="text-center text-slate-400">{dir.users.length ? t('userMgmt.emptyNoMatch') : t('userMgmt.emptyNoUsers')}</td></tr>}
              {people.map((u, i) => (
                <tr key={u.id} onClick={() => onOpen('person', u.id)} data-testid="user-row">
                  <td className="text-right">{i + 1}.</td>
                  <td className="font-semibold">
                    <button type="button" className="text-left font-semibold underline-offset-2 hover:underline max-sm:min-h-[44px] max-sm:w-full" onClick={(e) => { e.stopPropagation(); onOpen('person', u.id); }}>{u.name}</button>
                  </td>
                  <td>{u.role_label || roles.find((r) => r.id === u.role_id)?.label || u.role_id || '—'}</td>
                  <td>{u.mobile || '—'}</td>
                  <td>{u.is_global ? t('um.allPlantsShort', 'All plants') : displayLocationName(u.plants?.name || u.plant_name) || '—'}</td>
                  <td>{u.designation || '—'}</td>
                  <td className={u.auth_user_id ? 'text-emerald-700 font-bold' : 'text-slate-400'}>{u.auth_user_id ? 'Y' : 'N'}</td>
                  <td className={u.is_active ? 'text-emerald-700 font-bold' : 'text-red-700 font-bold'}>{u.is_active ? 'Y' : 'N'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="bz-list">
            <thead>
              <tr>
                <th style={{ width: 44 }}>{t('um.sno', 'S.No')}</th>
                <th>{t('um.roleTemplate', 'Role template')}</th>
                <th>{t('userMgmt.colLevel')}</th>
                <th>{t('um.usersInRole', 'Users')}</th>
                <th>{t('um.pages', 'Pages')}</th>
              </tr>
            </thead>
            <tbody>
              {roleRows.map((r, i) => (
                <tr key={r.id} onClick={() => onOpen('role', r.id)} data-testid="role-row">
                  <td className="text-right">{i + 1}.</td>
                  <td className="font-semibold">
                    <button type="button" className="text-left font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); onOpen('role', r.id); }}>{r.label}</button>
                    {(r.is_admin || r.is_system) && <span className="bz-tag text-amber-700 ml-1">{t('userMgmt.locked', 'Locked')}</span>}
                  </td>
                  <td>{r.level}</td>
                  <td>{dir.users.filter((u) => u.role_id === r.id).length}</td>
                  <td>{r.allowed_routes?.includes('*') ? t('userMgmt.allSections', 'All sections') : (r.allowed_routes?.length || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-wrap gap-2 px-2 py-2 border-t border-slate-300 bg-slate-50">
        {view === 'people' && can('manage_users') && <button type="button" className="bz-btn bz-btn-primary" onClick={() => onAdd('person')}>{t('um.addUser', 'Add User')}</button>}
        {view === 'roles' && can('manage_roles') && <button type="button" className="bz-btn bz-btn-primary" onClick={() => onAdd('role')}>{t('um.addRole', 'Add Role template')}</button>}
        <span className="text-[11.5px] text-slate-500 self-center">{t('um.listHint', 'Click a row (or pick above and press Modify) to open Modify — details, User Controls and Menu Rights on one screen.')}</span>
      </div>
    </section>
  );
}
