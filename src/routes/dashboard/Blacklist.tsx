import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldBan, UserX, Car, Building2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { insertRows, updateRows } from '../../lib/db';
import { useMentionNotifier } from '../../lib/mentions';
import { logBlacklistEvent } from '../../lib/blacklist/guard';
import { exportToCsv, type CsvColumn } from '../../lib/utils/exportCsv';
import { useRoleContext } from '../../contexts/RoleContext';
import { useBlacklist } from '../../contexts/BlacklistContext';
import { NotesButton } from '../../components/mentions';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, PanelFooter } from '../../components/SlidePanel';
import { useToast } from '../../components/ui/toast';
import { useSortable } from '../../components/ui/useSortable';
import { ThV2 as Th, WorkCard } from '../../components/v2';
import type { BlacklistEntry } from '../../contexts/BlacklistContext';
import type { Database } from '../../lib/database.types';
import { usePagination } from '../../components/ui/usePagination';
import { TablePaginationV2 } from '../../components/v2';
import { formatDate, formatDateTime, istToday } from '../../lib/utils/formatting';
import { compactVehicleNo, isValidVehicleNo } from '../../lib/validate/vehicleNo';

type BlacklistEventRow = Database['public']['Tables']['blacklist_events']['Row'];

function fmtDT(d: string | null | undefined): string {
  return d ? formatDateTime(d) : '';
}

// Audit report layouts.
const ENTRY_COLUMNS: CsvColumn[] = [
  { header: 'Blacklist ID', key: 'id' },
  { header: 'Type', key: 'type' },
  { header: 'Name / registration', key: 'name' },
  { header: 'Identifier', key: 'identifier' },
  { header: 'Severity', key: 'severity' },
  { header: 'Status', key: 'status' },
  { header: 'Reason', key: 'reason' },
  { header: 'Notes', key: 'notes' },
  { header: 'Reference no', key: 'reference_no' },
  { header: 'Added by', key: 'added_by' },
  { header: 'Added by role', key: 'added_by_role' },
  { header: 'Added at', key: 'added_at' },
  { header: 'Resolved by', key: 'resolved_by' },
  { header: 'Resolved at', key: 'resolved_at' },
  { header: 'Resolved reason', key: 'resolved_reason' },
  { header: 'Match detections', key: 'hits' },
];
const EVENT_COLUMNS: CsvColumn[] = [
  { header: 'Blacklist ID', key: 'blacklist_id' },
  { header: 'Entity', key: 'entity_name' },
  { header: 'Entity type', key: 'entity_type' },
  { header: 'Event', key: 'event_type' },
  { header: 'Matched value (entered/OCR)', key: 'matched_value' },
  { header: 'Similarity %', key: 'sim' },
  { header: 'Workflow', key: 'workflow' },
  { header: 'Source', key: 'source' },
  { header: 'Field', key: 'field' },
  { header: 'By', key: 'actor_name' },
  { header: 'By role', key: 'actor_role' },
  { header: 'Image', key: 'image_url' },
  { header: 'At', key: 'at' },
];

// ── Config ────────────────────────────────────────────────────────────────────

const TYPE_CFG = {
  person:  { label: 'Person',  bg: '#F1F5F9', color: '#475569', icon: '👤' },
  vehicle: { label: 'Vehicle', bg: '#EFF6FF', color: '#2563EB', icon: '🚛' },
  vendor:  { label: 'Vendor',  bg: '#F5F3FF', color: '#7C3AED', icon: '🏢' },
  other:   { label: 'Other',   bg: '#F0FDF4', color: '#16A34A', icon: '⚠' },
};

const SEV_CFG = {
  low:      { label: 'Low',      bg: '#EFF6FF', color: '#2563EB' },
  medium:   { label: 'Medium',   bg: '#FFFBEB', color: '#D97706' },
  high:     { label: 'High',     bg: '#FFF7ED', color: '#EA580C' },
  critical: { label: 'Critical', bg: '#FEF2F2', color: '#DC2626' },
};

// Blacklist severity → notification type, so the bell colour matches severity.
const SEVERITY_NOTIF_TYPE: Record<string, 'info' | 'warning' | 'urgent' | 'critical'> = {
  low: 'info', medium: 'warning', high: 'urgent', critical: 'critical',
};
const SEV_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const SEV_ORDER = ['low', 'medium', 'high', 'critical'] as const;

const SEV_DESCRIPTIONS: Record<string, string> = {
  low:      'Monitor only — no immediate operational impact',
  medium:   'Caution advised — limited interactions allowed',
  high:     'Block all assignments and access — escalation required',
  critical: 'Immediate halt — notify security and management',
};

const TYPE_LABELS: Record<string, { nameLabel: string; namePlaceholder: string; identifierLabel: string; identifierPlaceholder: string }> = {
  person:  { nameLabel: 'Full name',                     namePlaceholder: 'e.g. Rajesh Kumar',          identifierLabel: 'Employee ID / Aadhaar (last 4)', identifierPlaceholder: 'e.g. EMP-042 or 1234' },
  vehicle: { nameLabel: 'Vehicle registration number',   namePlaceholder: 'e.g. JH01AB1234',             identifierLabel: 'Fleet number / owner name',      identifierPlaceholder: 'e.g. FLEET-07 or driver name' },
  vendor:  { nameLabel: 'Vendor / company name',         namePlaceholder: 'e.g. Shree Chemicals Pvt Ltd', identifierLabel: 'GSTIN / PAN / vendor code',      identifierPlaceholder: 'e.g. 20XXXXX1234Z1' },
  other:   { nameLabel: 'Name / description',            namePlaceholder: 'Enter identifier',             identifierLabel: 'Reference ID',                   identifierPlaceholder: 'Optional reference' },
};

const BLANK_FORM = {
  type: 'person' as BlacklistEntry['type'],
  name: '',
  identifier: '',
  reason: '',
  severity: 'high' as BlacklistEntry['severity'],
  notes: '',
  reference_no: '',
};

const BLANK_RESOLVE = { reason: '' };

// ── Page ──────────────────────────────────────────────────────────────────────

export function Blacklist() {
  const { t } = useTranslation();
  const { activeProfile } = useRoleContext();
  const toast = useToast();
  const notifyMentions = useMentionNotifier();

  const { refresh: refreshBlacklist } = useBlacklist();
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingReport, setGeneratingReport] = useState(false);
  const today = istToday();

  const [showPanel, setShowPanel] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [saved, setSaved] = useState(false);

  const [showResolvePanel, setShowResolvePanel] = useState(false);
  const [resolvingEntry, setResolvingEntry] = useState<BlacklistEntry | null>(null);
  const [resolveForm, setResolveForm] = useState({ ...BLANK_RESOLVE });
  const [resolveSaved, setResolveSaved] = useState(false);

  const [showDetailPanel, setShowDetailPanel] = useState(false);
  const [detailEntry, setDetailEntry] = useState<BlacklistEntry | null>(null);

  const [filterType, setFilterType] = useState('all');
  const [filterSev, setFilterSev] = useState('all');
  const [filterStatus, setFilterStatus] = useState('active');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('blacklist').select('*').order('created_at', { ascending: false }).returns<BlacklistEntry[]>();
    setEntries(data || []);
    setLoading(false);
    // Keep the app-wide BlacklistContext (used by screening guards + the access
    // gate) in sync, so a new entry takes effect without a page reload.
    refreshBlacklist();
  }, [refreshBlacklist]);

  useEffect(() => { load(); }, [load]);

  // ── Computed ────────────────────────────────────────────────────────────────
  const active = entries.filter(e => e.is_active);
  const persons  = active.filter(e => e.type === 'person').length;
  const vehicles = active.filter(e => e.type === 'vehicle').length;
  const others   = active.filter(e => e.type === 'vendor' || e.type === 'other').length;

  const filtered = entries.filter(e => {
    if (filterType !== 'all' && e.type !== filterType) return false;
    if (filterSev  !== 'all' && e.severity !== filterSev) return false;
    if (filterStatus === 'active'   && !e.is_active) return false;
    if (filterStatus === 'resolved' && e.is_active)  return false;
    if (search) {
      const q = search.toLowerCase();
      return e.name.toLowerCase().includes(q) ||
             (e.identifier || '').toLowerCase().includes(q) ||
             e.reason.toLowerCase().includes(q) ||
             (e.added_by || '').toLowerCase().includes(q);
    }
    return true;
  });

  const fSort = useSortable(filtered, {
    type:     e => TYPE_CFG[e.type]?.label ?? e.type,
    name:     e => e.name,
    reason:   e => e.reason,
    severity: e => SEV_RANK[e.severity] ?? -1,
    addedBy:  e => e.added_by,
    date:     e => new Date(e.created_at),
    status:   e => (e.is_active ? 1 : 0),
  }, { key: 'date', dir: 'desc' });
  // Paged — this list grows with use; page 1 again when the rows change.
  const { pageRows: pagedEntries, controls: entryPager } = usePagination(fSort.sorted, { resetKey: `${filterType}|${filterSev}|${filterStatus}|${search}|${fSort.sort.key}|${fSort.sort.dir}` });

  // ── Save new entry ──────────────────────────────────────────────────────────
  // A vehicle entry must carry an Indian registration number (stored compact).
  const vehicleBad = form.type === 'vehicle' && !!form.name.trim() && !isValidVehicleNo(form.name);
  async function handleSave() {
    if (!form.name.trim() || !form.reason.trim() || vehicleBad) return;
    const savedName = form.type === 'vehicle' ? compactVehicleNo(form.name) : form.name.trim();
    const payload = {
      type: form.type,
      name: savedName,
      identifier: form.identifier.trim() || null,
      reason: form.reason.trim(),
      severity: form.severity,
      notes: form.notes.trim() || null,
      reference_no: form.reference_no.trim() || null,
      added_by: activeProfile.name,
      added_by_role: activeProfile.roleLabel,
      is_active: true,
    };
    const { data: created, error } = await insertRows('blacklist', payload).select('id').single();
    if (error) { toast.error(t('blacklist.toastFailed', { msg: error.message })); return; }

    // Audit: entity added to the blacklist.
    await logBlacklistEvent({
      blacklist_id: (created as { id: string } | null)?.id ?? null,
      event_type: 'added',
      entity_name: savedName,
      entity_type: form.type,
      workflow: 'Blacklist', source: 'lifecycle',
      actor_id: activeProfile.id, actor_name: activeProfile.name, actor_role: activeProfile.roleLabel,
      details: { severity: form.severity, reason: form.reason.trim(), identifier: form.identifier.trim() || null, reference_no: form.reference_no.trim() || null },
    });

    // Notify admin + unit_head — colour reflects the blacklist severity.
    insertRows('notifications', {
      target_roles: ['admin', 'unit_head'],
      title: `New blacklist entry added`,
      body: `${TYPE_CFG[form.type].label} "${savedName}" blacklisted (${form.severity}) by ${activeProfile.name}`,
      type: SEVERITY_NOTIF_TYPE[form.severity] ?? 'urgent',
      route: '/dashboard/blacklist',
      actor_name: activeProfile.name,
      actor_role: activeProfile.roleLabel,
      read_by: [],
    }).then(() => {}, () => {});

    await notifyMentions(`${form.reason} ${form.notes}`, {
      entityLabel: `Blacklist · ${savedName}`, route: '/dashboard/blacklist',
    });

    setSaved(true);
    await load();
    setTimeout(() => {
      setShowPanel(false);
      setSaved(false);
      setForm({ ...BLANK_FORM });
    }, 1400);
  }

  // ── Resolve (remove from blacklist) ────────────────────────────────────────
  async function handleResolve() {
    if (!resolvingEntry || !resolveForm.reason.trim()) return;
    const { error } = await updateRows('blacklist', {
        is_active: false,
        resolved_at: new Date().toISOString(),
        resolved_by: activeProfile.name,
        resolved_reason: resolveForm.reason.trim(),
      })
      .eq('id', resolvingEntry.id);
    if (error) { toast.error(t('blacklist.toastFailed', { msg: error.message })); return; }

    await logBlacklistEvent({
      blacklist_id: resolvingEntry.id,
      event_type: 'resolved',
      entity_name: resolvingEntry.name,
      entity_type: resolvingEntry.type,
      workflow: 'Blacklist', source: 'lifecycle',
      actor_id: activeProfile.id, actor_name: activeProfile.name, actor_role: activeProfile.roleLabel,
      details: { resolved_reason: resolveForm.reason.trim() },
    });

    insertRows('notifications', {
      target_roles: ['admin', 'unit_head'],
      title: `Blacklist entry resolved`,
      body: `"${resolvingEntry.name}" removed from blacklist by ${activeProfile.name}`,
      type: 'info',
      route: '/dashboard/blacklist',
      actor_name: activeProfile.name,
      actor_role: activeProfile.roleLabel,
      read_by: [],
    }).then(() => {}, () => {});

    await notifyMentions(resolveForm.reason, {
      entityLabel: `Blacklist · ${resolvingEntry.name}`, route: '/dashboard/blacklist',
    });

    setResolveSaved(true);
    await load();
    setTimeout(() => {
      setShowResolvePanel(false);
      setResolveSaved(false);
      setResolvingEntry(null);
      setResolveForm({ ...BLANK_RESOLVE });
    }, 1400);
  }

  // ── Escalate / change severity ──────────────────────────────────────────────
  async function changeSeverity(entry: BlacklistEntry, newSeverity: BlacklistEntry['severity']) {
    if (newSeverity === entry.severity) return;
    const { error } = await updateRows('blacklist', { severity: newSeverity }).eq('id', entry.id);
    if (error) { toast.error(t('blacklist.toastFailed', { msg: error.message })); return; }
    const escalated = SEV_RANK[newSeverity] > SEV_RANK[entry.severity];
    await logBlacklistEvent({
      blacklist_id: entry.id, event_type: 'escalated', entity_name: entry.name, entity_type: entry.type,
      workflow: 'Blacklist', source: 'lifecycle',
      actor_id: activeProfile.id, actor_name: activeProfile.name, actor_role: activeProfile.roleLabel,
      details: { from: entry.severity, to: newSeverity },
    });
    insertRows('notifications', {
      target_roles: ['admin', 'unit_head'],
      title: `Blacklist severity ${escalated ? 'escalated' : 'lowered'}: ${entry.name}`,
      body: `${entry.name} severity ${entry.severity} → ${newSeverity} by ${activeProfile.name}. ${newSeverity === 'low' ? 'Now monitor-only (access allowed).' : 'Dashboard access is now restricted.'}`,
      type: SEVERITY_NOTIF_TYPE[newSeverity] ?? 'urgent',
      route: '/dashboard/blacklist',
      actor_name: activeProfile.name, actor_role: activeProfile.roleLabel, read_by: [],
    }).then(() => {}, () => {});
    setDetailEntry({ ...entry, severity: newSeverity });
    await load();
    toast.success(
      newSeverity === 'low'
        ? t('blacklist.toastSeverityMonitor', { sev: newSeverity })
        : t('blacklist.toastSeverityRestricted', { sev: newSeverity })
    );
  }

  // ── Delete = resolve & close (kept in the audit trail) ──────────────────────
  async function deleteEntry(entry: BlacklistEntry) {
    if (!window.confirm(t('blacklist.confirmDelete', { name: entry.name }))) return;
    const { error } = await updateRows('blacklist', {
      is_active: false,
      resolved_at: new Date().toISOString(),
      resolved_by: activeProfile.name,
      resolved_reason: 'Deleted (resolved & closed) by admin',
    }).eq('id', entry.id);
    if (error) { toast.error(t('blacklist.toastDeleteFailed', { msg: error.message })); return; }
    await logBlacklistEvent({
      blacklist_id: entry.id, event_type: 'resolved', entity_name: entry.name, entity_type: entry.type,
      workflow: 'Blacklist', source: 'lifecycle',
      actor_id: activeProfile.id, actor_name: activeProfile.name, actor_role: activeProfile.roleLabel,
      details: { via: 'delete' },
    });
    if (detailEntry?.id === entry.id) { setShowDetailPanel(false); setDetailEntry(null); }
    await load();
    toast.success(t('blacklist.toastDeleted'));
  }

  // ── Re-blacklist ────────────────────────────────────────────────────────────
  async function reBlacklist(entry: BlacklistEntry) {
    await updateRows('blacklist', { is_active: true, resolved_at: null, resolved_by: null, resolved_reason: null })
      .eq('id', entry.id);
    await logBlacklistEvent({
      blacklist_id: entry.id,
      event_type: 're_added',
      entity_name: entry.name,
      entity_type: entry.type,
      workflow: 'Blacklist', source: 'lifecycle',
      actor_id: activeProfile.id, actor_name: activeProfile.name, actor_role: activeProfile.roleLabel,
    });
    await load();
  }

  // ── Comprehensive audit report (CSV ×2: registry + event trail) ─────────────
  async function generateAuditReport() {
    if (generatingReport) return;
    setGeneratingReport(true);
    try {
      const { data: events } = await supabase.from('blacklist_events').select('*')
        .order('created_at', { ascending: true }).returns<BlacklistEventRow[]>();
      const evts = events ?? [];
      const hitsBy = new Map<string, number>();
      evts.forEach((e) => {
        if (e.event_type === 'match_detected' && e.blacklist_id) {
          hitsBy.set(e.blacklist_id, (hitsBy.get(e.blacklist_id) ?? 0) + 1);
        }
      });

      const entryRows = entries.map((e) => ({
        id: e.id,
        type: TYPE_CFG[e.type]?.label ?? e.type,
        name: e.name,
        identifier: e.identifier ?? '',
        severity: e.severity,
        status: e.is_active ? 'Active' : 'Resolved',
        reason: e.reason,
        notes: e.notes ?? '',
        reference_no: e.reference_no ?? '',
        added_by: e.added_by,
        added_by_role: e.added_by_role ?? '',
        added_at: fmtDT(e.created_at),
        resolved_by: e.resolved_by ?? '',
        resolved_at: fmtDT(e.resolved_at),
        resolved_reason: e.resolved_reason ?? '',
        hits: hitsBy.get(e.id) ?? 0,
      }));

      const preamble: (string | number)[][] = [
        ['Suntek — Blacklist Audit Report'],
        ['Generated by', `${activeProfile.name} (${activeProfile.roleLabel})`],
        ['Generated at', formatDateTime(new Date())],
        ['Active entries', entries.filter((e) => e.is_active).length],
        ['Total entries', entries.length],
        ['Match detections logged', evts.filter((e) => e.event_type === 'match_detected').length],
      ];

      exportToCsv(`blacklist-registry-${today}`, ENTRY_COLUMNS, entryRows, preamble);

      if (evts.length) {
        const eventRows = evts.map((e) => ({
          blacklist_id: e.blacklist_id ?? '',
          entity_name: e.entity_name,
          entity_type: e.entity_type ?? '',
          event_type: e.event_type,
          matched_value: e.matched_value ?? '',
          sim: e.similarity != null ? Math.round(Number(e.similarity) * 100) : '',
          workflow: e.workflow ?? '',
          source: e.source ?? '',
          field: (e.details as { field?: string } | null)?.field ?? '',
          actor_name: e.actor_name ?? '',
          actor_role: e.actor_role ?? '',
          image_url: e.image_url ?? '',
          at: fmtDT(e.created_at),
        }));
        exportToCsv(`blacklist-audit-trail-${today}`, EVENT_COLUMNS, eventRows, preamble);
      }

      toast.success(t('blacklist.toastReportReady', { entries: entries.length, events: evts.length }));
    } catch (err) {
      toast.error(t('blacklist.toastReportFailed', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setGeneratingReport(false);
    }
  }

  const typeLabels = TYPE_LABELS[form.type];

  return (
    <>
      {/* ── KPI row — same format as the Overview "Today's Work" cards ──── */}
      <div className="grid grid-cols-12 gap-5 mb-5">
        {[
          { icon: <ShieldBan />,   label: t('blacklist.kpiActive'),      value: active.length, sub: t('blacklist.kpiActiveSub', { count: entries.filter(e => !e.is_active).length }) },
          { icon: <UserX />,       label: t('blacklist.kpiPersons'),     value: persons,       sub: t('blacklist.kpiPersonsSub') },
          { icon: <Car />,         label: t('blacklist.kpiVehicles'),    value: vehicles,      sub: t('blacklist.kpiVehiclesSub') },
          { icon: <Building2 />,   label: t('blacklist.kpiVendorsOther'), value: others,       sub: t('blacklist.kpiVendorsOtherSub') },
        ].map((k, i) => (
          <WorkCard
            key={i}
            className="col-span-12 lg:col-span-3"
            icon={k.icon}
            label={k.label}
            value={k.value}
            caption={k.sub}
          />
        ))}
      </div>

      {/* ── Table card ───────────────────────────────────────────────────── */}
      <div className="card2 p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <div className="text-base font-bold font-heading">{t('blacklist.registryTitle')}</div>
            <div className="text-xs text-slate-500">{t('blacklist.registrySubtitle')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="chip"
              onClick={generateAuditReport}
              disabled={generatingReport}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              📄 {generatingReport ? t('blacklist.generating') : t('blacklist.auditReport')}
            </button>
            <button
              className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm"
              style={{ background: '#DC2626' }}
              onClick={() => { setForm({ ...BLANK_FORM }); setSaved(false); setShowPanel(true); }}
            >
              + {t('blacklist.addBtn')}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4 flex-wrap">
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('blacklist.searchPlaceholder')}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, outline: 'none', fontFamily: 'inherit', minWidth: 220 }}
          />
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="all">{t('blacklist.filterAllTypes')}</option>
            <option value="person">{t('blacklist.typePerson')}</option>
            <option value="vehicle">{t('blacklist.typeVehicle')}</option>
            <option value="vendor">{t('blacklist.typeVendor')}</option>
            <option value="other">{t('blacklist.typeOther')}</option>
          </select>
          <select value={filterSev} onChange={e => setFilterSev(e.target.value)}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="all">{t('blacklist.filterAllSeverity')}</option>
            <option value="critical">{t('blacklist.sevCritical')}</option>
            <option value="high">{t('blacklist.sevHigh')}</option>
            <option value="medium">{t('blacklist.sevMedium')}</option>
            <option value="low">{t('blacklist.sevLow')}</option>
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            style={{ padding: '8px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0', fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="active">{t('blacklist.statusActive')}</option>
            <option value="resolved">{t('blacklist.statusResolved')}</option>
            <option value="all">{t('blacklist.statusAll')}</option>
          </select>
        </div>

        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <Th sortKey="type" s={fSort}>{t('blacklist.colType')}</Th>
                <Th sortKey="name" s={fSort}>{t('blacklist.colNameId')}</Th>
                <Th sortKey="reason" s={fSort}>{t('blacklist.colReason')}</Th>
                <Th sortKey="severity" s={fSort} firstDir="desc">{t('blacklist.colSeverity')}</Th>
                <Th sortKey="addedBy" s={fSort}>{t('blacklist.colAddedBy')}</Th>
                <Th sortKey="date" s={fSort} firstDir="desc">{t('blacklist.colDate')}</Th>
                <Th sortKey="status" s={fSort} firstDir="desc">{t('blacklist.colStatus')}</Th>
                <th>{t('blacklist.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="text-center text-slate-400 py-6 text-sm">{t('blacklist.loading')}</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="text-center text-slate-400 py-6 text-sm">
                  {filterStatus === 'active' && active.length === 0
                    ? t('blacklist.emptyAllClear')
                    : t('blacklist.emptyNoMatch')}
                </td></tr>
              )}
              {pagedEntries.map(e => {
                const tc = TYPE_CFG[e.type] || TYPE_CFG.other;
                const sc = SEV_CFG[e.severity] || SEV_CFG.high;
                return (
                  <tr key={e.id} style={{ opacity: e.is_active ? 1 : 0.55 }}>
                    <td>
                      <span className="badge" style={{ background: tc.bg, color: tc.color, fontSize: 11 }}>
                        {tc.icon} {tc.label}
                      </span>
                    </td>
                    <td>
                      <div className="font-semibold text-slate-800">{e.name}</div>
                      {e.identifier && <div className="text-[11px] text-slate-400">{e.identifier}</div>}
                    </td>
                    <td>
                      <div className="text-sm text-slate-700 max-w-[220px] truncate" title={e.reason}>{e.reason}</div>
                      {e.reference_no && <div className="text-[11px] text-slate-400">{t('blacklist.refPrefix')} {e.reference_no}</div>}
                    </td>
                    <td>
                      <span className="badge" style={{ background: sc.bg, color: sc.color, fontWeight: 700, fontSize: 11 }}>
                        {sc.label}
                      </span>
                    </td>
                    <td>
                      <div className="text-sm text-slate-700">{e.added_by}</div>
                      {e.added_by_role && <div className="text-[11px] text-slate-400">{e.added_by_role}</div>}
                    </td>
                    <td className="text-slate-500 text-xs">{formatDate(e.created_at)}</td>
                    <td>
                      {e.is_active ? (
                        <span className="badge" style={{ background: '#FEF2F2', color: '#DC2626', fontWeight: 700 }}>{t('blacklist.statusActive')}</span>
                      ) : (
                        <div>
                          <span className="badge" style={{ background: '#F0FDF4', color: '#16A34A', fontWeight: 700 }}>{t('blacklist.statusResolved')}</span>
                          <div className="text-[10px] text-slate-400 mt-0.5">{formatDate(e.resolved_at)}</div>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setDetailEntry(e); setShowDetailPanel(true); }}
                          style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, color: '#475569' }}
                        >{t('blacklist.actionView')}</button>
                        {e.is_active ? (
                          <>
                            <button
                              onClick={() => { setResolvingEntry(e); setResolveForm({ ...BLANK_RESOLVE }); setResolveSaved(false); setShowResolvePanel(true); }}
                              style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #BBF7D0', background: '#F0FDF4', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, color: '#16A34A' }}
                            >{t('blacklist.actionResolve')}</button>
                            <button
                              onClick={() => deleteEntry(e)}
                              title={t('blacklist.actionDeleteTitle')}
                              style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #FECACA', background: '#FEF2F2', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, color: '#DC2626' }}
                            >{t('blacklist.actionDelete')}</button>
                          </>
                        ) : (
                          <button
                            onClick={() => reBlacklist(e)}
                            style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #FECACA', background: '#FEF2F2', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, color: '#DC2626' }}
                          >{t('blacklist.actionReadd')}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {fSort.sorted.length > 0 && <TablePaginationV2 controls={entryPager} label={t('blacklist.nounEntries', 'entries')} />}
      </div>

      {/* ── Add panel ────────────────────────────────────────────────────── */}
      <SlidePanel
        open={showPanel}
        onClose={() => { setShowPanel(false); setSaved(false); }}
        title={t('blacklist.addPanelTitle')}
        subtitle={t('blacklist.addPanelSubtitle')}
      >
        <PanelField label={t('blacklist.fieldType')}>
          <PanelSelect value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as BlacklistEntry['type'] }))}>
            <option value="person">{t('blacklist.optPerson')}</option>
            <option value="vehicle">{t('blacklist.optVehicle')}</option>
            <option value="vendor">{t('blacklist.optVendor')}</option>
            <option value="other">{t('blacklist.optOther')}</option>
          </PanelSelect>
        </PanelField>

        <div style={{ marginBottom: 16, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: '10px 14px', fontSize: 11, color: '#DC2626' }}>
          <strong>{t('blacklist.noteLabel')}</strong> {t('blacklist.addNote')}
        </div>

        <PanelRow>
          <PanelField label={`${t(`blacklist.nameLabel_${form.type}`)} *`}>
            <PanelInput value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={typeLabels.namePlaceholder} />
            {vehicleBad && <span style={{ fontSize: 11, color: '#DC2626' }}>{t('common.vehicleInvalid', 'Use an Indian vehicle number, like UP13ET7451, DL1CAB1234 or 22BH1234AB.')}</span>}
          </PanelField>
          <PanelField label={t(`blacklist.identifierLabel_${form.type}`)}>
            <PanelInput value={form.identifier} onChange={e => setForm(f => ({ ...f, identifier: e.target.value }))} placeholder={typeLabels.identifierPlaceholder} />
          </PanelField>
        </PanelRow>

        <PanelField label={t('blacklist.fieldReason')}>
          <PanelTextarea
            value={form.reason}
            onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
            placeholder={t('blacklist.reasonPlaceholder')}
          />
        </PanelField>

        <PanelField label={t('blacklist.fieldSeverity')}>
          <PanelSelect value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value as BlacklistEntry['severity'] }))}>
            <option value="critical">{t('blacklist.sevOptCritical')}</option>
            <option value="high">{t('blacklist.sevOptHigh')}</option>
            <option value="medium">{t('blacklist.sevOptMedium')}</option>
            <option value="low">{t('blacklist.sevOptLow')}</option>
          </PanelSelect>
        </PanelField>

        {/* Severity description card */}
        <div style={{ marginBottom: 16, background: SEV_CFG[form.severity].bg, border: `1px solid ${SEV_CFG[form.severity].color}30`, borderRadius: 12, padding: '8px 14px', fontSize: 11, color: SEV_CFG[form.severity].color, fontWeight: 600 }}>
          {SEV_DESCRIPTIONS[form.severity]}
        </div>

        <PanelRow>
          <PanelField label={t('blacklist.fieldReferenceNo')}>
            <PanelInput value={form.reference_no} onChange={e => setForm(f => ({ ...f, reference_no: e.target.value }))} placeholder={t('blacklist.referenceNoPlaceholder')} />
          </PanelField>
        </PanelRow>

        <PanelField label={t('blacklist.fieldInternalNotes')}>
          <PanelTextarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder={t('blacklist.internalNotesPlaceholder')} />
        </PanelField>

        <PanelDivider />
        <PanelFooter
          saved={saved}
          onCancel={() => { setShowPanel(false); }}
          onSave={handleSave}
          saveLabel={t('blacklist.addBtnLabel')}
          successLabel={t('blacklist.entryAdded')}
          successSub={t('blacklist.entryAddedSub')}
          disabled={!form.name.trim() || !form.reason.trim() || vehicleBad}
          requiredHint={t('blacklist.requiredNameReason')}
        />
      </SlidePanel>

      {/* ── Resolve panel ────────────────────────────────────────────────── */}
      <SlidePanel
        open={showResolvePanel}
        onClose={() => { setShowResolvePanel(false); setResolveSaved(false); setResolvingEntry(null); }}
        title={t('blacklist.resolvePanelTitle')}
        subtitle={t('blacklist.resolvePanelSubtitle')}
      >
        {resolvingEntry && (
          <>
            <div style={{ marginBottom: 16, padding: '14px 16px', background: '#FEF2F2', borderRadius: 12, border: '1px solid #FECACA' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#DC2626' }}>
                {TYPE_CFG[resolvingEntry.type].icon} {resolvingEntry.name}
              </div>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{resolvingEntry.reason}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>
                {t('blacklist.addedByLine', { name: resolvingEntry.added_by, date: formatDate(resolvingEntry.created_at) })}
              </div>
            </div>

            <PanelField label={t('blacklist.fieldResolveReason')}>
              <PanelTextarea
                value={resolveForm.reason}
                onChange={e => setResolveForm(f => ({ ...f, reason: e.target.value }))}
                placeholder={t('blacklist.resolveReasonPlaceholder')}
              />
            </PanelField>

            <div style={{ marginBottom: 16, padding: '10px 14px', background: '#FFFBEB', borderRadius: 12, border: '1px solid #FDE68A', fontSize: 11, color: '#92400E' }}>
              <strong>{t('blacklist.resolveWarnBold')}</strong> {t('blacklist.resolveWarnRest')}
            </div>

            <PanelDivider />
            <PanelFooter
              saved={resolveSaved}
              onCancel={() => { setShowResolvePanel(false); setResolvingEntry(null); }}
              onSave={handleResolve}
              saveLabel={t('blacklist.confirmResolve')}
              successLabel={t('blacklist.entryResolved')}
              successSub={t('blacklist.entryResolvedSub')}
              disabled={!resolveForm.reason.trim()}
              requiredHint={t('blacklist.requiredResolveReason')}
            />
          </>
        )}
      </SlidePanel>

      {/* ── Detail panel ─────────────────────────────────────────────────── */}
      <SlidePanel
        open={showDetailPanel}
        onClose={() => { setShowDetailPanel(false); setDetailEntry(null); }}
        title={t('blacklist.detailPanelTitle')}
        subtitle={t('blacklist.detailPanelSubtitle')}
      >
        {detailEntry && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
              <span className="badge" style={{ background: TYPE_CFG[detailEntry.type].bg, color: TYPE_CFG[detailEntry.type].color }}>
                {TYPE_CFG[detailEntry.type].icon} {TYPE_CFG[detailEntry.type].label}
              </span>
              <span className="badge" style={{ background: SEV_CFG[detailEntry.severity].bg, color: SEV_CFG[detailEntry.severity].color, fontWeight: 700 }}>
                {SEV_CFG[detailEntry.severity].label}
              </span>
              {detailEntry.is_active
                ? <span className="badge" style={{ background: '#FEF2F2', color: '#DC2626', fontWeight: 700 }}>{t('blacklist.statusActive')}</span>
                : <span className="badge" style={{ background: '#F0FDF4', color: '#16A34A', fontWeight: 700 }}>{t('blacklist.statusResolved')}</span>}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('blacklist.detailName')}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{detailEntry.name}</div>
              {detailEntry.identifier && <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{detailEntry.identifier}</div>}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('blacklist.detailReason')}</div>
              <div style={{ fontSize: 13, color: '#334155', lineHeight: '1.6' }}>{detailEntry.reason}</div>
            </div>

            {detailEntry.notes && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('blacklist.detailNotes')}</div>
                <div style={{ fontSize: 13, color: '#334155', lineHeight: '1.6' }}>{detailEntry.notes}</div>
              </div>
            )}

            {detailEntry.reference_no && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('blacklist.detailReference')}</div>
                <div style={{ fontSize: 13, color: '#334155' }}>{detailEntry.reference_no}</div>
              </div>
            )}

            <div style={{ padding: '12px 14px', background: '#F8FAFC', borderRadius: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748B' }}>
                {t('blacklist.addedByLabel')} <strong>{detailEntry.added_by}</strong>{detailEntry.added_by_role ? ` · ${detailEntry.added_by_role}` : ''}
              </div>
              <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 2 }}>{t('blacklist.onLabel')} {formatDate(detailEntry.created_at)}</div>
            </div>

            {/* Notes — tagged people can add live notes about this entity */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{t('blacklist.detailNotes')}</div>
              <NotesButton
                entityType="blacklist"
                entityId={detailEntry.id}
                entityLabel={`Blacklist · ${detailEntry.name}`}
                route="/dashboard/blacklist"
              />
            </div>

            {/* Admin: escalate / change severity */}
            {detailEntry.is_active && (
              <div style={{ padding: '14px', border: '1px solid #E2E8F0', borderRadius: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  {t('blacklist.escalateTitle')}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {SEV_ORDER.map((sev) => (
                    <button
                      key={sev}
                      type="button"
                      onClick={() => changeSeverity(detailEntry, sev)}
                      style={{
                        flex: 1, minWidth: 66, padding: '8px 6px', borderRadius: 10, cursor: 'pointer',
                        fontWeight: 700, fontSize: 12, fontFamily: 'inherit',
                        border: `2px solid ${detailEntry.severity === sev ? SEV_CFG[sev].color : '#E2E8F0'}`,
                        background: detailEntry.severity === sev ? SEV_CFG[sev].bg : '#fff',
                        color: detailEntry.severity === sev ? SEV_CFG[sev].color : '#64748B',
                      }}
                    >
                      {SEV_CFG[sev].label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 8, lineHeight: 1.5 }}>
                  <strong>{t('blacklist.sevLow')}</strong> {t('blacklist.escLowText')} · <strong>{t('blacklist.escMidLabel')}</strong> {t('blacklist.escMidText')} · <strong>{t('blacklist.escHighLabel')}</strong> {t('blacklist.escHighText')}
                </div>
              </div>
            )}

            {detailEntry.is_active && (
              <button
                type="button"
                onClick={() => deleteEntry(detailEntry)}
                style={{ width: '100%', padding: '11px 0', borderRadius: 12, border: '1px solid #FECACA', background: '#FEF2F2', fontSize: 13, fontWeight: 700, color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 }}
              >
                {t('blacklist.deleteEntryBtn')}
              </button>
            )}

            {!detailEntry.is_active && (
              <div style={{ padding: '12px 14px', background: '#F0FDF4', borderRadius: 12, border: '1px solid #BBF7D0' }}>
                <div style={{ fontSize: 12, color: '#16A34A', fontWeight: 600 }}>{t('blacklist.resolvedByLine', { name: detailEntry.resolved_by, date: formatDate(detailEntry.resolved_at) })}</div>
                {detailEntry.resolved_reason && <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>{detailEntry.resolved_reason}</div>}
              </div>
            )}
          </>
        )}
      </SlidePanel>
    </>
  );
}
