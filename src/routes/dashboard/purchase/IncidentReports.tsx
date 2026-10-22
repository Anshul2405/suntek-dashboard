import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { displayLocationName } from '../../../lib/plantLabels';
import { uploadWorkflowFile, uploadWorkflowImage } from '../../../lib/cloudinary';
import { useDirectory } from '../../../lib/mentions';
import { useNotifications } from '../../../contexts/NotificationsContext';
import { useRoleContext } from '../../../contexts/RoleContext';

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

function dayKey(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function IncidentReports({
  plants,
  reporter,
  reporterRole,
  focusId,
}: {
  plants: { id: string; name: string }[];
  reporter: string;
  reporterRole: string;
  focusId?: string | null;
}) {
  const people = useDirectory();
  const { activeProfile } = useRoleContext();
  const { addNotification } = useNotifications();
  const [rows, setRows] = useState<IncidentRow[]>([]);
  const [q, setQ] = useState('');
  const [plantFilter, setPlantFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagQ, setTagQ] = useState('');
  const [detailTagQ, setDetailTagQ] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [docs, setDocs] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<IncidentRow | null>(null);

  const nameOf = (id: string | null | undefined) => people.find(p => p.id === id)?.name || id || '';

  async function load() {
    const { data, error } = await incidents()
      .select('*, plants(name)')
      .order('occurred_at', { ascending: false });
    if (error) setErr(error.message);
    else { setErr(null); setRows(data || []); }
  }

  useEffect(() => { void load(); }, []);

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
      title: `${reporter} tagged you on an incident`,
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
    if (!form.what.trim()) return;
    setSaving(true);
    setErr(null);
    const { data, error } = await incidents().insert({
      plant_id: form.plant || null,
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
      setErr(error?.message || 'Could not save the incident.');
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
        setErr('The incident is saved. Photos, documents, tags, and claim need the incident database update before they can be stored.');
      } else if (tagIds.length) {
        await notifyTagged(tagIds, form.what.trim(), id, form.plant || null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The incident is saved, but a file did not upload.');
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
      setErr('Could not claim this incident. The incident database update has to be applied first.');
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
        setErr('The file uploaded, but it could not be saved on the incident. Apply the incident database update first.');
        return;
      }
      const next = { ...row, photo_urls: nextPhotos, doc_urls: nextDocs };
      setSelected(next);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    }
  }

  async function setTags(row: IncidentRow, ids: string[]) {
    const { error } = await incidents().update({ tagged_people: ids }).eq('id', row.id);
    if (error) {
      setErr('Could not save the tagged people. Apply the incident database update first.');
      return;
    }
    const added = ids.filter(id => !(row.tagged_people || []).includes(id));
    if (added.length) await notifyTagged(added, row.what_text, row.id, row.plant_id);
    const next = { ...row, tagged_people: ids };
    setSelected(next);
    setRows(prev => prev.map(r => r.id === row.id ? next : r));
  }

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((r) => {
    if (plantFilter && r.plant_id !== plantFilter) return false;
    const day = dayKey(r.occurred_at);
    if (fromDate && day && day < fromDate) return false;
    if (toDate && day && day > toDate) return false;
    if (!needle) return true;
    const tags = (r.tagged_people || []).map(nameOf).join(' ');
    return [r.what_text, r.who_text, r.where_text, r.how_text, r.solution_text, displayLocationName(r.plants?.name), r.plants?.name, r.reported_by, r.claimed_by, nameOf(r.claimed_by), tags]
      .some((v) => (v || '').toLowerCase().includes(needle));
  }), [rows, plantFilter, fromDate, toDate, needle, people]);

  const tagChoices = people.filter(p => {
    const n = tagQ.trim().toLowerCase();
    if (!n) return true;
    return p.name.toLowerCase().includes(n) || p.roleLabel.toLowerCase().includes(n);
  }).slice(0, 8);

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

  return (
    <div className="card2 p-5">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 800 }}>Incident reports</div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>In-house work: who, what, when, where, how, the solution, photos, documents, and who has taken it.</div>
        </div>
        <button type="button" onClick={() => setOpen(true)} style={btn}>New incident</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search incidents" style={{ ...inputStyle, flex: 1, minWidth: 180, marginBottom: 0 }} />
        <select value={plantFilter} onChange={(e) => setPlantFilter(e.target.value)} style={{ ...inputStyle, width: 'auto', minWidth: 160, marginBottom: 0 }}>
          <option value="">All plants</option>
          {plants.map((p) => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
        </select>
        <label style={{ fontSize: 12, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 'auto', marginBottom: 0 }} />
        </label>
        <label style={{ fontSize: 12, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 'auto', marginBottom: 0 }} />
        </label>
      </div>
      {err && <div style={{ color: '#B91C1C', fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div className="overflow-x-auto">
        <table className="dt2">
          <thead>
            <tr>
              <th>When</th><th>Plant</th><th>What</th><th>Claimed</th><th>Tagged</th><th>Files</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-6">No incidents match.</td></tr>}
            {shown.map((r) => (
              <tr key={r.id} onClick={() => setSelected(r)} style={{ cursor: 'pointer' }}>
                <td>{new Date(r.occurred_at).toLocaleString('en-IN')}</td>
                <td>{displayLocationName(r.plants?.name) || '—'}</td>
                <td>{r.what_text}</td>
                <td>{r.claimed_by ? nameOf(r.claimed_by) : 'Open'}</td>
                <td>{(r.tagged_people || []).map(nameOf).filter(Boolean).join(', ') || '—'}</td>
                <td>{(r.photo_urls || []).length + (r.doc_urls || []).length || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <div style={{ marginTop: 16, border: '1px solid #E2E8F0', borderRadius: 12, padding: 14 }}>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>Plant</div>
            <select value={form.plant} onChange={(e) => setForm((f) => ({ ...f, plant: e.target.value }))} style={inputStyle}>
              <option value="">Select plant</option>
              {plants.map((p) => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </select>
          </label>
          {field('When', 'when')}
          {field('Who', 'who')}
          {field('What broke / what happened', 'what', true)}
          {field('Where', 'where')}
          {field('How it happened', 'how', true)}
          {field('Solution', 'solution', true)}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>Tag people</div>
            <input value={tagQ} onChange={(e) => setTagQ(e.target.value)} placeholder="Search a person" style={inputStyle} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {tagChoices.map(p => (
                <button key={p.id} type="button" onClick={() => setTagIds(ids => ids.includes(p.id) ? ids.filter(x => x !== p.id) : [...ids, p.id])} style={{ ...chip, background: tagIds.includes(p.id) ? '#0F172A' : '#fff', color: tagIds.includes(p.id) ? '#fff' : '#0F172A' }}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>Photos</div>
            <input type="file" accept="image/*" multiple onChange={(e) => setPhotos(e.target.files ? [...e.target.files] : [])} />
          </label>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>Documents</div>
            <input type="file" multiple onChange={(e) => setDocs(e.target.files ? [...e.target.files] : [])} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => void save()} disabled={saving || !form.what.trim()} style={btn}>{saving ? 'Saving…' : 'Save incident'}</button>
            <button type="button" onClick={() => setOpen(false)} style={{ ...btn, background: '#fff', color: '#0F172A', border: '1px solid #E2E8F0' }}>Cancel</button>
          </div>
        </div>
      )}
      {selected && (
        <div style={{ marginTop: 16, border: '1px solid #E2E8F0', borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontWeight: 800 }}>{selected.what_text}</div>
            <button type="button" onClick={() => setSelected(null)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748B' }}>Close</button>
          </div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
            {new Date(selected.occurred_at).toLocaleString('en-IN')}
            {' · '}{displayLocationName(selected.plants?.name) || 'No plant'}
            {selected.who_text ? ` · ${selected.who_text}` : ''}
            {selected.reported_by ? ` · reported by ${selected.reported_by}` : ''}
          </div>
          {selected.where_text && <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>Where. </strong>{selected.where_text}</p>}
          {selected.how_text && <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>How. </strong>{selected.how_text}</p>}
          {selected.solution_text && <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>Solution. </strong>{selected.solution_text}</p>}
          <div style={{ marginTop: 12 }}>
            {selected.claimed_by ? (
              <div style={{ fontSize: 13, fontWeight: 700 }}>Taken by {nameOf(selected.claimed_by)}</div>
            ) : (
              <button type="button" onClick={() => void claim(selected)} style={btn}>Take this incident</button>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>Tagged people</div>
            <input value={detailTagQ} onChange={(e) => setDetailTagQ(e.target.value)} placeholder="Search a person to tag" style={{ ...inputStyle, marginBottom: 8 }} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {people.filter(p => {
                const on = (selected.tagged_people || []).includes(p.id);
                const n = detailTagQ.trim().toLowerCase();
                if (on) return true;
                if (!n) return false;
                return p.name.toLowerCase().includes(n) || p.roleLabel.toLowerCase().includes(n);
              }).slice(0, 12).map(p => {
                const on = (selected.tagged_people || []).includes(p.id);
                return (
                  <button key={p.id} type="button" onClick={() => {
                    const cur = selected.tagged_people || [];
                    void setTags(selected, on ? cur.filter(id => id !== p.id) : [...cur, p.id]);
                  }} style={{ ...chip, background: on ? '#0F172A' : '#fff', color: on ? '#fff' : '#0F172A' }}>
                    {p.name}
                  </button>
                );
              })}
            </div>
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
              <a key={d.url} href={d.url} target="_blank" rel="noreferrer" style={{ display: 'block', fontSize: 12, color: '#2563EB', marginTop: 4 }}>{d.name || 'Document'}</a>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ fontSize: 12 }}>
              Add photos
              <input type="file" accept="image/*" multiple onChange={(e) => { void addToRow(selected, 'photo', e.target.files); e.target.value = ''; }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Add documents
              <input type="file" multiple onChange={(e) => { void addToRow(selected, 'doc', e.target.files); e.target.value = ''; }} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', font: 'inherit', fontSize: 13, marginBottom: 0, boxSizing: 'border-box',
};
const btn: React.CSSProperties = {
  background: '#0F172A', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer',
};
const chip: React.CSSProperties = {
  border: '1px solid #E2E8F0', borderRadius: 999, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
};
