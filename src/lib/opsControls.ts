import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// migration 0025 tables are not in the generated Database type yet.
const q = (name: string) => (supabase as unknown as { from: (t: string) => any }).from(name);
import { isAdminProfile, isManagementProfile, type MockProfile } from './profiles';
import { needsLateApproval } from './datePolicy';
import { DEFAULT_VALUE_CATEGORIES, type ValueCategorySettings } from './valueCategory';

export const MODULES = [
  { key: 'stock', label: 'Stock Register' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'batch', label: 'Batch Sheet' },
  { key: 'far', label: 'FAR' },
  { key: 'purchase', label: 'Purchases' },
  { key: 'store_req', label: 'Store requisitions' },
] as const;

export type ModuleKey = (typeof MODULES)[number]['key'];
export type PhotoKey = 'heat' | 'sheet' | 'bucket';
export type BackupFrequency = 'weekly' | 'monthly' | 'half_yearly' | 'yearly';

export interface ModuleGrant {
  edit: string[];
  delete: string[];
}

export interface OpsSettings {
  enforced: boolean;
  photosEnforced: boolean;
  bufferDays: number;
  /** Days a bill may be uploaded late, per plant. Missing plants use bufferDays. */
  bufferDaysByPlant: Record<string, number>;
  backupFrequency: BackupFrequency;
  backupLastAt: string | null;
  modules: Record<ModuleKey, ModuleGrant>;
  photos: Record<PhotoKey, string[]>;
  /** People (profile id or name) who must not see that photo kind. Admin still sees all. */
  photosHiddenFrom: Record<PhotoKey, string[]>;
  valueCategories: ValueCategorySettings;
}

const EMPTY_GRANT = (): ModuleGrant => ({ edit: [], delete: [] });

export const DEFAULT_OPS: OpsSettings = {
  enforced: false,
  photosEnforced: false,
  bufferDays: 2,
  bufferDaysByPlant: {},
  backupFrequency: 'monthly',
  backupLastAt: null,
  modules: {
    stock: EMPTY_GRANT(),
    maintenance: EMPTY_GRANT(),
    batch: EMPTY_GRANT(),
    far: EMPTY_GRANT(),
    purchase: EMPTY_GRANT(),
    store_req: EMPTY_GRANT(),
  },
  photos: { heat: [], sheet: [], bucket: [] },
  photosHiddenFrom: { heat: [], sheet: ['Ravi Shankar'], bucket: [] },
  valueCategories: DEFAULT_VALUE_CATEGORIES,
};

const LS_KEY = 'suntek.opsSettings.v1';
let cache: OpsSettings = readLocal();
const listeners = new Set<() => void>();

function readLocal(): OpsSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_OPS;
    return { ...DEFAULT_OPS, ...JSON.parse(raw), modules: { ...DEFAULT_OPS.modules, ...(JSON.parse(raw).modules || {}) } };
  } catch {
    return DEFAULT_OPS;
  }
}

function publish(next: OpsSettings) {
  cache = next;
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  listeners.forEach((fn) => fn());
}

export function roleKey(profile: Pick<MockProfile, 'id' | 'baseRoleId'>): string {
  return profile.baseRoleId || profile.id;
}

export function roleAllowed(ids: string[] | undefined, profile: MockProfile): boolean {
  if (isAdminProfile(profile)) return true;
  const id = roleKey(profile);
  return (ids || []).includes(id) || (ids || []).includes(profile.id);
}

/** Edit is open until Admin turns restrictions on and saves a list. */
export function canEditModule(settings: OpsSettings, profile: MockProfile, module: ModuleKey): boolean {
  if (!settings.enforced) return true;
  return roleAllowed(settings.modules[module]?.edit, profile);
}

/**
 * Delete is on for Admin, for a ticked role, and for a ticked person.
 * Until Admin saves a list, nobody else can delete.
 */
export function canDeleteModule(settings: OpsSettings, profile: MockProfile, module: ModuleKey, personId?: string | null): boolean {
  if (isAdminProfile(profile)) return true;
  if (!settings.enforced) return false;
  const granted = settings.modules[module]?.delete || [];
  if (roleAllowed(granted, profile)) return true;
  const mine = personId || (profile.id.startsWith('db_') ? profile.id : '');
  return !!mine && granted.includes(mine);
}

function normToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True if this person is on the hide list for that picture kind (name or profile id). */
export function photoHiddenFrom(settings: OpsSettings, profile: MockProfile, kind: PhotoKey): boolean {
  const tokens = (settings.photosHiddenFrom?.[kind] || []).map(normToken).filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.includes(normToken(profile.id))) return true;
  const name = normToken(profile.name || '');
  if (!name) return false;
  return tokens.some((t) => name === t || name.startsWith(`${t} `) || name.startsWith(`${t}(`));
}

export function canViewPhoto(settings: OpsSettings, profile: MockProfile, kind: PhotoKey): boolean {
  if (isAdminProfile(profile)) return true;
  if (photoHiddenFrom(settings, profile, kind)) return false;
  if (!settings.photosEnforced) return true;
  return roleAllowed(settings.photos[kind], profile);
}

export function getOpsSettings(): OpsSettings {
  return cache;
}

export function useOpsSettings(): OpsSettings {
  const [value, setValue] = useState(cache);
  useEffect(() => {
    const fn = () => setValue(cache);
    listeners.add(fn);
    void loadOpsSettings();
    return () => { listeners.delete(fn); };
  }, []);
  return value;
}

export async function loadOpsSettings(): Promise<OpsSettings> {
  try {
    const { data, error } = await q('ops_settings').select('value').eq('key', 'controls').maybeSingle();
    if (error || !data?.value) return cache;
    const next = mergeSettings(data.value as Partial<OpsSettings>);
    publish(next);
    return next;
  } catch {
    return cache;
  }
}

function mergeSettings(raw: Partial<OpsSettings> & { mobilePreview?: unknown }): OpsSettings {
  const modules = { ...DEFAULT_OPS.modules };
  for (const m of MODULES) {
    const g = raw.modules?.[m.key];
    if (g) modules[m.key] = { edit: g.edit || [], delete: g.delete || [] };
  }
  const { mobilePreview: _dropped, ...rest } = raw;
  return {
    ...DEFAULT_OPS,
    ...rest,
    modules,
    photos: { ...DEFAULT_OPS.photos, ...(raw.photos || {}) },
    photosHiddenFrom: {
      heat: raw.photosHiddenFrom?.heat || [],
      sheet: raw.photosHiddenFrom?.sheet !== undefined
        ? raw.photosHiddenFrom.sheet
        : DEFAULT_OPS.photosHiddenFrom.sheet,
      bucket: raw.photosHiddenFrom?.bucket || [],
    },
    valueCategories: {
      enabledPlantIds: raw.valueCategories?.enabledPlantIds || [],
      bands: raw.valueCategories?.bands?.length ? raw.valueCategories.bands : DEFAULT_VALUE_CATEGORIES.bands,
    },
    bufferDays: raw.bufferDays === 1 ? 1 : 2,
    bufferDaysByPlant: cleanPlantBuffers(raw.bufferDaysByPlant),
  };
}

function cleanPlantBuffers(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const days = Math.round(Number(value));
    if (!id || !Number.isFinite(days) || days < 0 || days > 60) continue;
    out[id] = days;
  }
  return out;
}

export async function saveOpsSettings(next: OpsSettings, actorName: string): Promise<string | null> {
  publish(next);
  const { error } = await q('ops_settings').upsert({
    key: 'controls',
    value: next,
    updated_at: new Date().toISOString(),
    updated_by: actorName,
  }, { onConflict: 'key' });
  if (error) return error.message;
  await recordAudit({
    module: 'access',
    action: 'settings_saved',
    summary: 'Admin updated edit/delete, photo or backup settings',
    actorName,
  });
  return null;
}

export interface AuditInput {
  module: string;
  action: string;
  summary: string;
  actorName?: string | null;
  actorRole?: string | null;
  photoUrl?: string | null;
}

export async function recordAudit(e: AuditInput): Promise<void> {
  try {
    await q('system_audit').insert({
      module: e.module,
      action: e.action,
      summary: e.summary,
      actor_name: e.actorName ?? null,
      actor_role: e.actorRole ?? null,
      photo_url: e.photoUrl ?? null,
    });
  } catch {
    /* audit must not block the save */
  }
}

export interface AuditRow {
  id: string;
  module: string;
  action: string;
  summary: string;
  actor_name: string | null;
  actor_role: string | null;
  photo_url: string | null;
  created_at: string;
}

export async function loadAudit(limit = 200): Promise<AuditRow[]> {
  const { data, error } = await q('system_audit')
    .select('id, module, action, summary, actor_name, actor_role, photo_url, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as AuditRow[];
}

export interface LateRequest {
  id: string;
  module: string;
  entry_date: string | null;
  reason: string;
  status: string;
  requested_by: string | null;
  requested_role: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  ref_key: string | null;
  created_at: string;
}

export async function loadLateRequests(): Promise<LateRequest[]> {
  const { data, error } = await q('late_entry_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error || !data) return [];
  return data as LateRequest[];
}

const LATE_VALID_DAYS = 14;

const LATE_ROUTES: Record<string, string> = {
  purchase: '/dashboard/purchase/storereq?tab=stock&addPurchase=1',
  stock: '/dashboard/purchase/storereq?tab=stock',
  FAR: '/dashboard/purchase/far',
  activity: '/dashboard/purchase/activity',
  'repair return': '/dashboard/purchase/storereq?tab=scrap',
};

function niceDate(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Tell the person who asked. Best effort: a missing account never blocks the review. */
async function notifyLateRequester(row: LateRequest, status: 'approved' | 'rejected', reviewer: string) {
  const name = (row.requested_by || '').trim();
  if (!name) return;
  try {
    const { data } = await q('user_accounts').select('id').ilike('name', name).eq('is_deleted', false).limit(5);
    const ids = ((data || []) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return;
    const until = new Date(Date.parse(row.created_at) + LATE_VALID_DAYS * 86_400_000).toISOString();
    const dated = niceDate(row.entry_date);
    await q('notifications').insert({
      target_roles: ids,
      title: status === 'approved'
        ? `Approved: ${row.module} entry dated ${dated}`
        : `Not approved: ${row.module} entry dated ${dated}`,
      body: status === 'approved'
        ? `${reviewer} approved it. Open ${row.module === 'purchase' ? 'Add purchase' : 'the form'} again and use the date ${dated}. Valid until ${niceDate(until)}.`
        : `${reviewer} did not approve the late entry.`,
      type: status === 'approved' ? 'info' : 'warning',
      route: LATE_ROUTES[row.module] ?? '/dashboard/todo',
      actor_name: reviewer,
      actor_role: 'management',
      read_by: [],
    });
  } catch {
    /* Notification is a courtesy. The approval itself is already saved. */
  }
}

/** This person's late-entry requests for one module that can still be used or are waiting. */
export async function loadMyLateRequests(module: string, actorName: string): Promise<LateRequest[]> {
  const since = new Date(Date.now() - LATE_VALID_DAYS * 86_400_000).toISOString();
  const { data } = await q('late_entry_requests')
    .select('*')
    .eq('module', module)
    .eq('requested_by', actorName)
    .in('status', ['approved', 'pending'])
    .gte('created_at', since)
    .order('entry_date', { ascending: true });
  return (data || []) as LateRequest[];
}

export async function reviewLateRequest(id: string, status: 'approved' | 'rejected', reviewer: string, note: string): Promise<string | null> {
  const { data: updated, error } = await q('late_entry_requests').update({
    status,
    reviewed_by: reviewer,
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
  }).eq('id', id).select('*');
  if (error) return error.message;
  const row = (updated as LateRequest[] | null)?.[0];
  if (row) await notifyLateRequester(row, status, reviewer);
  await recordAudit({
    module: 'access',
    action: status === 'approved' ? 'late_approved' : 'late_rejected',
    summary: `Management ${status} a late entry`,
    actorName: reviewer,
  });
  return null;
}

type LateWaiter = (job: {
  module: string;
  entryDate: string;
  actorName: string;
  actorRole: string;
  bufferDays: number;
  resolve: (ok: boolean) => void;
}) => void;

let lateWaiter: LateWaiter | null = null;
export function bindLateEntryHost(fn: LateWaiter | null) {
  lateWaiter = fn;
}

async function hasApproval(module: string, entryDate: string, actorName: string): Promise<boolean> {
  const since = new Date(Date.now() - LATE_VALID_DAYS * 86_400_000).toISOString();
  const { data } = await q('late_entry_requests')
    .select('id')
    .eq('module', module)
    .eq('entry_date', entryDate.slice(0, 10))
    .eq('requested_by', actorName)
    .eq('status', 'approved')
    .gte('created_at', since)
    .limit(1);
  return !!data?.length;
}

/**
 * Returns true when the entry may be saved.
 * Management can proceed (the action is audited). Everyone else must already
 * have an approved request, or this opens the request dialog and blocks the save.
 */
export async function ensureLateApproval(opts: {
  module: string;
  entryDate: string | null | undefined;
  profile: MockProfile;
  bufferDays: number;
}): Promise<boolean> {
  const date = opts.entryDate?.slice(0, 10);
  if (!date || !needsLateApproval(date, opts.bufferDays)) return true;
  if (isManagementProfile(opts.profile)) {
    await recordAudit({
      module: opts.module,
      action: 'late_entry',
      summary: `Management saved a backdated ${opts.module} entry for ${date}`,
      actorName: opts.profile.name,
      actorRole: opts.profile.roleLabel,
    });
    return true;
  }
  if (await hasApproval(opts.module, date, opts.profile.name)) return true;
  if (!lateWaiter) return false;
  return new Promise((resolve) => {
    lateWaiter!({
      module: opts.module,
      entryDate: date,
      actorName: opts.profile.name,
      actorRole: opts.profile.roleLabel,
      bufferDays: opts.bufferDays,
      resolve,
    });
  });
}

export async function submitLateRequest(input: {
  module: string;
  entryDate: string;
  reason: string;
  actorName: string;
  actorRole: string;
}): Promise<string | null> {
  const { error } = await q('late_entry_requests').insert({
    module: input.module,
    entry_date: input.entryDate,
    reason: input.reason.trim(),
    status: 'pending',
    requested_by: input.actorName,
    requested_role: input.actorRole,
  });
  if (error) return error.message;
  await recordAudit({
    module: input.module,
    action: 'late_requested',
    summary: `Asked Management to allow a ${input.module} entry dated ${input.entryDate}: ${input.reason.trim()}`,
    actorName: input.actorName,
    actorRole: input.actorRole,
  });
  return null;
}

const BACKUP_DAYS: Record<BackupFrequency, number> = {
  weekly: 7,
  monthly: 31,
  half_yearly: 182,
  yearly: 366,
};

export function backupOverdue(settings: OpsSettings, now = Date.now()): boolean {
  if (!settings.backupLastAt) return true;
  const age = (now - new Date(settings.backupLastAt).getTime()) / 86_400_000;
  return age > BACKUP_DAYS[settings.backupFrequency];
}

export async function downloadBackup(actorName: string): Promise<string | null> {
  const tables = ['store_items', 'maintenance_schedules', 'production_batch_sheets', 'fixed_assets', 'stock_purchase_receipts'];
  const dump: Record<string, unknown> = { exportedAt: new Date().toISOString(), by: actorName };
  for (const table of tables) {
    const { data, error } = await q(table).select('*').limit(5000);
    dump[table] = error ? { error: error.message } : (data || []);
  }
  const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `suntek-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  const next = { ...cache, backupLastAt: new Date().toISOString() };
  const err = await saveOpsSettings(next, actorName);
  await recordAudit({ module: 'backup', action: 'backup_downloaded', summary: 'Downloaded a data backup', actorName });
  return err;
}
