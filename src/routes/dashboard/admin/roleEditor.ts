import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { useRoleContext } from '../../../contexts/RoleContext';
import type { RoleRow } from '../../../lib/profiles';

export interface RoleForm {
  label: string;
  id: string;
  level: string;
  home_route: string;
  standalone_only: boolean;
  allowed_routes: string[];
  capabilities: string[];
}

export const BLANK_ROLE: RoleForm = { label: '', id: '', level: 'L4', home_route: '/dashboard', standalone_only: false, allowed_routes: [], capabilities: [] };

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** A role template on the Modify screen (the old Roles tab form, same save). */
export function useRoleEditor(row: RoleRow | undefined) {
  const { t } = useTranslation();
  const { roles, refreshRoles } = useRoleContext();
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [form, setForm] = useState<RoleForm>(BLANK_ROLE);
  const [baseline, setBaseline] = useState<RoleForm>(BLANK_ROLE);
  const [slugTouched, setSlugTouched] = useState(false);

  // The role row → the form (derived state: once per role; a new role keeps BLANK_ROLE).
  if (row && editing?.id !== row.id) {
    const r = row;
    const f: RoleForm = {
      label: r.label,
      id: r.id,
      level: r.level,
      home_route: r.home_route || '/dashboard',
      standalone_only: r.standalone_only,
      allowed_routes: r.allowed_routes?.includes('*') ? ['*'] : (r.allowed_routes || []),
      capabilities: r.capabilities || [],
    };
    setEditing(r);
    setSlugTouched(true);
    setForm(f);
    setBaseline(f);
  }

  const setLabel = (label: string) => setForm((f) => ({ ...f, label, id: editing || slugTouched ? f.id : slugify(label) }));
  const setSlug = (id: string) => { setSlugTouched(true); setForm((f) => ({ ...f, id })); };
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  /** The id the role has or will get. */
  const roleId = editing ? editing.id : slugify(form.id || form.label);
  const locked = !!editing && (editing.is_admin || editing.is_system);

  async function save(): Promise<{ id: string | null; error: string | null }> {
    const label = form.label.trim();
    if (!label) return { id: null, error: t('userMgmt.errRoleNameRequired', 'Role name is required') };
    const id = editing ? editing.id : (slugTouched ? slugify(form.id) : slugify(label));
    if (!id) return { id: null, error: t('userMgmt.errRoleSlugRequired', 'A valid slug id is required') };
    if (locked) return { id, error: null };
    if (!editing && roles.some((r) => r.id === id)) return { id: null, error: t('userMgmt.errRoleIdExists', { defaultValue: 'A role with id "{{id}}" already exists', id }) };
    const payload = {
      label,
      level: form.level,
      home_route: form.home_route.trim() || '/dashboard',
      allowed_routes: form.allowed_routes,
      standalone_only: form.standalone_only,
      capabilities: form.capabilities,
    };
    if (editing) {
      const { error } = await updateRows('roles', payload).eq('id', editing.id);
      if (error) return { id: null, error: t('userMgmt.errSaveFailed', { msg: error.message }) };
    } else {
      const { error } = await insertRows('roles', {
        id, ...payload, is_admin: false, is_system: false,
        description: null, avatar_from: null, avatar_to: null,
        sort_order: (roles.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0)) + 1,
      });
      if (error) return { id: null, error: t('userMgmt.errRoleCreateFailed', { defaultValue: 'Create failed: {{msg}}', msg: error.message }) };
    }
    await refreshRoles();
    setBaseline(form);
    return { id, error: null };
  }

  /** Delete a role nobody holds (same checks as before). */
  async function remove(r: RoleRow, holders: number): Promise<string | null> {
    if (r.is_admin || r.is_system) return null;
    if (holders > 0) return t('userMgmt.errRoleInUse', { defaultValue: 'Cannot delete "{{label}}" — users are still assigned to it', label: r.label });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('roles') as any).delete().eq('id', r.id);
    if (error) return t('userMgmt.errRoleDeleteFailed', { defaultValue: 'Delete failed: {{msg}}', msg: error.message });
    await refreshRoles();
    return null;
  }

  return { editing, form, setForm, setLabel, setSlug, save, remove, dirty, roleId, locked };
}
