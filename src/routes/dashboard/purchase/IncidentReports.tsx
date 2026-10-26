import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { formatDateTime, istDayKey, normalizeDayRange } from '../../../lib/utils/formatting';
import { displayLocationName } from '../../../lib/plantLabels';
import { uploadWorkflowFile, uploadWorkflowImage } from '../../../lib/cloudinary';
import { useDirectory } from '../../../lib/mentions';
import { useNotifications } from '../../../contexts/NotificationsContext';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { Activity, Building2, Plus } from 'lucide-react';
import { useUrlFilters } from '../../../lib/urlFilters';
import { ButtonV2, DateRangeFilter, FilterBar, FilterSelect, SectionCard, StatusPill, TablePaginationV2 } from '../../../components/v2';
import { usePagination } from '../../../components/ui/usePagination';


function TagPeople({
  people, selected, onChange, query, setQuery,
}: {
  people: { id: string; name: string; roleLabel: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  query: string;
  setQuery: (v: string) => void;
}) {
  const { t } = useTranslation();
  const picked = selected.map(id => people.find(p => p.id === id)).filter(Boolean) as { id: string; name: string }[];
  const q = query.trim().toLowerCase();
  const hits = q
    ? people.filter(p => !selected.includes(p.id) && (p.name.toLowerCase().includes(q) || p.roleLabel.toLowerCase().includes(q))).slice(0, 24)
    : [];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {picked.map(p => (
          <span key={p.id} style={{ ...chip, background: '#0F172A', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {p.name}
            <button type="button" onClick={() => onChange(selected.filter(id => id !== p.id))} style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontWeight: 700, padding: 0 }} aria-label={t('incidents.removeTag', { name: p.name })}>×</button>
          </span>
        ))}
        {picked.length === 0 && <span style={{ fontSize: 12, color: '#94A3B8' }}>{t('incidents.noTags')}</span>}
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('incidents.searchPerson')} style={inputStyle} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {hits.map(p => (
          <button key={p.id} type="button" onClick={() => { onChange([...selected, p.id]); setQuery(''); }} style={chip} title={p.roleLabel}>{p.name}</button>
        ))}
      </div>
    </div>
  );
}

function incidents() {
  return (supabase as unknown as { from: (table: string) => any }).from('incident_reports');
}

type DocLink = { url: string; name: string };

export interface IncidentRow {
  id: string;
  plant_id: string | null;
  occurred_at: string;
  where_text: string | null;
  what_text: string;
  who_text: string | null;
  how_text: string | null;
  solution_text: string | null;
  reported_by: string | null;
  photo_urls?: string[] | null;
  doc_urls?: DocLink[] | null;
  tagged_people?: string[] | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  plants?: { name: string } | null;
}

const blank = {
  plant: '',
  when: '',
  where: '',
  what: '',
  who: '',
  how: '',
  solution: '',
};

export function IncidentReports({
  plants,
  reporter,
  reporterRole,
  focusId,
  onCloseFocused,
  isAdmin = false,
}: {
  plants: { id: string; name: string }[];
  reporter: string;
  reporterRole: string;
  focusId?: string | null;
  /** Closing the incident that was opened by deep link (e.g. back to Activity Log). */
  onCloseFocused?: () => void;
  /** Admin may edit any incident; everyone else only the ones they reported. */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const people = useDirectory();
  const { activeProfile } = useRoleContext();
  const { scopeQuery, isGlobal, ready: scopeReady } = usePlantScope();
  const { addNotification } = useNotifications();
  const [rows, setRows] = useState<IncidentRow[]>([]);
  // Filters in the URL (q, plant, status, from, to) so back= / refresh keep them.
  const filters = useUrlFilters(['q', 'plant', 'status', 'from', 'to'] as const);
  const { q, plant: plantFilter, status: statusFilter, from: fromDate, to: toDate } = filters.values;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagQ, setTagQ] = useState('');
  const [detailTagQ, setDetailTagQ] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [docs, setDocs] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The incidents table arrives with the Mac SQL (0034/0035). Until it is on a
  // database, say so plainly instead of showing PostgREST's schema-cache text.
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<IncidentRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(blank);
  const [savingEdit, setSavingEdit] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  // The detail renders under the list — bring it into view when one is opened
  // (deep link from the Activity Log, or a row tap on a phone).
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);
  const defaultPlant = plants.length === 1 ? plants[0].id : '';

  const nameOf = (id: string | null | undefined) => people.find(p => p.id === id)?.name || id || '';

  // Someone is "on" an incident if they reported, took, or were tagged on it.
  const involves = (r: IncidentRow) =>
    r.reported_by === reporter || r.claimed_by === reporter || (r.tagged_people || []).includes(activeProfile.id);

  async function load() {
    if (!scopeReady) return;
    const { data, error } = await scopeQuery(incidents().select('*, plants(name)'))
      .order('occurred_at', { ascending: false });
    if (error) {
      const msg = String(error.message || '');
      const absent = error.code === 'PGRST205' || error.code === '42P01' || /incident_reports/.test(msg);
      setMissing(absent);
      setErr(absent ? null : msg);
      setRows([]);
      setLoading(false);
      return;
    }
    let list: IncidentRow[] = data || [];
    // Plant-less incidents (saved before Plant was required) fall outside every
    // plant grant, so scoped users lost them. Show them to the people on them.
    if (!isGlobal) {
      const { data: loose } = await incidents().select('*, plants(name)').is('plant_id', null);
      const mine = ((loose || []) as IncidentRow[]).filter(involves);
      if (mine.length) {
        const seen = new Set(list.map(r => r.id));
        list = [...list, ...mine.filter(r => !seen.has(r.id))]
          .sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''));
      }
    }
    setMissing(false);
    setErr(null);
    setRows(list);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [scopeQuery, scopeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focusId || rows.length === 0) return;
    const row = rows.find(r => r.id === focusId);
    if (row) setSelected(row);
  }, [focusId, rows]);

  async function notifyTagged(ids: string[], what: string, id: string, plantId: string | null) {
    const mine = ids.filter(pid => pid !== activeProfile.id);
    if (!mine.length) return;
    await addNotification({
      target_roles: mine,
      title: t('incidents.taggedYou', { name: reporter }),
      body: what,
      type: 'info',
      route: `/dashboard/purchase/maint?tab=incidents&incident=${id}`,
      actor_name: reporter,
      actor_role: reporterRole,
      scope: 'personal',
      plant_id: plantId,
    });
  }

  async function uploadExtras(id: string, photoFiles: File[], docFiles: File[]) {
    const photoUrls: string[] = [];
    for (const file of photoFiles) {
      const up = await uploadWorkflowImage(file, {
        workflow: 'maintenance', subfolder: 'incidents', entityId: id, kind: 'incident-photo', creator: reporter,
      });
      photoUrls.push(up.secure_url);
    }
    const docLinks: DocLink[] = [];
    for (const file of docFiles) {
      const up = await uploadWorkflowFile(file, {
        workflow: 'maintenance', subfolder: 'incidents', entityId: id, kind: 'incident-doc', creator: reporter,
      });
      docLinks.push({ url: up.secure_url, name: file.name });
    }
    return { photoUrls, docLinks };
  }

  async function save() {
    const plantId = form.plant || defaultPlant;
    if (!form.what.trim() || (plants.length > 0 && !plantId)) return;
    setSaving(true);
    setErr(null);
    const { data, error } = await incidents().insert({
      plant_id: plantId || null,
      occurred_at: form.when ? new Date(form.when).toISOString() : new Date().toISOString(),
      where_text: form.where.trim() || null,
      what_text: form.what.trim(),
      who_text: form.who.trim() || null,
      how_text: form.how.trim() || null,
      solution_text: form.solution.trim() || null,
      reported_by: reporter,
    }).select('id').single();
    if (error || !data?.id) {
      setSaving(false);
      setErr(error?.message || t('incidents.saveFailed'));
      return;
    }
    const id = data.id as string;
    try {
      const { photoUrls, docLinks } = await uploadExtras(id, photos, docs);
      const extra = {
        photo_urls: photoUrls,
        doc_urls: docLinks,
        tagged_people: tagIds,
      };
      const { error: extraErr } = await incidents().update(extra).eq('id', id);
      if (extraErr) {
        setErr(t('incidents.extrasNeedUpdate'));
      } else if (tagIds.length) {
        await notifyTagged(tagIds, form.what.trim(), id, plantId || null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('incidents.fileFailed'));
    }
    setSaving(false);
    setForm(blank);
    setTagIds([]);
    setPhotos([]);
    setDocs([]);
    setOpen(false);
    await load();
  }

  async function claim(row: IncidentRow) {
    if (row.claimed_by) return;
    const { error } = await incidents().update({
      claimed_by: reporter,
      claimed_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (error) {
      setErr(t('incidents.claimFailed'));
      return;
    }
    setSelected(s => s && s.id === row.id ? { ...s, claimed_by: reporter, claimed_at: new Date().toISOString() } : s);
    await load();
  }

  async function addToRow(row: IncidentRow, kind: 'photo' | 'doc', files: FileList | null) {
    if (!files?.length) return;
    setErr(null);
    try {
      const list = [...files];
      const { photoUrls, docLinks } = await uploadExtras(row.id, kind === 'photo' ? list : [], kind === 'doc' ? list : []);
      const nextPhotos = [...(row.photo_urls || []), ...photoUrls];
      const nextDocs = [...(row.doc_urls || []), ...docLinks];
      const { error } = await incidents().update({ photo_urls: nextPhotos, doc_urls: nextDocs }).eq('id', row.id);
      if (error) {
        setErr(t('incidents.fileNotLinked'));
        return;
      }
      const next = { ...row, photo_urls: nextPhotos, doc_urls: nextDocs };
      setSelected(next);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('incidents.uploadFailed'));
    }
  }

  async function setTags(row: IncidentRow, ids: string[]) {
    const { error } = await incidents().update({ tagged_people: ids }).eq('id', row.id);
    if (error) {
      setErr(t('incidents.tagFailed'));
      return;
    }
    const added = ids.filter(id => !(row.tagged_people || []).includes(id));
    if (added.length) await notifyTagged(added, row.what_text, row.id, row.plant_id);
    const next = { ...row, tagged_people: ids };
    setSelected(next);
    setRows(prev => prev.map(r => r.id === row.id ? next : r));
  }

  const canEdit = (r: IncidentRow) => isAdmin || (!!r.reported_by && r.reported_by === reporter);

  /** datetime-local wants local "YYYY-MM-DDTHH:mm". */
  const toLocalInput = (iso: string | null | undefined) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  function startEdit(r: IncidentRow) {
    setEditForm({
      plant: r.plant_id || '',
      when: toLocalInput(r.occurred_at),
      where: r.where_text || '',
      what: r.what_text || '',
      who: r.who_text || '',
      how: r.how_text || '',
      solution: r.solution_text || '',
    });
    setEditing(true);
  }

  async function saveEdit(row: IncidentRow) {
    if (!canEdit(row) || !editForm.what.trim()) return;
    setSavingEdit(true);
    setErr(null);
    const patch = {
      occurred_at: editForm.when ? new Date(editForm.when).toISOString() : row.occurred_at,
      where_text: editForm.where.trim() || null,
      what_text: editForm.what.trim(),
      who_text: editForm.who.trim() || null,
      how_text: editForm.how.trim() || null,
      solution_text: editForm.solution.trim() || null,
    };
    const { error } = await incidents().update(patch).eq('id', row.id);
    setSavingEdit(false);
    if (error) { setErr(t('incidents.editFailed', 'Could not save the changes.')); return; }
    const next = { ...row, ...patch };
    setSelected(next);
    setRows(prev => prev.map(r => (r.id === row.id ? next : r)));
    setEditing(false);
  }

  async function assignPlant(row: IncidentRow, plantId: string) {
    if (!plantId) return;
    const { error } = await incidents().update({ plant_id: plantId }).eq('id', row.id);
    if (error) { setErr(error.message); return; }
    const name = plants.find(p => p.id === plantId)?.name ?? null;
    const next = { ...row, plant_id: plantId, plants: name ? { name } : null };
    setSelected(next);
    setRows(prev => prev.map(r => r.id === row.id ? next : r));
  }

  const needle = q.trim().toLowerCase();
  const range = normalizeDayRange(fromDate, toDate);
  const shown = useMemo(() => rows.filter((r) => {
    if (plantFilter && r.plant_id !== plantFilter) return false;
    if (statusFilter === 'open' && r.claimed_by) return false;
    if (statusFilter === 'taken' && !r.claimed_by) return false;
    const day = istDayKey(r.occurred_at);
    if (range.from && day && day < range.from) return false;
    if (range.to && day && day > range.to) return false;
    if (!needle) return true;
    const tags = (r.tagged_people || []).map(nameOf).join(' ');
    return [r.what_text, r.who_text, r.where_text, r.how_text, r.solution_text, displayLocationName(r.plants?.name), r.plants?.name, r.reported_by, r.claimed_by, nameOf(r.claimed_by), tags]
      .some((v) => (v || '').toLowerCase().includes(needle));
  }), [rows, plantFilter, statusFilter, range.from, range.to, needle, people]); // eslint-disable-line react-hooks/exhaustive-deps
  // Paged like the other registers; a filter change goes back to page 1.
  const { pageRows: shownPage, controls: incidentPager } = usePagination(shown, {
    resetKey: `${q}|${plantFilter}|${statusFilter}|${fromDate}|${toDate}`,
  });

  const field = (label: string, key: keyof typeof blank, area = false) => (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{label}</div>
      {area ? (
        <textarea value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} rows={3} style={inputStyle} />
      ) : key === 'when' ? (
        <input type="datetime-local" value={form.when} onChange={(e) => setForm((f) => ({ ...f, when: e.target.value }))} style={inputStyle} />
      ) : (
        <input value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
      )}
    </label>
  );

  const editField = (label: string, key: keyof typeof blank, area = false) => (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{label}</div>
      {area ? (
        <textarea value={editForm[key]} onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))} rows={3} style={inputStyle} />
      ) : key === 'when' ? (
        <input type="datetime-local" value={editForm.when} onChange={(e) => setEditForm((f) => ({ ...f, when: e.target.value }))} style={inputStyle} />
      ) : (
        <input value={editForm[key]} onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
      )}
    </label>
  );

  return (
    <>
    <FilterBar
      className="mb-4"
      search={q}
      onSearch={(v) => filters.set({ q: v })}
      searchPlaceholder={t('incidents.search')}
      onReset={filters.reset}
    >
      {plants.length > 1 && (
        <FilterSelect
          icon={<Building2 />}
          value={plantFilter || 'all'}
          onChange={(v) => filters.set({ plant: v === 'all' ? '' : v })}
          options={[{ value: 'all', label: t('common.allPlants') }, ...plants.map((p) => ({ value: p.id, label: displayLocationName(p.name) }))]}
        />
      )}
      <FilterSelect
        icon={<Activity />}
        value={statusFilter || 'all'}
        onChange={(v) => filters.set({ status: v === 'all' ? '' : v })}
        options={[
          { value: 'all', label: t('common.allStatus') },
          { value: 'open', label: t('incidents.open') },
          { value: 'taken', label: t('incidents.statusTaken', 'Taken') },
        ]}
      />
      <DateRangeFilter from={fromDate} to={toDate} onChange={({ from, to }) => filters.set({ from, to })} />
    </FilterBar>
    <SectionCard
      title={t('incidents.title')}
      subtitle={t('incidents.subtitle')}
      actions={!missing ? (
        <ButtonV2
          variant="primary"
          icon={<Plus />}
          onClick={() => { setForm(f => ({ ...f, plant: f.plant || defaultPlant })); setOpen(true); }}
          disabled={scopeReady && plants.length === 0}
          title={scopeReady && plants.length === 0 ? t('incidents.noPlantAccess') : undefined}
        >{t('incidents.new')}</ButtonV2>
      ) : undefined}
    >
      {missing && (
        <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#334155', marginBottom: 12 }}>
          {t('incidents.notSwitchedOn')}
        </div>
      )}
      {err && <div style={{ color: '#B91C1C', fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div className="overflow-x-auto">
        <table className="dt2">
          <thead>
            <tr>
              <th>{t('incidents.colWhen')}</th><th>{t('incidents.colPlant')}</th><th>{t('incidents.colWhat')}</th><th>{t('incidents.colClaimed')}</th><th>{t('incidents.colTagged')}</th><th>{t('incidents.colFiles')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && !missing && <tr><td colSpan={6} className="text-center text-slate-400 py-6">…</td></tr>}
            {!loading && shown.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-6">{rows.length ? t('common.noRowsMatchFilters', 'No rows match these filters') : t('incidents.none')}</td></tr>}
            {shownPage.map((r) => (
              <tr key={r.id} onClick={() => { setSelected(r); setEditing(false); }} style={{ cursor: 'pointer' }}>
                <td className="whitespace-nowrap">{formatDateTime(r.occurred_at)}</td>
                <td>{displayLocationName(r.plants?.name) || t('incidents.noPlant')}</td>
                <td>{r.what_text}</td>
                <td>{r.claimed_by ? nameOf(r.claimed_by) : <StatusPill tone="amber" label={t('incidents.open')} />}</td>
                <td>{(r.tagged_people || []).map(nameOf).filter(Boolean).join(', ') || '—'}</td>
                <td>{(r.photo_urls || []).length + (r.doc_urls || []).length || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && shown.length > 0 && (
        <TablePaginationV2 controls={incidentPager} label={t('incidents.nounIncidents', 'incidents')} />
      )}
      {open && (
        <div style={{ marginTop: 16, border: '1px solid #E2E8F0', borderRadius: 12, padding: 14 }}>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{t('incidents.plant')} *</div>
            <select value={form.plant} onChange={(e) => setForm((f) => ({ ...f, plant: e.target.value }))} style={inputStyle}>
              <option value="">{t('incidents.selectPlant')}</option>
              {plants.map((p) => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </select>
          </label>
          {field(t('incidents.when'), 'when')}
          {field(t('incidents.who'), 'who')}
          {field(`${t('incidents.what')} *`, 'what', true)}
          {field(t('incidents.where'), 'where')}
          {field(t('incidents.how'), 'how', true)}
          {field(t('incidents.solution'), 'solution', true)}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{t('incidents.tagPeople')}</div>
            <TagPeople people={people} selected={tagIds} onChange={setTagIds} query={tagQ} setQuery={setTagQ} />
          </div>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{t('incidents.photos')}</div>
            <input type="file" accept="image/*" multiple onChange={(e) => setPhotos(e.target.files ? [...e.target.files] : [])} />
          </label>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{t('incidents.documents')}</div>
            <input type="file" multiple onChange={(e) => setDocs(e.target.files ? [...e.target.files] : [])} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <ButtonV2 variant="primary" onClick={() => void save()} disabled={saving || !form.what.trim() || (plants.length > 0 && !(form.plant || defaultPlant))}>{saving ? t('incidents.saving') : t('incidents.save')}</ButtonV2>
            <ButtonV2 variant="outline" onClick={() => setOpen(false)}>{t('incidents.cancel')}</ButtonV2>
          </div>
        </div>
      )}
      {selected && (
        <div ref={detailRef} style={{ marginTop: 16, border: '1px solid #E2E8F0', borderRadius: 12, padding: 14, scrollMarginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontWeight: 800 }}>{selected.what_text}</div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {canEdit(selected) && !editing && (
                <ButtonV2 variant="outline" size="sm" onClick={() => startEdit(selected)}>{t('incidents.edit', 'Edit')}</ButtonV2>
              )}
              <ButtonV2 variant="ghost" size="sm" onClick={() => { const wasFocus = selected.id === focusId; setSelected(null); setEditing(false); if (wasFocus) onCloseFocused?.(); }}>{t('incidents.close')}</ButtonV2>
            </div>
          </div>
          {editing && (
            <div style={{ marginTop: 12, borderTop: '1px solid #F1F5F9', paddingTop: 12 }}>
              {editField(t('incidents.when'), 'when')}
              {editField(t('incidents.who'), 'who')}
              {editField(`${t('incidents.what')} *`, 'what', true)}
              {editField(t('incidents.where'), 'where')}
              {editField(t('incidents.how'), 'how', true)}
              {editField(t('incidents.solution'), 'solution', true)}
              <div style={{ display: 'flex', gap: 8 }}>
                <ButtonV2 variant="primary" onClick={() => void saveEdit(selected)} disabled={savingEdit || !editForm.what.trim()}>{savingEdit ? t('incidents.saving') : t('incidents.saveChanges', 'Save changes')}</ButtonV2>
                <ButtonV2 variant="outline" onClick={() => setEditing(false)}>{t('incidents.cancel')}</ButtonV2>
              </div>
            </div>
          )}
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
            {formatDateTime(selected.occurred_at)}
            {' · '}{displayLocationName(selected.plants?.name) || t('incidents.noPlant')}
            {selected.who_text ? ` · ${selected.who_text}` : ''}
            {selected.reported_by ? ` · ${t('incidents.reportedBy', { name: selected.reported_by })}` : ''}
          </div>
          {!selected.plant_id && plants.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, color: '#B45309' }}>
              {t('incidents.assignPlant')}
              <select value="" onChange={(e) => void assignPlant(selected, e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
                <option value="">{t('incidents.selectPlant')}</option>
                {plants.map((p) => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
              </select>
            </label>
          )}
          {selected.where_text && <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>{t('incidents.where')}. </strong>{selected.where_text}</p>}
          {selected.how_text && <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>{t('incidents.how')}. </strong>{selected.how_text}</p>}
          {selected.solution_text && <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>{t('incidents.solution')}. </strong>{selected.solution_text}</p>}
          <div style={{ marginTop: 12 }}>
            {selected.claimed_by ? (
              <div style={{ fontSize: 13, fontWeight: 700 }}>{t('incidents.takenBy', { name: nameOf(selected.claimed_by) })}</div>
            ) : (
              <ButtonV2 variant="primary" onClick={() => void claim(selected)}>{t('incidents.take')}</ButtonV2>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>{t('incidents.taggedPeople')}</div>
            <TagPeople people={people} selected={selected.tagged_people || []} onChange={(ids) => void setTags(selected, ids)} query={detailTagQ} setQuery={setDetailTagQ} />
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(selected.photo_urls || []).map(url => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                <img src={url} alt="" style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E8F0' }} />
              </a>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            {(selected.doc_urls || []).map(d => (
              <a key={d.url} href={d.url} target="_blank" rel="noreferrer" style={{ display: 'block', fontSize: 12, color: '#2563EB', marginTop: 4 }}>{d.name || t('incidents.document')}</a>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ fontSize: 12 }}>
              {t('incidents.addPhotos')}
              <input type="file" accept="image/*" multiple onChange={(e) => { void addToRow(selected, 'photo', e.target.files); e.target.value = ''; }} />
            </label>
            <label style={{ fontSize: 12 }}>
              {t('incidents.addDocuments')}
              <input type="file" multiple onChange={(e) => { void addToRow(selected, 'doc', e.target.files); e.target.value = ''; }} />
            </label>
          </div>
        </div>
      )}
    </SectionCard>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', font: 'inherit', fontSize: 13, marginBottom: 0, boxSizing: 'border-box',
};
const chip: React.CSSProperties = {
  border: '1px solid #E2E8F0', borderRadius: 999, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
};
