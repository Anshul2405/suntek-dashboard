import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { fetchActivePlants } from '../../../lib/plants';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { useRoleContext } from '../../../contexts/RoleContext';
import { isAdminProfile } from '../../../lib/profiles';
import { useDirectory, addWatchers, postNote } from '../../../lib/mentions';
import { incidentNoLabel, ticketNoForId, useTicketNos } from '../../../lib/ticketNo';
import { formatDate, formatDateTime, inIstDayRange, istToday } from '../../../lib/utils/formatting';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, PanelFooter } from '../../../components/SlidePanel';
import { CcSelect, NotesButton } from '../../../components/mentions';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, EmptyState } from '../../../components/ui/states';
import { usePagination } from '../../../components/ui/usePagination';
import { SectionCard, ButtonV2, TablePaginationV2, InfoBanner, FilterBar, DateRangeFilter } from '../../../components/v2';
import type { Database } from '../../../lib/database.types';

type IncidentRow = Database['public']['Tables']['incident_reports']['Row'] & { plants?: { name: string | null } | null };
type Severity = IncidentRow['severity'];

export const INCIDENT_ROUTE = (id: string) => `/dashboard/purchase/maint?tab=incidents&incident=${id}`;

const SEVERITY_TONE: Record<Severity, { bg: string; color: string }> = {
  low: { bg: '#F1F5F9', color: '#475569' },
  medium: { bg: '#FEF3C7', color: '#B45309' },
  high: { bg: '#FFEDD5', color: '#C2410C' },
  critical: { bg: '#FEE2E2', color: '#DC2626' },
};

export interface IncidentPrefill { ticketId: string; plantId: string | null; equipment: string }

/**
 * Incident reports — the Maintenance "Incidents" tab.
 *
 *  • Raise only for the plants you belong to (same rule as tickets).
 *  • Tagged people are stored on the row (tagged_ids / tagged_names), become
 *    watchers, and get a personal bell item that deep-links back here.
 *  • Raised from a ticket → linked both ways (ticket_id here + a note on the
 *    ticket's trail).
 *  • Rows also appear in the Activity Log (source = incident) and open here.
 */
export function IncidentsPanel({ focusId, onFocusConsumed, prefill, onPrefillConsumed, onOpenTicket, onDetailClosed }: {
  focusId?: string | null;
  onFocusConsumed?: () => void;
  prefill?: IncidentPrefill | null;
  onPrefillConsumed?: () => void;
  onOpenTicket: (ticketId: string) => void;
  /** Detail panel closed — the host honours ?from= (e.g. back to Activity Log). */
  onDetailClosed?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const people = useDirectory();
  const { activeProfile, activePersonId } = useRoleContext();
  const { scopeQuery, allowedPlants, isGlobal, inScope } = usePlantScope();
  const isAdmin = isAdminProfile(activeProfile);
  const isUnitHead = (activeProfile.baseRoleId ?? activeProfile.id) === 'unit_head';

  const [rows, setRows] = useState<IncidentRow[]>([]);
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTable, setMissingTable] = useState(false);
  const [q, setQ] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [selected, setSelected] = useState<IncidentRow | null>(null);
  const [showRaise, setShowRaise] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const BLANK = { plant: '', title: '', severity: 'medium' as Severity, occurred: istToday(), location: '', description: '', tagged: [] as string[], ticketId: '' };
  const [form, setForm] = useState(BLANK);
  const [editTags, setEditTags] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const { data: pl } = await fetchActivePlants<{ id: string; name: string }>('id, name');
    if (pl?.length) setDbPlants(pl);
    let res = await scopeQuery(supabase.from('incident_reports').select('*, plants(name)'))
      .order('created_at', { ascending: false }).returns<IncidentRow[]>();
    if (res.error && !/does not exist|schema cache|PGRST20/i.test(res.error.message || '')) {
      res = await scopeQuery(supabase.from('incident_reports').select('*'))
        .order('created_at', { ascending: false }).returns<IncidentRow[]>();
    }
    if (res.error) {
      setMissingTable(/does not exist|schema cache|PGRST20|incident_reports/i.test(res.error.message || ''));
      setRows([]);
    } else {
      setMissingTable(false);
      setRows(res.data || []);
    }
    setLoading(false);
  }, [scopeQuery]);

  useEffect(() => { load(); }, [load]);

  // Same plant rule as raising a ticket: scoped users only see their plants.
  const plantOptions = useMemo(() => {
    const src = isGlobal ? (allowedPlants.length ? allowedPlants : dbPlants) : allowedPlants;
    return [...src].sort((a, b) => a.name.localeCompare(b.name));
  }, [isGlobal, allowedPlants, dbPlants]);
  const plantAllowed = (id: string) => !!id && (isGlobal || inScope(id));

  // Ticket numbers for linked tickets (MT-0042).
  const ticketLabel = useTicketNos(rows.map(r => r.ticket_id));

  // Deep link (bell / Activity Log): open that incident once rows are loaded.
  useEffect(() => {
    if (!focusId || loading) return;
    const hit = rows.find(r => r.id === focusId);
    if (hit) setSelected(hit);
    else if (!missingTable) toast.info(t('incident.notFound', 'That incident is not available — it may be outside your plants.'));
    onFocusConsumed?.();
  }, [focusId, loading, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Raised from a ticket: open the form pre-linked.
  useEffect(() => {
    if (!prefill) return;
    setForm({ ...BLANK, plant: prefill.plantId && plantAllowed(prefill.plantId) ? prefill.plantId : (plantOptions[0]?.id ?? ''), title: prefill.equipment ? `${prefill.equipment} — ` : '', ticketId: prefill.ticketId });
    setShowRaise(true);
    onPrefillConsumed?.();
  }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  function openRaise() {
    setForm({ ...BLANK, plant: plantOptions[0]?.id ?? '' });
    setSaved(false);
    setShowRaise(true);
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (!inIstDayRange(r.occurred_at || r.created_at, range.from, range.to)) return false;
      if (!needle) return true;
      const hay = [incidentNoLabel(r), r.title, r.description, r.location, r.plants?.name, r.raised_by, ...(r.tagged_names || []), r.ticket_id ? ticketNoForId(r.ticket_id) : '']
        .join(' ').toLowerCase();
      return hay.includes(needle) || incidentNoLabel(r).toLowerCase().replace('-', '').includes(needle.replace('-', ''));
    });
  }, [rows, q, range]);
  // Reset to page 1 only on the user's own search / date changes.
  const { pageRows, controls } = usePagination(filtered, { resetKey: `${q}|${range.from}|${range.to}` });

  async function notifyTagged(row: IncidentRow, ids: string[]) {
    const targets = ids.filter(id => id !== activePersonId);
    if (!targets.length) return;
    const tagged = people.filter(p => targets.includes(p.id));
    await insertRows('notifications', {
      target_roles: targets,
      title: t('incident.taggedTitle', { defaultValue: '{{name}} tagged you on incident {{no}}', name: activeProfile.name, no: incidentNoLabel(row) }),
      body: `${row.title}${row.plants?.name ? ` · ${row.plants.name}` : ''}`,
      type: row.severity === 'critical' || row.severity === 'high' ? 'urgent' : 'warning',
      route: INCIDENT_ROUTE(row.id),
      actor_name: activeProfile.name,
      actor_role: activeProfile.roleLabel,
      read_by: [],
      scope: 'personal',
    }).then(() => {}, () => {});
    await addWatchers({ entityType: 'incident', entityId: row.id, entityLabel: row.title, route: INCIDENT_ROUTE(row.id) }, tagged, 'mention', activeProfile.name);
  }

  async function handleSave() {
    if (saving) return;
    if (!form.title.trim()) return;
    if (!plantAllowed(form.plant)) {
      toast.error(t('maint.plantOutOfScope', 'Pick one of your plants — you can only raise tickets for plants you belong to.'));
      return;
    }
    setSaving(true);
    try {
      const tagged = people.filter(p => form.tagged.includes(p.id));
      const { data, error } = await insertRows('incident_reports', {
        plant_id: form.plant,
        ticket_id: form.ticketId || null,
        title: form.title.trim(),
        description: form.description.trim() || null,
        severity: form.severity,
        occurred_at: new Date(`${form.occurred || istToday()}T${new Date().toTimeString().slice(0, 8)}+05:30`).toISOString(),
        location: form.location.trim() || null,
        tagged_ids: tagged.map(p => p.id),
        tagged_names: tagged.map(p => p.name),
        raised_by: activeProfile.name,
        raised_by_id: activePersonId,
      }).select('*, plants(name)').single();
      if (error || !data) {
        toast.error(t('incident.saveFailed', { defaultValue: 'Could not save incident: {{message}}', message: error?.message || '—' }));
        return;
      }
      const row = data as IncidentRow;
      await notifyTagged(row, row.tagged_ids);
      // Plant's unit head + admin hear about every incident.
      await insertRows('notifications', {
        target_roles: ['admin', 'unit_head'],
        title: t('incident.raisedTitle', { defaultValue: 'Incident {{no}}: {{title}}', no: incidentNoLabel(row), title: row.title }),
        body: `${activeProfile.name} · ${t('incident.sev_' + row.severity, row.severity)}`,
        type: row.severity === 'critical' || row.severity === 'high' ? 'urgent' : 'warning',
        route: INCIDENT_ROUTE(row.id),
        actor_name: activeProfile.name, actor_role: activeProfile.roleLabel, read_by: [],
        plant_id: row.plant_id,
      }).then(() => {}, () => {});
      // Raised from a ticket → leave the link on the ticket's own trail too.
      if (row.ticket_id) {
        await postNote({
          ref: { entityType: 'maintenance_ticket', entityId: row.ticket_id, entityLabel: form.title, route: `/dashboard/purchase/maint?ticket=${row.ticket_id}` },
          actor: { id: activePersonId, name: activeProfile.name, role: activeProfile.roleLabel },
          body: `⚠ Incident ${incidentNoLabel(row)} reported: ${row.title}`,
          mentionIds: [], people,
          addNotification: async () => true,
        }).catch(() => {});
      }
      setRows(prev => [row, ...prev]);
      setSaved(true);
      toast.success(t('incident.saved', { defaultValue: 'Incident {{no}} reported', no: incidentNoLabel(row) }));
      setTimeout(() => { setShowRaise(false); setSaved(false); setForm(BLANK); }, 900);
    } finally {
      setSaving(false);
    }
  }

  async function saveTags(row: IncidentRow, ids: string[]) {
    const tagged = people.filter(p => ids.includes(p.id));
    const added = ids.filter(id => !row.tagged_ids.includes(id));
    const { error } = await updateRows('incident_reports', { tagged_ids: tagged.map(p => p.id), tagged_names: tagged.map(p => p.name) }).eq('id', row.id);
    if (error) { toast.error(error.message); return; }
    const next = { ...row, tagged_ids: tagged.map(p => p.id), tagged_names: tagged.map(p => p.name) };
    setRows(prev => prev.map(r => (r.id === row.id ? next : r)));
    setSelected(next);
    setEditTags(null);
    await notifyTagged(next, added);
    toast.success(t('incident.tagsSaved', 'Tags saved — new people notified'));
  }

  async function closeIncident(row: IncidentRow) {
    const patch = { status: 'closed' as const, closed_by: activeProfile.name, closed_at: new Date().toISOString() };
    const { error } = await updateRows('incident_reports', patch).eq('id', row.id);
    if (error) { toast.error(error.message); return; }
    const next = { ...row, ...patch };
    setRows(prev => prev.map(r => (r.id === row.id ? next : r)));
    setSelected(next);
  }

  return (
    <>
      {missingTable && (
        <InfoBanner className="mb-4" tone="amber">
          {t('incident.needsMigration', 'Incident reports need database migration 0022 (incident_reports). Ask the admin to apply it.')}
        </InfoBanner>
      )}
      <FilterBar className="mb-4" search={q} onSearch={setQ} searchPlaceholder={t('incident.searchPh', 'Search incident no., title, plant, person, ticket…')}
        onReset={() => { setQ(''); setRange({ from: '', to: '' }); }}>
        <DateRangeFilter from={range.from} to={range.to} onChange={setRange} />
      </FilterBar>
      <SectionCard
        flush
        title={t('incident.title', 'Incident reports')}
        subtitle={t('incident.sub', 'Safety / process incidents for your plants. Tag people to notify them.')}
        actions={<ButtonV2 variant="primary" icon={<Plus />} onClick={openRaise} disabled={missingTable || plantOptions.length === 0}>{t('incident.raise', 'Report incident')}</ButtonV2>}
      >
        {loading ? <div className="px-5 pb-5"><SkeletonRows rows={4} /></div> : filtered.length === 0 ? (
          <div className="px-5 pb-5"><EmptyState title={t('incident.empty', 'No incidents')} message={q || range.from || range.to ? t('common.noMatches', 'No rows match your search.') : undefined} /></div>
        ) : (
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <th>{t('incident.colNo', 'Incident #')}</th><th>{t('incident.colTitle', 'Incident')}</th><th>{t('common.plant', 'Plant')}</th>
                  <th>{t('incident.colSeverity', 'Severity')}</th><th>{t('incident.colTicket', 'Ticket')}</th><th>{t('incident.colTagged', 'Tagged')}</th>
                  <th>{t('incident.colWhen', 'Occurred')}</th><th>{t('incident.colStatus', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(r => (
                  <tr key={r.id} onClick={() => setSelected(r)} style={{ cursor: 'pointer' }} data-testid="incident-row">
                    <td className="font-mono text-xs text-slate-500">{incidentNoLabel(r)}</td>
                    <td className="font-semibold">{r.title}</td>
                    <td>{r.plants?.name || dbPlants.find(p => p.id === r.plant_id)?.name || '—'}</td>
                    <td><span className="badge" style={SEVERITY_TONE[r.severity]}>{t('incident.sev_' + r.severity, r.severity)}</span></td>
                    <td>{r.ticket_id ? <button type="button" className="num text-xs text-blue-600 font-semibold" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }} onClick={e => { e.stopPropagation(); onOpenTicket(r.ticket_id!); }}>{ticketLabel(r.ticket_id)}</button> : <span className="text-slate-300">—</span>}</td>
                    <td className="text-xs text-slate-500">{(r.tagged_names || []).join(', ') || '—'}</td>
                    <td className="text-xs text-slate-500">{formatDate(r.occurred_at)}</td>
                    <td><span className="badge" style={{ background: r.status === 'closed' ? '#DCFCE7' : '#FEF3C7', color: r.status === 'closed' ? '#16A34A' : '#B45309' }}>{r.status === 'closed' ? t('incident.closed', 'Closed') : t('incident.open', 'Open')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <TablePaginationV2 controls={controls} label={t('incident.noun', 'incidents')} />
          </div>
        )}
      </SectionCard>

      {/* Raise */}
      <SlidePanel open={showRaise} onClose={() => { setShowRaise(false); setSaved(false); }} title={t('incident.raise', 'Report incident')} subtitle={form.ticketId ? t('incident.fromTicket', { defaultValue: 'Linked to ticket {{no}}', no: ticketNoForId(form.ticketId) }) : t('incident.panelSub', 'Maintenance · Incidents')}>
        <PanelField label={t('incident.fieldTitle', 'What happened? *')}>
          <PanelInput value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder={t('incident.titlePh', 'e.g. Acid spill near reactor R-2')} />
        </PanelField>
        <PanelRow>
          <PanelField label={t('common.plant', 'Plant')}>
            <PanelSelect value={form.plant} onChange={e => setForm(f => ({ ...f, plant: e.target.value }))} data-testid="incident-plant">
              <option value="">{t('maint.selectPlant', 'Select plant')}</option>
              {plantOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </PanelSelect>
          </PanelField>
          <PanelField label={t('incident.colSeverity', 'Severity')}>
            <PanelSelect value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value as Severity }))}>
              {(['low', 'medium', 'high', 'critical'] as Severity[]).map(s => <option key={s} value={s}>{t('incident.sev_' + s, s)}</option>)}
            </PanelSelect>
          </PanelField>
        </PanelRow>
        <PanelRow>
          <PanelField label={t('incident.colWhen', 'Occurred')}>
            <PanelInput type="date" value={form.occurred} max={istToday()} onChange={e => setForm(f => ({ ...f, occurred: e.target.value }))} />
          </PanelField>
          <PanelField label={t('incident.fieldLocation', 'Location')}>
            <PanelInput value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder={t('incident.locationPh', 'Area / equipment')} />
          </PanelField>
        </PanelRow>
        <PanelField label={t('incident.fieldDescription', 'Details')}>
          <PanelTextarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder={t('incident.descPh', 'What happened, who was involved, immediate action taken…')} />
        </PanelField>
        <CcSelect value={form.tagged} onChange={ids => setForm(f => ({ ...f, tagged: ids }))} label={t('incident.tagPeople', 'Tag people (they get a notification)')} placeholder={t('incident.tagPh', 'Add people…')} />
        <PanelDivider />
        <PanelFooter saved={saved} onCancel={() => setShowRaise(false)} onSave={handleSave}
          saveLabel={saving ? t('maint.savingEllipsis', 'Saving…') : t('incident.save', 'Report incident')}
          successLabel={t('incident.savedShort', 'Incident reported')} successSub={t('incident.savedSub', 'Tagged people notified')}
          disabled={saving || !form.title.trim() || !plantAllowed(form.plant)} requiredHint={t('incident.requiredHint', 'Add what happened and pick one of your plants')} />
      </SlidePanel>

      {/* Detail */}
      <SlidePanel open={!!selected} onClose={() => { setSelected(null); setEditTags(null); onDetailClosed?.(); }} title={selected ? `${incidentNoLabel(selected)} · ${selected.title}` : ''} subtitle={selected?.plants?.name || ''}>
        {selected && (
          <div data-testid="incident-detail">
            {([
              [t('incident.colSeverity', 'Severity'), <span className="badge" style={SEVERITY_TONE[selected.severity]}>{t('incident.sev_' + selected.severity, selected.severity)}</span>],
              [t('incident.colWhen', 'Occurred'), formatDate(selected.occurred_at)],
              [t('incident.fieldLocation', 'Location'), selected.location || '—'],
              [t('incident.raisedBy', 'Reported by'), `${selected.raised_by || '—'} · ${formatDateTime(selected.created_at)}`],
              [t('incident.colStatus', 'Status'), selected.status === 'closed' ? `${t('incident.closed', 'Closed')} · ${selected.closed_by || ''} ${selected.closed_at ? formatDate(selected.closed_at) : ''}` : t('incident.open', 'Open')],
            ] as [string, React.ReactNode][]).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 12, color: '#94A3B8' }}>{k}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', textAlign: 'right' }}>{v}</span>
              </div>
            ))}
            {selected.description && <div style={{ fontSize: 13, color: '#334155', marginTop: 12, whiteSpace: 'pre-wrap' }}>{selected.description}</div>}
            {selected.ticket_id && (
              <button type="button" className="chip" style={{ marginTop: 12 }} onClick={() => onOpenTicket(selected.ticket_id!)}>
                {t('incident.openTicket', { defaultValue: 'Open ticket {{no}}', no: ticketLabel(selected.ticket_id) })}
              </button>
            )}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', marginBottom: 6 }}>{t('incident.colTagged', 'Tagged')}</div>
              {editTags ? (
                <>
                  <CcSelect value={editTags} onChange={setEditTags} label="" />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <ButtonV2 variant="outline" onClick={() => setEditTags(null)}>{t('common.cancel', 'Cancel')}</ButtonV2>
                    <ButtonV2 variant="primary" onClick={() => saveTags(selected, editTags)}>{t('incident.saveTags', 'Save tags')}</ButtonV2>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: '#334155' }} data-testid="incident-tagged">{(selected.tagged_names || []).join(', ') || '—'}</span>
                  <button type="button" className="chip" onClick={() => setEditTags(selected.tagged_ids || [])}>{t('incident.editTags', '+ Tag people')}</button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <NotesButton entityType="incident" entityId={selected.id} entityLabel={selected.title} route={INCIDENT_ROUTE(selected.id)} />
              {selected.status !== 'closed' && (isAdmin || isUnitHead) && (
                <button type="button" className="chip" onClick={() => closeIncident(selected)}>{t('incident.close', '✓ Close incident')}</button>
              )}
            </div>
          </div>
        )}
      </SlidePanel>
    </>
  );
}
