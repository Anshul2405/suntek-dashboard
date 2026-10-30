import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { humanizeError } from '../../../lib/errors';
import { insertRows, updateRows } from '../../../lib/db';
import { createLogin, updateLogin } from '../../../lib/adminUsers';
import { useMentionNotifier } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { useRoleContext } from '../../../contexts/RoleContext';
import { logUserAccountEvent } from '../../../lib/userEvents';
import type { Directory, DisplayUser } from './usersData';

export const BLANK_FORM = {
  name: '', mobile: '', email: '', whatsapp: '',
  // role_id = PRIMARY role (display + login); role_ids = the full multi-role set.
  role_id: '', role_ids: [] as string[],
  designation: '',
  access_note: '', is_active: true,
  login_enabled: false, password: '',
  preferred_language: 'en',
  // Data scope (27_plant_unit_scoping.sql): which plants / units / stores this user may see.
  is_global: false,
  plant_ids: [] as string[],
  unit_ids: [] as string[],
  store_ids: [] as string[],
};
export type PersonForm = typeof BLANK_FORM;

const same = (a: PersonForm, b: PersonForm) => JSON.stringify(a) === JSON.stringify(b);

/** The form as the list row has it (before roles / plants / stores are read). */
function baseForm(u: DisplayUser): PersonForm {
  return {
    name: u.name || '',
    mobile: u.mobile || '',
    email: u.email || '',
    whatsapp: u.whatsapp || '',
    role_id: u.role_id && u.role_id !== 'night_manager' ? u.role_id : '',
    role_ids: u.role_id && u.role_id !== 'night_manager' ? [u.role_id] : [],
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
  };
}

/**
 * One person on the Modify user screen: load, edit, save.
 * The save is the old User Management save, step for step: directory row →
 * login (edge function) → roles / plants / units / stores → history → mentions
 * → blacklist screen. Returns the account id, or null when it did not save.
 */
export function usePersonEditor(dir: Directory, user: DisplayUser | undefined) {
  const { t } = useTranslation();
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const { activeProfile, roles } = useRoleContext();
  const [editing, setEditing] = useState<DisplayUser | null>(null);
  const [form, setForm] = useState<PersonForm>({ ...BLANK_FORM });
  const [baseline, setBaseline] = useState<PersonForm>({ ...BLANK_FORM });
  const [membersFor, setMembersFor] = useState<string | null>(null);

  // The row from the list → the form (derived state: once per person; the
  // Modify screen mounts fresh for each person). A new person keeps BLANK_FORM.
  if (user && editing?.id !== user.id) {
    const base = baseForm(user);
    setEditing(user);
    setForm(base);
    setBaseline(base);
  }

  // Roles / plants / units / stores they hold (the pickers).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    void Promise.all([
      supabase.from('user_plants').select('plant_id').eq('user_account_id', user.id).returns<{ plant_id: string }[]>(),
      supabase.from('user_units').select('unit_id').eq('user_account_id', user.id).returns<{ unit_id: string }[]>(),
      supabase.from('user_roles').select('role_id').eq('user_account_id', user.id).returns<{ role_id: string }[]>(),
      // Absent before migration 59 — resolves with an error rather than throwing.
      supabase.from('user_stores').select('store_id').eq('user_account_id', user.id).returns<{ store_id: string }[]>(),
    ]).then(([{ data: ups }, { data: uus }, { data: urs }, ussRes]) => {
      if (!alive) return;
      const base = baseForm(user);
      // Primary first; the retired night_manager role never comes back.
      const roleIds = (urs || []).map((r) => r.role_id).filter((id) => id !== 'night_manager');
      const primary = base.role_id;
      const ordered = primary ? [primary, ...roleIds.filter((id) => id !== primary)] : roleIds;
      const loaded: PersonForm = {
        ...base,
        plant_ids: (ups || []).map((r) => r.plant_id),
        unit_ids: (uus || []).map((r) => r.unit_id),
        store_ids: (ussRes.data || []).map((r) => r.store_id),
        role_ids: ordered.length ? ordered : base.role_ids,
        role_id: ordered[0] || base.role_id,
      };
      setForm(loaded);
      setBaseline(loaded);
      setMembersFor(user.id);
    });
    return () => { alive = false; };
  }, [user]);
  const loadingPerson = !!user && membersFor !== user.id;

  const dirty = !same(form, baseline);
  const roleOptions = roles.map((r) => ({ id: r.id, label: r.label }));

  /** The reason Save is blocked for the person part (null = fine). */
  function problem(): string | null {
    if (!form.name.trim()) return t('userMgmt.errNameRequired', 'Name is required.');
    if (!form.email.trim() && !form.mobile.trim()) return t('userMgmt.contactHint');
    if (!form.role_ids.length) return t('userMgmt.errSelectRole', 'Select at least one role');
    if (form.login_enabled && !editing?.auth_user_id && form.password.length < 8) return t('userMgmt.errPasswordMin');
    return null;
  }

  async function save(): Promise<{ accountId: string | null; error: string | null; warning?: string | null }> {
    const bad = problem();
    if (bad) return { accountId: null, error: bad };
    const existingAuthId = editing?.auth_user_id || null;
    // Provisioning a login needs a REAL admin session (never a half-user).
    if (form.login_enabled) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return { accountId: null, error: t('userMgmt.errNoSessionForLogin') };
    }
    const primaryPlantId = form.is_global ? null : (form.plant_ids[0] || null);
    const primaryPlant = dir.plants.find((p) => p.id === primaryPlantId);
    const email = form.email.trim() || null;
    const payload = {
      name: form.name.trim(),
      mobile: form.mobile.trim(),
      email,
      whatsapp: form.whatsapp.trim() || null,
      role_id: form.role_id,
      role_label: roleOptions.find((r) => r.id === form.role_id)?.label || form.role_id,
      plant_id: primaryPlantId,
      plant_name: primaryPlant?.name || null,
      designation: form.designation.trim() || null,
      access_note: form.access_note.trim() || null,
      is_active: form.is_active,
      is_global: form.is_global,
      preferred_language: form.preferred_language || 'en',
    };

    // 1) Directory row.
    let accountId = editing?.id || '';
    if (editing) {
      const { error } = await updateRows('user_accounts', payload).eq('id', editing.id);
      if (error) return { accountId: null, error: t('userMgmt.errUpdateFailed', { msg: error.message }) };
    } else {
      const { data, error } = await insertRows('user_accounts', payload).select('id').single();
      if (error) {
        const dupMobile = /duplicate|unique/i.test(error.message) && /mobile/i.test(error.message);
        return { accountId: null, error: dupMobile ? t('userMgmt.errDuplicateMobile') : t('userMgmt.errSaveFailed', { msg: error.message }) };
      }
      accountId = (data as { id?: string } | null)?.id || '';
    }

    // 2) Login via the service_role edge function.
    if (form.login_enabled) {
      if (existingAuthId) {
        const { error } = await updateLogin({
          auth_user_id: existingAuthId, user_account_id: accountId, email: email || undefined,
          password: form.password || undefined, // blank = keep the current password
          name: form.name.trim(), role_id: form.role_id, plant_id: primaryPlant?.id || null,
        });
        if (error) return { accountId, error: humanizeError(error, { action: 'update this login', context: 'UserManagement.updateLogin' }) };
      } else {
        const { error } = await createLogin({
          user_account_id: accountId, email: email ?? undefined, password: form.password,
          name: form.name.trim(), role_id: form.role_id, plant_id: primaryPlant?.id || null,
        });
        if (error) {
          // Roll back a brand-new directory row so a retry does not hit the unique phone.
          if (!editing && accountId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase.from('user_accounts') as any).delete().eq('id', accountId);
          }
          return { accountId: null, error: humanizeError(error, { action: 'create this login', context: 'UserManagement.createLogin' }) };
        }
      }
    }

    // 3) Roles / plants / units / stores (replace-all; a global user needs no plants).
    if (accountId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: delRolesErr } = await (supabase.from('user_roles') as any).delete().eq('user_account_id', accountId);
      if (delRolesErr) return { accountId, error: t('userMgmt.errRolesSync', { defaultValue: 'Could not update roles: {{msg}}', msg: delRolesErr.message }) };
      const roleIds = form.role_ids.length ? form.role_ids : (form.role_id ? [form.role_id] : []);
      if (roleIds.length) {
        const { error } = await insertRows('user_roles', roleIds.map((rid) => ({ user_account_id: accountId, role_id: rid })));
        if (error) return { accountId, error: t('userMgmt.errRolesSync', { defaultValue: 'Could not update roles: {{msg}}', msg: error.message }) };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('user_plants') as any).delete().eq('user_account_id', accountId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('user_units') as any).delete().eq('user_account_id', accountId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase.from('user_stores') as any).delete().eq('user_account_id', accountId);
      if (!form.is_global) {
        if (form.plant_ids.length) await insertRows('user_plants', form.plant_ids.map((pid) => ({ user_account_id: accountId, plant_id: pid })));
        const validUnitIds = form.unit_ids.filter((uid) => {
          const u = dir.units.find((x) => x.id === uid);
          return u && form.plant_ids.includes(u.plant_id);
        });
        if (validUnitIds.length) await insertRows('user_units', validUnitIds.map((uid) => ({ user_account_id: accountId, unit_id: uid })));
        // Store access is its own grant — never derived from the factories.
        if (form.store_ids.length) await insertRows('user_stores', form.store_ids.map((sid) => ({ user_account_id: accountId, store_id: sid })));
      }
    }

    // 4) Profile history.
    const actor = { actorName: activeProfile.name, actorRole: activeProfile.id };
    if (editing) {
      const changed: string[] = [];
      if (form.name.trim() !== (editing.name || '')) changed.push('name');
      if (email !== (editing.email || null)) changed.push('email');
      if (form.mobile.trim() !== (editing.mobile || '')) changed.push('contact');
      if (form.role_id !== editing.role_id) changed.push('role');
      if ((form.preferred_language || 'en') !== (editing.preferred_language || 'en')) changed.push('language');
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
        details: `Created${form.login_enabled ? ' with login' : ' (directory only)'} · role ${roleOptions.find((r) => r.id === form.role_id)?.label || form.role_id}`,
        ...actor,
      });
    }

    await notifyMentions(form.access_note, {
      entityType: 'user_account', entityId: accountId || undefined,
      entityLabel: t('userMgmt.entityLabel', { defaultValue: 'User · {{name}}', name: form.name.trim() }), route: '/dashboard/users',
    });
    const hits = await screenBlacklist(
      [{ value: form.name, label: t('userMgmt.colName') }, { value: form.designation, label: t('userMgmt.colDesignation') }],
      { workflow: 'User Management', source: 'entry', entityLabel: t('userMgmt.entityLabel', { defaultValue: 'User · {{name}}', name: form.name.trim() }) },
    );
    let warning: string | null = null;
    if (hits.length) {
      const h = hits[0];
      warning = t('userMgmt.blacklistHit', { defaultValue: '⚠ "{{value}}" ≈ blacklisted {{type}} "{{name}}" ({{pct}}%). Admin notified.', value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) });
    }
    const savedForm = { ...form, password: '' };
    setForm(savedForm);
    setBaseline(savedForm);
    return { accountId, error: null, warning };
  }

  return { editing, form, setForm, save, dirty, problem, loadingPerson };
}
