import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { useToast } from '../../../components/ui/toast';
import { useStepUp } from '../../../lib/useStepUp';
import { LANGUAGE_OPTIONS } from '../../../lib/userEvents';
import { CAPABILITIES, isAdminProfile, type RoleRow } from '../../../lib/profiles';
import { saveOpsSettings, useOpsSettings, type OpsSettings, type PhotoKey } from '../../../lib/opsControls';
import { BOOK_ROUTE, configuredTabRoles } from '../../../lib/access/rights';
import { branchIds, buildRightsTree, setTick, type RightsSubject, type TreeNode } from '../../../lib/access/rightsTree';
import { remapPerson, remapRole, rightsChanged } from '../../../lib/access/rightsDraft';
import { RightsTree } from './RightsTree';
import { BackDatedDialog } from './BackDatedDialog';
import { DeleteUserDialog, HistoryPanel } from './PersonExtras';
import { usePersonEditor } from './personEditor';
import { useRoleEditor } from './roleEditor';
import type { Directory, DisplayUser } from './usersData';

const PHOTOS: { key: PhotoKey; label: string; labelKey: string }[] = [
  { key: 'heat', label: 'Sees heat sample photos', labelKey: 'um.photoHeat' },
  { key: 'sheet', label: 'Sees batch sheet photos', labelKey: 'um.photoSheet' },
  { key: 'bucket', label: 'Sees bucket photos', labelKey: 'um.photoBucket' },
];

/** Capabilities in plant words (the role's on / off switches). */
const CAP_LABEL: Record<string, string> = {
  manage_users: 'Add / modify users',
  manage_roles: 'Change roles & rights',
  allocate_night_duty: 'Allocate night duty',
  perform_maintenance: 'Do maintenance work',
  view_asset_profile: 'Scan asset QR',
  generate_asset_qr: 'Print asset QR',
  view_asset_analytics: 'Asset repair charts',
  add_stock_purchase: 'Add purchase to stock',
  resolve_stock_anomaly: 'Close stock anomalies',
  complete_periodic_maintenance: 'Complete periodic maintenance',
  return_repairs: 'Book repair returns',
  reverse_repair_return: 'Reverse repair returns',
  delete_user: 'Delete users',
  manage_schedules: 'Schedule setup (add / delete)',
  delete_import_batch: 'Delete uploaded data',
  batch_raw: 'Batch — raw readings',
  batch_sheet: 'Batch — sheet',
  batch_mat: 'Batch — material / history',
  batch_grade: 'Batch — grade select',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="bz-field"><span>{label}</span>{children}</label>;
}

function YN({ label, value, onChange, disabled, tag, tagTitle, testId }: {
  label: string; value: boolean; onChange?: (v: boolean) => void; disabled?: boolean; tag?: string; tagTitle?: string; testId?: string;
}) {
  return (
    <div className="bz-yn-row">
      <span title={label}>{label} {tag && <span className="bz-tag text-slate-400" title={tagTitle}>{tag}</span>}</span>
      <button
        type="button" role="switch" aria-checked={value} aria-label={label} data-testid={testId}
        className="bz-yn" disabled={disabled || !onChange}
        onClick={() => onChange?.(!value)}
      >{value ? 'Y' : 'N'}</button>
    </div>
  );
}

export type ModifyTarget = { kind: 'person'; id: string } | { kind: 'role'; id: string };

/**
 * Busy's Modify User, on one screen:
 *   left  — User Configuration + User Controls (Y / N)
 *   right — Menu Rights tree (pages → tabs → Add / Modify / Delete), Expand / Collapse
 *   [Back dated entries] dialog, and one Save | Quit for everything on the screen.
 * A role template opens in the same screen (its rights are what everyone in it gets).
 */
export function ModifyUser({ target, dir, onQuit, onSaved, setDirty }: {
  target: ModifyTarget;
  dir: Directory;
  onQuit: () => void;
  /** After a first save of a new person / role, the screen moves to its id. */
  onSaved: (next: ModifyTarget) => void;
  setDirty: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile, roles, can } = useRoleContext();
  const { stores, storeIdFor } = usePlantScope();
  const saved = useOpsSettings();
  const { stepUp, modal: stepUpModal } = useStepUp();
  const admin = isAdminProfile(activeProfile);
  const isPerson = target.kind === 'person';
  const isNew = target.id === 'new';
  const rightsEditable = admin;
  const canSavePerson = can('manage_users') || can('manage_roles');
  const canSaveRole = can('manage_roles');

  // ── The subject (the screen mounts fresh per target; the editors read it once) ──
  const targetKey = `${target.kind}:${target.id}`;
  const user: DisplayUser | undefined = isPerson && !isNew ? dir.users.find((u) => u.id === target.id) : undefined;
  const roleRow: RoleRow | undefined = !isPerson && !isNew ? roles.find((r) => r.id === target.id) : undefined;
  const ready = isPerson ? (isNew || !!user) : (isNew || !!roleRow);

  const person = usePersonEditor(dir, user);
  const role = useRoleEditor(roleRow);

  // ── Rights draft (ops_settings) — fresh copy per target / when the saved copy loads ──
  const [draft, setDraft] = useState<OpsSettings>(saved);
  const [draftFor, setDraftFor] = useState('');
  const draftStamp = `${targetKey}|${saved.loaded}`;
  if (draftFor !== draftStamp) { setDraftFor(draftStamp); setDraft(saved); }
  const usedRoleIds = useRef(new Set<string>());

  const personKey = isPerson ? (user ? `db_${user.id}` : 'db_new') : '';
  const subject: RightsSubject = isPerson
    ? { kind: 'person', personId: personKey, roleIds: person.form.role_ids }
    : { kind: 'role', roleId: role.roleId || 'new_role', routes: role.form.allowed_routes };
  const subjectRoles = roles.filter((r) => isPerson && person.form.role_ids.includes(r.id));
  const locked = isPerson
    ? subjectRoles.some((r) => r.is_admin || (r.allowed_routes || []).includes('*'))
    : role.locked || role.form.allowed_routes.includes('*');

  const tree = useMemo(() => buildRightsTree(), []);
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ 'g:operations': true, [`s:${BOOK_ROUTE}`]: true }));
  const [showBack, setShowBack] = useState(false);
  const [historyFor, setHistoryFor] = useState<DisplayUser | null>(null);
  const [deleteFor, setDeleteFor] = useState<DisplayUser | null>(null);
  const [saving, setSaving] = useState(false);
  const capsUnlocked = useRef(false);

  const onTick = (node: TreeNode, on: boolean) => {
    if (!rightsEditable || locked) return;
    if (subject.kind === 'role') usedRoleIds.current.add(subject.roleId);
    const res = setTick(draft, roles, subject, node, on);
    setDraft(res.settings);
    if (res.routes) role.setForm((f) => ({ ...f, allowed_routes: res.routes! }));
  };

  const opsDirty = rightsChanged(saved, draft);
  const formDirty = isPerson ? person.dirty || isNew : role.dirty || isNew;
  const dirty = opsDirty || (isPerson ? person.dirty : role.dirty);
  useEffect(() => { setDirty(dirty); }, [dirty, setDirty]);

  // ── Save | Quit ────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      let ops = draft;
      let next: ModifyTarget | null = null;
      if (isPerson) {
        if (formDirty) {
          if (!canSavePerson) { toast.error(t('um.noRightToSave', 'Your login cannot change users.')); return; }
          const res = await person.save();
          if (res.error) { toast.error(res.error); return; }
          if (res.warning) toast.error(res.warning);
          if (isNew && res.accountId) {
            ops = remapPerson(ops, 'db_new', `db_${res.accountId}`);
            next = { kind: 'person', id: res.accountId };
          }
        }
      } else {
        if (formDirty) {
          if (!canSaveRole) { toast.error(t('um.noRightToSaveRole', 'Your login cannot change roles.')); return; }
          const res = await role.save();
          if (res.error || !res.id) { toast.error(res.error || t('userMgmt.errRoleSlugRequired', 'A valid slug id is required')); return; }
          for (const used of usedRoleIds.current) if (used !== res.id) ops = remapRole(ops, used, res.id);
          if (isNew) next = { kind: 'role', id: res.id };
        }
      }
      if (rightsEditable && rightsChanged(saved, ops)) {
        const modulesTouched = JSON.stringify(saved.modules) !== JSON.stringify(ops.modules);
        const err = await saveOpsSettings({
          ...saved,
          tabs: ops.tabs, tabRoles: ops.tabRoles, people: ops.people, modules: ops.modules,
          backDays: ops.backDays, editWindowHours: ops.editWindowHours,
          photos: ops.photos, photosHiddenFrom: ops.photosHiddenFrom, photosEnforced: ops.photosEnforced,
          enforced: saved.enforced || modulesTouched,
        }, activeProfile.name);
        if (err) { toast.error(err); return; }
      }
      setDraft(ops);
      usedRoleIds.current.clear();
      toast.success(t('um.saved', 'Saved.'));
      await dir.reload();
      if (next) onSaved(next);
    } finally {
      setSaving(false);
    }
  }, [saving, draft, isPerson, formDirty, canSavePerson, canSaveRole, person, role, isNew, rightsEditable, saved, activeProfile.name, toast, t, dir, onSaved]);

  const quit = useCallback(() => {
    if (dirty && !window.confirm(t('um.discard', 'Discard the changes on this screen?'))) return;
    onQuit();
  }, [dirty, onQuit, t]);

  // Busy keys: F2 / Ctrl+S = Save, Esc = Quit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showBack || historyFor || deleteFor) return;
      if (e.key === 'F2' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) { e.preventDefault(); void save(); }
      else if (e.key === 'Escape') { e.preventDefault(); quit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, quit, showBack, historyFor, deleteFor]);

  if (!ready || (isPerson && person.loadingPerson)) {
    return <div className="bz bz-box p-4 text-slate-400">{dir.loading ? '…' : isPerson ? t('um.noSuchUser', 'That user is not in the list.') : t('um.noSuchRole', 'That role is not in the list.')}</div>;
  }

  // ── Left pane ──────────────────────────────────────────────────────────────
  const f = person.form;
  const setF = person.setForm;
  const myRank = dir.tiers.find((x) => x.id === activeProfile.role)?.rank ?? Number.MAX_SAFE_INTEGER;
  const assignable = roles.filter((r) => {
    if (can('manage_roles')) return true;
    if (r.is_admin) return false;
    const rRank = dir.tiers.find((x) => x.id === r.level)?.rank ?? 0;
    if (rRank > myRank) return false;
    return (r.capabilities || []).every((c) => (activeProfile.capabilities || []).includes(c));
  });
  const heldCaps = new Set(subjectRoles.flatMap((r) => r.capabilities || []));
  const hidden = draft.photosHiddenFrom || { heat: [], sheet: [], bucket: [] };
  const personName = f.name.trim().toLowerCase();
  const isHidden = (kind: PhotoKey) => hidden[kind].some((h) => h === personKey || (!!personName && h.trim().toLowerCase() === personName));
  const setHidden = (kind: PhotoKey, hide: boolean) => setDraft((d) => {
    const cur = d.photosHiddenFrom || { heat: [], sheet: [], bucket: [] };
    const rest = cur[kind].filter((h) => h !== personKey && !(personName && h.trim().toLowerCase() === personName));
    return { ...d, photosHiddenFrom: { ...cur, [kind]: hide ? [...rest, personKey] : rest } };
  });
  const capOnForRole = (key: string) => role.form.capabilities.includes(key);
  const toggleRoleCap = async (key: string) => {
    if (!capsUnlocked.current) {
      // Granting or revoking a privileged allowance is sensitive → password once per screen.
      const ok = await stepUp();
      if (!ok) return;
      capsUnlocked.current = true;
    }
    role.setForm((x) => ({ ...x, capabilities: x.capabilities.includes(key) ? x.capabilities.filter((c) => c !== key) : [...x.capabilities, key] }));
  };
  const holders = !isPerson && roleRow ? dir.users.filter((u) => u.role_id === roleRow.id).length : 0;
  const tabsUnset = !isPerson && !configuredTabRoles(draft, BOOK_ROUTE).has(subject.kind === 'role' ? subject.roleId : '');

  const personLeft = (
    <>
      <section className="bz-box">
        <div className="bz-head">{t('um.userConfig', 'User Configuration')}</div>
        <div className="bz-body">
          <Field label={t('userMgmt.fullName')}><input className="bz-in" value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} /></Field>
          <Field label={t('userMgmt.mobileNumber')}><input className="bz-in" type="tel" value={f.mobile} onChange={(e) => setF((x) => ({ ...x, mobile: e.target.value }))} /></Field>
          <Field label={t('userMgmt.whatsappLabel')}><input className="bz-in" type="tel" value={f.whatsapp} onChange={(e) => setF((x) => ({ ...x, whatsapp: e.target.value }))} /></Field>
          <Field label={t('userMgmt.emailLabel')}><input className="bz-in" type="email" value={f.email} onChange={(e) => setF((x) => ({ ...x, email: e.target.value }))} /></Field>
          <Field label={t('um.userType', 'User type (role) *')}>
            <select className="bz-in" value={f.role_id} onChange={(e) => setF((x) => {
              const id = e.target.value;
              const role_ids = id ? [id, ...x.role_ids.filter((r) => r !== id)] : x.role_ids.slice(1);
              return { ...x, role_id: role_ids[0] || '', role_ids };
            })}>
              <option value="">{t('um.pickRole', 'Pick a role…')}</option>
              {assignable.map((r) => <option key={r.id} value={r.id}>{r.label} ({r.level})</option>)}
            </select>
          </Field>
          <Field label={t('um.alsoHolds', 'Also holds')}>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {assignable.filter((r) => r.id !== f.role_id).map((r) => (
                <label key={r.id} className="inline-flex items-center gap-1 max-sm:min-h-[44px]">
                  <input type="checkbox" checked={f.role_ids.includes(r.id)} onChange={(e) => setF((x) => {
                    const role_ids = e.target.checked ? [...x.role_ids, r.id] : x.role_ids.filter((id) => id !== r.id);
                    return { ...x, role_ids, role_id: role_ids[0] || '' };
                  })} />{r.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('um.plantBranch', 'Plant / branch')}>
            {f.is_global ? <span className="font-semibold text-blue-700">{t('userMgmt.allPlantsOn')}</span> : (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {dir.plants.map((p) => (
                  <label key={p.id} className="inline-flex items-center gap-1 max-sm:min-h-[44px]">
                    <input type="checkbox" checked={f.plant_ids.includes(p.id)} onChange={(e) => setF((x) => {
                      const plant_ids = e.target.checked ? [...x.plant_ids, p.id] : x.plant_ids.filter((id) => id !== p.id);
                      const unit_ids = x.unit_ids.filter((uid) => { const u = dir.units.find((y) => y.id === uid); return u && plant_ids.includes(u.plant_id); });
                      return { ...x, plant_ids, unit_ids };
                    })} />{p.name}
                  </label>
                ))}
                {dir.plants.length === 0 && <span className="text-slate-400">{t('userMgmt.noPlants')}</span>}
              </div>
            )}
          </Field>
          {!f.is_global && stores.length > 0 && (
            <Field label={t('userMgmt.storesLabel', 'Store access')}>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {stores.map((st) => {
                  const viaPlant = !f.store_ids.includes(st.id) && f.plant_ids.some((pid) => storeIdFor(pid) === st.id);
                  return (
                    <label key={st.id} className="inline-flex items-center gap-1 max-sm:min-h-[44px]">
                      <input type="checkbox" checked={f.store_ids.includes(st.id)} onChange={(e) => setF((x) => ({ ...x, store_ids: e.target.checked ? [...x.store_ids, st.id] : x.store_ids.filter((id) => id !== st.id) }))} />
                      {st.name}{viaPlant && <span className="text-slate-400 text-[11px]">{t('userMgmt.storeViaFactory', '· via factory')}</span>}
                    </label>
                  );
                })}
              </div>
            </Field>
          )}
          <Field label={t('userMgmt.designationLabel')}><input className="bz-in" value={f.designation} onChange={(e) => setF((x) => ({ ...x, designation: e.target.value }))} /></Field>
          <Field label={t('userMgmt.preferredLanguage')}>
            <select className="bz-in" value={f.preferred_language} onChange={(e) => setF((x) => ({ ...x, preferred_language: e.target.value }))}>
              {LANGUAGE_OPTIONS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </Field>
          <Field label={t('userMgmt.accessNoteLabel')}><textarea className="bz-in" value={f.access_note} onChange={(e) => setF((x) => ({ ...x, access_note: e.target.value }))} /></Field>
          {f.login_enabled && (
            <Field label={person.editing?.auth_user_id ? t('userMgmt.setNewPassword') : t('userMgmt.passwordLabel')}>
              <input className="bz-in" type="password" autoComplete="new-password" value={f.password}
                placeholder={person.editing?.auth_user_id ? t('userMgmt.passwordKeepPlaceholder') : t('userMgmt.passwordNewPlaceholder')}
                onChange={(e) => setF((x) => ({ ...x, password: e.target.value }))} />
            </Field>
          )}
          {!f.email.trim() && !f.mobile.trim() && <p className="text-[11.5px] text-amber-700 mt-1">{t('userMgmt.contactHint')}</p>}
        </div>
      </section>
      <section className="bz-box">
        <div className="bz-head">{t('um.userControls', 'User Controls')}<span className="font-normal text-[11px] text-slate-500">{t('um.ynLegend', 'Y = yes · N = no · R = from the role')}</span></div>
        <div className="bz-body bz-yn-grid" data-testid="user-controls">
          <YN label={t('um.loginAllowed', 'Login allowed')} value={f.login_enabled} onChange={(v) => setF((x) => ({ ...x, login_enabled: v }))} />
          <YN label={t('um.accountActive', 'Account active')} value={f.is_active} onChange={(v) => setF((x) => ({ ...x, is_active: v }))} />
          <YN label={t('um.allPlants', 'All plants (head office)')} value={f.is_global} onChange={(v) => setF((x) => ({ ...x, is_global: v }))} />
          {PHOTOS.map((p) => (
            <YN key={p.key} label={t(p.labelKey, p.label)} value={locked || !isHidden(p.key)} disabled={locked || !rightsEditable} onChange={(v) => setHidden(p.key, !v)} />
          ))}
          {CAPABILITIES.map((c) => (
            <YN key={c.key} label={t(`um.cap_${c.key}`, CAP_LABEL[c.key] || c.label)} value={locked || heldCaps.has(c.key)} tag="R"
              tagTitle={t('um.capFromRole', 'Comes from the role. Change it on the role template.')} />
          ))}
        </div>
      </section>
    </>
  );

  const roleLeft = (
    <>
      <section className="bz-box">
        <div className="bz-head">{t('um.roleConfig', 'Role Configuration')}{holders > 0 && <span className="font-normal text-[11px] text-slate-500">{t('um.holders', { defaultValue: '{{count}} users hold it', count: holders })}</span>}</div>
        <div className="bz-body">
          <Field label={`${t('userMgmt.roleNameLabel', 'Role name')} *`}><input className="bz-in" value={role.form.label} disabled={role.locked} onChange={(e) => role.setLabel(e.target.value)} /></Field>
          <Field label={t('userMgmt.roleSlugLabel', 'Slug / id')}><input className="bz-in" value={role.form.id} disabled={!!role.editing} onChange={(e) => role.setSlug(e.target.value)} /></Field>
          <Field label={t('userMgmt.roleLevelLabel', 'Level')}>
            <select className="bz-in" value={role.form.level} disabled={role.locked} onChange={(e) => role.setForm((x) => ({ ...x, level: e.target.value }))}>
              {(dir.tiers.length ? [...dir.tiers].sort((a, b) => b.rank - a.rank).map((tr) => ({ value: tr.id, label: `${tr.id} · ${tr.label}` })) : ['L0', 'L1', 'L2', 'L3', 'L4'].map((l) => ({ value: l, label: l })))
                .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label={t('userMgmt.roleHomeRouteLabel', 'Home route')}><input className="bz-in" value={role.form.home_route} disabled={role.locked} onChange={(e) => role.setForm((x) => ({ ...x, home_route: e.target.value }))} /></Field>
        </div>
      </section>
      <section className="bz-box">
        <div className="bz-head">{t('um.roleControls', 'Role Controls')}<span className="font-normal text-[11px] text-slate-500">{t('um.capsNeedPassword', 'Switches need your password once')}</span></div>
        <div className="bz-body bz-yn-grid" data-testid="user-controls">
          <YN label={t('userMgmt.standaloneLabel', 'Standalone only')} value={role.form.standalone_only} disabled={role.locked} onChange={(v) => role.setForm((x) => ({ ...x, standalone_only: v }))} />
          <YN label={t('um.photoRule', 'Photo rule on (all roles)')} value={draft.photosEnforced} disabled={!rightsEditable} onChange={(v) => setDraft((d) => ({ ...d, photosEnforced: v }))} />
          {PHOTOS.map((p) => (
            <YN key={p.key} label={t(p.labelKey, p.label)} value={locked || draft.photos[p.key].includes(subject.kind === 'role' ? subject.roleId : '')}
              disabled={locked || !rightsEditable}
              onChange={(v) => setDraft((d) => {
                const id = subject.kind === 'role' ? subject.roleId : '';
                const list = d.photos[p.key].filter((x) => x !== id);
                return { ...d, photos: { ...d.photos, [p.key]: v ? [...list, id] : list } };
              })} />
          ))}
          {CAPABILITIES.map((c) => (
            <YN key={c.key} label={t(`um.cap_${c.key}`, CAP_LABEL[c.key] || c.label)} value={locked || capOnForRole(c.key)}
              disabled={locked || !canSaveRole} onChange={() => void toggleRoleCap(c.key)} />
          ))}
        </div>
      </section>
    </>
  );

  // History / Delete: in the Save bar on a desktop; above it (not pinned) on a phone.
  const sideActions = (
    <span className="flex flex-wrap gap-1">
      {isPerson && user && <button type="button" className="bz-btn" onClick={() => setHistoryFor(user)}>{t('userMgmt.history')}</button>}
      {isPerson && user && can('delete_user') && <button type="button" className="bz-btn bz-btn-danger" onClick={() => setDeleteFor(user)}>{t('userMgmt.delete', 'Delete')}</button>}
      {!isPerson && roleRow && !role.locked && canSaveRole && (
        <button type="button" className="bz-btn bz-btn-danger" onClick={async () => {
          if (!window.confirm(t('userMgmt.confirmDeleteRole', { defaultValue: 'Delete role "{{label}}"? This cannot be undone.', label: roleRow.label }))) return;
          const err = await role.remove(roleRow, holders);
          if (err) toast.error(err); else { toast.success(t('userMgmt.roleDeleted', 'Role deleted')); onQuit(); }
        }}>{t('userMgmt.delete', 'Delete')}</button>
      )}
    </span>
  );

  const title = isPerson
    ? (isNew ? t('um.addUser', 'Add User') : t('um.modifyUser', { defaultValue: 'Modify User — {{name}}', name: user?.name || '' }))
    : (isNew ? t('um.addRole', 'Add Role template') : t('um.modifyRole', { defaultValue: 'Modify Role template — {{name}}', name: roleRow?.label || '' }));

  return (
    <div className="bz flex flex-col gap-0" data-testid="modify-user">
      <div className="bz-title flex items-center justify-between gap-2">
        <span>{title}</span>
        {dirty && <span className="text-[11px] font-semibold text-amber-300">{t('um.unsaved', 'Not saved yet')}</span>}
      </div>
      <div className="grid gap-2 p-2 border border-t-0 border-slate-400 bg-slate-100 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-2 min-w-0">{isPerson ? personLeft : roleLeft}</div>
        <section className="bz-box min-w-0" data-testid="menu-rights">
          <div className="bz-head">
            <span>{t('um.menuRights', 'Menu Rights')}</span>
            <span className="flex flex-wrap gap-1">
              <button type="button" className="bz-btn" onClick={() => setOpen(Object.fromEntries(branchIds(tree).map((id) => [id, true])))}>{t('um.expandAll', 'Expand all')}</button>
              <button type="button" className="bz-btn" onClick={() => setOpen({})}>{t('um.collapseAll', 'Collapse all')}</button>
              <button type="button" className="bz-btn" onClick={() => setShowBack(true)}>{t('um.backDated', 'Back dated entries')}</button>
            </span>
          </div>
          <div className="bz-body">
            {locked && <p className="text-emerald-700 font-semibold mb-1">{t('rights.adminAlways', 'Owner / Admin: every page, tab and action is always on.')}</p>}
            {!locked && !rightsEditable && <p className="text-slate-500 mb-1">{t('um.readOnly', 'Only Owner / Admin change Menu Rights. You can see them.')}</p>}
            {!locked && (
              <p className="text-[11.5px] text-slate-500 mb-1">
                {isPerson
                  ? t('um.treeHelpPerson', 'A tick follows the role. Change it and it becomes this person’s own (P) — it beats the role. Click again to follow the role. Ticking a page does not give its tabs: each Purchase book tab is its own tick.')
                  : t('um.treeHelpRole', 'Everyone in this role gets these ticks (a person’s own P beats them). Ticking Purchase book does not give every tab: each tab is its own tick.')}
              </p>
            )}
            {tabsUnset && !locked && <p className="text-[11.5px] text-slate-500 mb-1">{t('rights.unconfiguredNote', 'This role has not been set up for Purchase book tabs, so it sees every tab (as today). Untick a tab and save to limit it.')}</p>}
            <RightsTree nodes={tree} settings={draft} roles={roles} subject={subject} open={open} setOpen={setOpen} onTick={onTick} locked={locked} readOnly={!rightsEditable} />
          </div>
        </section>
      </div>
      <div className="sm:hidden px-2 py-2 border border-t-0 border-slate-400 bg-slate-100">{sideActions}</div>
      {/* Save | Quit — one Save for the whole screen, pinned to the bottom of the window. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-2 border border-t-0 border-slate-400 bg-slate-200 rounded-b sticky bottom-0 z-10 max-sm:pb-[max(8px,env(safe-area-inset-bottom))]" data-testid="modify-footer">
        <span className="max-sm:hidden">{sideActions}</span>
        <span className="flex gap-2 max-sm:w-full">
          <button type="button" className="bz-btn bz-btn-primary max-sm:flex-1" disabled={saving || (!dirty && !isNew)} onClick={() => void save()}>
            {saving ? t('common.saving', 'Saving…') : t('um.save', 'Save (F2)')}
          </button>
          <button type="button" className="bz-btn max-sm:flex-1" onClick={quit}>{t('um.quit', 'Quit (Esc)')}</button>
        </span>
      </div>
      {showBack && (
        <BackDatedDialog
          backDays={draft.backDays || {}} bufferDays={draft.bufferDays} editWindowHours={draft.editWindowHours}
          readOnly={!rightsEditable}
          onClose={() => setShowBack(false)}
          onOk={(n) => { setDraft((d) => ({ ...d, backDays: n.backDays, editWindowHours: n.editWindowHours })); setShowBack(false); }}
        />
      )}
      <HistoryPanel user={historyFor} onClose={() => setHistoryFor(null)} />
      <DeleteUserDialog user={deleteFor} onClose={() => setDeleteFor(null)} onDeleted={() => { setDeleteFor(null); void dir.reload(); onQuit(); }} />
      {stepUpModal}
    </div>
  );
}
