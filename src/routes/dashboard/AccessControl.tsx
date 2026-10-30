import React, { useEffect, useState } from 'react';
import { useRoleContext } from '../../contexts/RoleContext';
import { isAdminProfile, isManagementProfile } from '../../lib/profiles';
import {
  backupOverdue, downloadBackup, loadAudit, loadLateRequests, reviewLateRequest,
  recordAudit, saveOpsSettings, useOpsSettings, type AuditRow, type LateRequest, type OpsSettings, type PhotoKey,
} from '../../lib/opsControls';
import { BUYER_TYPES, saveBuyers, useBuyers, type BuyerPerson, type BuyerType } from '../../lib/procurementPeople';
import { fetchActivePlants } from '../../lib/plants';
import { displayLocationName } from '../../lib/plantLabels';
import { useToast } from '../../components/ui/toast';
import { usePagination } from '../../components/ui/usePagination';
import { TablePaginationV2 } from '../../components/v2';
import { formatDate, formatDateTime } from '../../lib/utils/formatting';
import { codeLabel } from '../../lib/labels';
import { useTranslation } from 'react-i18next';

const PHOTOS: { key: PhotoKey; label: string }[] = [
  { key: 'heat', label: 'Heat sample' },
  { key: 'sheet', label: 'Batch sheet' },
  { key: 'bucket', label: 'Bucket photo' },
];

function toggle(list: string[], id: string, on: boolean): string[] {
  const next = list.filter((x) => x !== id);
  return on ? [...next, id] : next;
}

/** Which part of the old Access & backup page to show (User Management tabs). */
export type AccessPart = 'all' | 'backup' | 'lateBills' | 'photos' | 'purchasers';

export function AccessControl({ part = 'all' }: { part?: AccessPart } = {}) {
  const { t } = useTranslation();
  const show = (k: Exclude<AccessPart, 'all'>) => part === 'all' || part === k;
  const { activeProfile, roles, allProfiles } = useRoleContext();
  const saved = useOpsSettings();
  const toast = useToast();
  const admin = isAdminProfile(activeProfile);
  const [draft, setDraft] = useState<OpsSettings>(saved);
  const [requests, setRequests] = useState<LateRequest[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  // Empty-table text waits for the first load (it used to say "No history yet." while loading).
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const { pageRows: requestPage, controls: requestPager } = usePagination(requests);
  const { pageRows: auditPage, controls: auditPager } = usePagination(audit);
  const [saving, setSaving] = useState(false);
  const [backing, setBacking] = useState(false);
  const [plants, setPlants] = useState<{ id: string; name: string }[]>([]);
  const [personQuery, setPersonQuery] = useState('');

  useEffect(() => { setDraft(saved); }, [saved]);
  useEffect(() => {
    void loadLateRequests().then((r) => { setRequests(r); setRequestsLoaded(true); });
    void loadAudit(150).then((a) => { setAudit(a); setAuditLoaded(true); });
    void fetchActivePlants<{ id: string; name: string }>('id, name').then((r) => setPlants(r.data || []));
  }, []);

  const roleRows = roles.filter((r) => !r.standalone_only);
  const people = allProfiles
    .filter((p) => p.id.startsWith('db_'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const personQ = personQuery.trim().toLowerCase();
  const shownPeople = personQ
    ? people.filter((p) => `${p.name} ${p.roleLabel} ${p.plant || ''}`.toLowerCase().includes(personQ))
    : people;

  async function saveBillDays() {
    setSaving(true);
    const err = await saveOpsSettings({ ...saved, bufferDays: draft.bufferDays, bufferDaysByPlant: draft.bufferDaysByPlant }, activeProfile.name);
    setSaving(false);
    if (err) toast.error(err);
    else toast.success('Late bill days saved for each plant.');
  }

  async function saveCategories() {
    setSaving(true);
    const err = await saveOpsSettings({ ...saved, valueCategories: draft.valueCategories }, activeProfile.name);
    setSaving(false);
    if (err) toast.error(err);
    else toast.success('Purchase categories saved.');
  }

  async function save() {
    setSaving(true);
    // Only photo visibility is edited here; every other setting is kept as saved.
    const err = await saveOpsSettings({ ...saved, photosEnforced: draft.photosEnforced, photos: draft.photos, photosHiddenFrom: draft.photosHiddenFrom }, activeProfile.name);
    setSaving(false);
    if (err) toast.error(err);
    else toast.success(t('rights.photosSaved', 'Photo visibility saved.'));
  }

  async function backup() {
    setBacking(true);
    const err = await downloadBackup(activeProfile.name);
    setBacking(false);
    if (err) toast.error(err);
    else toast.success('Backup downloaded.');
  }

  async function review(id: string, status: 'approved' | 'rejected') {
    const err = await reviewLateRequest(id, status, activeProfile.name, '');
    if (err) { toast.error(err); return; }
    setRequests(await loadLateRequests());
    setAudit(await loadAudit(150));
  }

  const due = backupOverdue(draft);

  return (
    <div className="flex flex-col gap-4">
      {show('backup') && <section className="card2 p-5">
        <h2 className="text-base font-bold">Backup data</h2>
        <p className="text-xs text-slate-500 mt-1">Downloads stock, schedules, batch sheets, assets and purchase receipts. Pick how often a fresh copy should be taken.</p>
        <div className="flex flex-wrap items-end gap-3 mt-3">
          <label className="text-xs font-bold text-slate-600">
            Frequency
            <select
              className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold"
              value={draft.backupFrequency}
              disabled={!admin}
              onChange={(e) => setDraft((d) => ({ ...d, backupFrequency: e.target.value as OpsSettings['backupFrequency'] }))}
            >
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="half_yearly">Half-yearly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
          <div className="text-sm">
            <div className="text-[11px] uppercase text-slate-400 font-bold">Last backup</div>
            <div className="font-bold">{draft.backupLastAt ? formatDateTime(draft.backupLastAt) : 'Never'}</div>
            {due && <div className="text-xs font-bold text-red-600">A backup is due.</div>}
          </div>
          {admin && (
            <button type="button" className="btn-accent rounded-[10px] px-4 py-2 text-sm font-semibold" disabled={backing} onClick={() => void backup()}>
              {backing ? 'Preparing…' : 'Download backup'}
            </button>
          )}
        </div>
      </section>}

      {show('lateBills') && <section className="card2 p-5">
        <h2 className="text-base font-bold">Purchase categories</h2>
        <p className="text-xs text-slate-500 mt-1">Each purchased line is graded by its own bill amount. Category C skips unit-head verification on a maintenance ticket. B and A, and any amount in a gap, keep the normal workflow. A plant with the switch off always keeps the normal workflow.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {draft.valueCategories.bands.map((band, i) => (
            <label key={band.code} className="text-sm font-bold">
              {band.code} from ₹
              <input
                type="number"
                className="ml-2 w-24 rounded-lg border border-slate-200 px-2 py-1"
                disabled={!admin && !isManagementProfile(activeProfile)}
                value={band.min}
                onChange={(e) => setDraft((d) => {
                  const bands = d.valueCategories.bands.map((b, j) => j === i ? { ...b, min: Number(e.target.value) || 0 } : b);
                  return { ...d, valueCategories: { ...d.valueCategories, bands } };
                })}
              />
              <span className="mx-1 font-normal text-slate-500">up to</span>
              <input
                type="number"
                className="w-24 rounded-lg border border-slate-200 px-2 py-1"
                placeholder="no limit"
                disabled={!admin && !isManagementProfile(activeProfile)}
                value={band.max ?? ''}
                onChange={(e) => setDraft((d) => {
                  const raw = e.target.value;
                  const bands = d.valueCategories.bands.map((b, j) => j === i ? { ...b, max: raw === '' ? null : Number(raw) } : b);
                  return { ...d, valueCategories: { ...d.valueCategories, bands } };
                })}
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {plants.map((p) => {
            const on = draft.valueCategories.enabledPlantIds.includes(p.id);
            return (
              <label key={p.id} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!admin}
                  onChange={(e) => setDraft((d) => ({
                    ...d,
                    valueCategories: {
                      ...d.valueCategories,
                      enabledPlantIds: e.target.checked
                        ? [...d.valueCategories.enabledPlantIds, p.id]
                        : d.valueCategories.enabledPlantIds.filter((id) => id !== p.id),
                    },
                  }))}
                />
                {displayLocationName(p.name)}
              </label>
            );
          })}
        </div>
        {(admin || isManagementProfile(activeProfile)) && (
          <button type="button" className="btn-accent mt-3 rounded-[10px] px-4 py-2 text-sm font-semibold" disabled={saving} onClick={() => void saveCategories()}>
            {saving ? 'Saving…' : 'Save categories'}
          </button>
        )}
      </section>}

      {show('lateBills') && <section className="card2 p-5">
        <h2 className="text-base font-bold">Backdated entries</h2>
        <p className="text-xs text-slate-500 mt-1">Dates older than this buffer cannot be saved until Management approves a reason. Management can still enter them, and that is written to the history.</p>
        <label className="mt-3 inline-flex items-center gap-2 text-sm font-bold">
          Buffer
          <select
            className="rounded-lg border border-slate-200 px-3 py-2"
            value={draft.bufferDays}
            disabled={!admin}
            onChange={(e) => setDraft((d) => ({ ...d, bufferDays: Number(e.target.value) === 1 ? 1 : 2 }))}
          >
            <option value={1}>1 day</option>
            <option value={2}>2 days</option>
          </select>
        </label>
        {admin && (
          <div className="mt-4">
            <div className="text-sm font-bold">Late bill upload, by plant</div>
            <p className="text-xs text-slate-500 mt-1">How many days late a bill can be uploaded before Management has to approve it. Jharkhand can be 5. Sikandrabad (Madan) can stay at 2. A blank box uses the buffer above.</p>
            <div className="mt-3 flex flex-col gap-2">
              {plants.map((p) => (
                <label key={p.id} className="flex items-center gap-3 text-sm">
                  <span className="w-48 font-semibold">{displayLocationName(p.name)}</span>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    className="w-20 rounded-lg border border-slate-200 px-2 py-1"
                    placeholder={String(draft.bufferDays)}
                    value={draft.bufferDaysByPlant[p.id] ?? ''}
                    onChange={(e) => setDraft((d) => {
                      const next = { ...d.bufferDaysByPlant };
                      if (e.target.value === '') delete next[p.id];
                      else next[p.id] = Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0)));
                      return { ...d, bufferDaysByPlant: next };
                    })}
                  />
                  <span className="text-xs text-slate-500">days{draft.bufferDaysByPlant[p.id] == null ? ` · default ${draft.bufferDays}` : ''}</span>
                </label>
              ))}
            </div>
            <button type="button" className="btn-accent mt-3 rounded-[10px] px-4 py-2 text-sm font-semibold" disabled={saving} onClick={() => void saveBillDays()}>
              {saving ? 'Saving…' : 'Save late bill days'}
            </button>
          </div>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="dt2">
            <thead>
              <tr>
                <th>When</th><th>Who</th><th>Module</th><th>Entry date</th><th>Reason</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-4">{requestsLoaded ? 'No late-entry requests.' : '…'}</td></tr>}
              {requestPage.map((r) => (
                <tr key={r.id}>
                  <td className="text-xs font-bold">{formatDateTime(r.created_at)}</td>
                  <td className="text-xs">{r.requested_by}<div className="text-slate-400">{codeLabel(r.requested_role)}</div></td>
                  <td className="text-xs">{codeLabel(r.module)}</td>
                  <td className="text-xs font-bold">{formatDate(r.entry_date)}</td>
                  <td className="text-xs">{r.reason}</td>
                  <td className="text-xs font-bold">{codeLabel(r.status)}</td>
                  <td>
                    {r.status === 'pending' && isManagementProfile(activeProfile) && (
                      <span className="inline-flex gap-2">
                        <button type="button" className="text-xs font-bold text-teal-700" onClick={() => void review(r.id, 'approved')}>Approve</button>
                        <button type="button" className="text-xs font-bold text-red-600" onClick={() => void review(r.id, 'rejected')}>Reject</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {requests.length > 0 && <TablePaginationV2 controls={requestPager} label="requests" />}
      </section>}

      {admin && show('photos') && (
        <section className="card2 p-5">
          {/* Add / Edit / Delete ticks and the edit window moved to User Management → Add/Modify/Delete. */}
          <h2 className="text-base font-bold">{t('rights.photosTitle', 'Who can view batch photos')}</h2>
          <p className="text-xs text-slate-500 mt-1">Heat sample, batch sheet and bucket photo are separate. Unticked roles still use the batch sheet, but those pictures stay hidden.</p>
          <label className="mt-2 inline-flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={draft.photosEnforced} onChange={(e) => setDraft((d) => ({ ...d, photosEnforced: e.target.checked }))} />
            Enforce photo visibility
          </label>
          <div className="overflow-x-auto mt-2">
            <table className="dt2 text-xs">
              <thead><tr><th>Role</th>{PHOTOS.map((p) => <th key={p.key}>{p.label}</th>)}</tr></thead>
              <tbody>
                {roleRows.map((role) => (
                  <tr key={role.id}>
                    <td className="font-semibold">{role.label}</td>
                    {PHOTOS.map((p) => (
                      <td key={p.key}>
                        <input
                          type="checkbox"
                          disabled={role.is_admin}
                          checked={role.is_admin || draft.photos[p.key].includes(role.id)}
                          onChange={(e) => setDraft((d) => ({ ...d, photos: { ...d.photos, [p.key]: toggle(d.photos[p.key], role.id, e.target.checked) } }))}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="text-sm font-bold mt-6">Hide photos from a person</h3>
          <p className="text-xs text-slate-500 mt-1">Tick to hide that picture from this person only. Everyone else still sees it. Admin always sees every photo. Ravi Shankar is ticked off batch-sheet photos by default; heat and bucket stay visible.</p>
          <input
            value={personQuery}
            onChange={(e) => setPersonQuery(e.target.value)}
            placeholder="Search a person, role or plant"
            className="mt-2 w-full max-w-sm rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          <div className="overflow-x-auto mt-2">
            <table className="dt2 text-xs">
              <thead><tr><th>Person</th>{PHOTOS.map((p) => <th key={p.key}>{p.label}</th>)}</tr></thead>
              <tbody>
                {shownPeople.length === 0 && (
                  <tr><td colSpan={PHOTOS.length + 1} className="text-center text-slate-400 py-6">No people match.</td></tr>
                )}
                {shownPeople.map((person) => {
                  const always = isAdminProfile(person);
                  const hidden = draft.photosHiddenFrom || { heat: [], sheet: [], bucket: [] };
                  const n = person.name.trim().toLowerCase();
                  const isHid = (kind: PhotoKey) => hidden[kind].some((h) => h === person.id || h.trim().toLowerCase() === n);
                  return (
                    <tr key={`photo-hide-${person.id}`}>
                      <td className="font-semibold">
                        {person.name}
                        <div className="text-slate-400 font-normal">{person.roleLabel}{person.plant ? ` · ${displayLocationName(person.plant)}` : ''}</div>
                      </td>
                      {PHOTOS.map((p) => (
                        <td key={p.key}>
                          <input
                            type="checkbox"
                            disabled={always}
                            checked={!always && isHid(p.key)}
                            onChange={(e) => setDraft((d) => {
                              const cur = d.photosHiddenFrom || { heat: [], sheet: [], bucket: [] };
                              const nextList = e.target.checked
                                ? [...cur[p.key].filter((h) => h !== person.id && h.trim().toLowerCase() !== n), person.id]
                                : cur[p.key].filter((h) => h !== person.id && h.trim().toLowerCase() !== n);
                              return { ...d, photosHiddenFrom: { ...cur, [p.key]: nextList } };
                            })}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button type="button" className="btn-accent rounded-[10px] px-4 py-2 text-sm font-semibold mt-5" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : t('rights.savePhotos', 'Save photo visibility')}
          </button>
        </section>
      )}

      {admin && show('purchasers') && <PurchaserList actorName={activeProfile.name} loginNames={people.map((p) => p.name)} />}

      {show('backup') && <section className="card2 p-5">
        <h2 className="text-base font-bold">History</h2>
        <p className="text-xs text-slate-500 mt-1">Who did it, and when. Covers permission changes, late approvals, backups, bill uploads, batch photos, edits and deletions that write to this log.</p>
        <div className="overflow-x-auto mt-3">
          <table className="dt2">
            <thead><tr><th>When</th><th>Who</th><th>Module</th><th>What</th><th>Photo</th></tr></thead>
            <tbody>
              {audit.length === 0 && <tr><td colSpan={5} className="text-center text-slate-400 py-4">{auditLoaded ? 'No history yet.' : '…'}</td></tr>}
              {auditPage.map((row) => (
                <tr key={row.id}>
                  <td className="text-xs font-bold whitespace-nowrap">{formatDateTime(row.created_at)}</td>
                  <td className="text-xs">{row.actor_name || '—'}<div className="text-slate-400">{codeLabel(row.actor_role)}</div></td>
                  <td className="text-xs">{codeLabel(row.module)}</td>
                  <td className="text-xs">{row.summary}</td>
                  <td>{row.photo_url ? <a className="text-xs font-bold text-[var(--accent-deep)]" href={row.photo_url} target="_blank" rel="noreferrer">View</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.length > 0 && <TablePaginationV2 controls={auditPager} label="entries" />}
      </section>}
    </div>
  );
}

/**
 * Who buys a not-in-store part after Vijay ji approves it (tickets and store
 * requisitions). Matched to logins by name, like the photo-hide list, so the
 * list is edited here rather than tied to one account.
 */
function PurchaserList({ actorName, loginNames }: { actorName: string; loginNames: string[] }) {
  const toast = useToast();
  const saved = useBuyers();
  // null = not edited: show the saved list as it loads.
  const [edits, setEdits] = useState<BuyerPerson[] | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = edits ?? saved;
  const setDraft = (fn: (d: BuyerPerson[]) => BuyerPerson[]) => setEdits(fn(draft));

  const setRow = (i: number, patch: Partial<BuyerPerson>) =>
    setDraft((d) => d.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function save() {
    const people = draft.filter((p) => p.name.trim());
    if (!people.length) { toast.error('Keep at least one purchaser.'); return; }
    setSaving(true);
    const err = await saveBuyers(people, actorName);
    setSaving(false);
    if (err) { toast.error(err); return; }
    setEdits(null);
    await recordAudit({ module: 'access', action: 'purchasers_saved', summary: `Purchaser list: ${people.map((p) => p.name).join(', ')}`, actorName });
    toast.success('Purchaser list saved.');
  }

  return (
    <section className="card2 p-5">
      <h2 className="text-base font-bold">Purchasers</h2>
      <p className="text-xs text-slate-500 mt-1">When a part is not in store: Unit Head approves, Vijay ji approves and picks one of these people, and that person buys it. A name here matches the login by name (sir / ji ignored), so “Tiwari ji” is any login named Tiwari. Admin can always act.</p>
      <datalist id="purchaser-login-names">
        {loginNames.map((n) => <option key={n} value={n} />)}
      </datalist>
      <div className="flex flex-col gap-2 mt-3 max-w-xl">
        {draft.map((p, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              value={p.name}
              list="purchaser-login-names"
              onChange={(e) => setRow(i, { name: e.target.value })}
              placeholder="Name"
              className="flex-1 min-w-[160px] rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <select
              value={p.type}
              onChange={(e) => setRow(i, { type: e.target.value as BuyerType })}
              className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
            >
              {BUYER_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
            <button type="button" className="text-xs font-bold text-red-600" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 mt-3">
        <button type="button" className="rounded-[10px] border border-slate-200 px-4 py-2 text-sm font-semibold" onClick={() => setDraft((d) => [...d, { name: '', type: 'Purchase' }])}>
          Add person
        </button>
        <button type="button" className="btn-accent rounded-[10px] px-4 py-2 text-sm font-semibold" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save purchasers'}
        </button>
      </div>
    </section>
  );
}
