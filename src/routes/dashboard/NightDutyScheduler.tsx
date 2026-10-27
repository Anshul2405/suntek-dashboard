import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Download, Building2, Activity } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/ui/toast';
import { useRoleContext } from '../../contexts/RoleContext';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../lib/access/pickerPlants';
import { StatCard, SectionCard, ButtonV2, FilterBar, FilterSelect, StatusPill, TablePaginationV2 } from '../../components/v2';
import { usePagination } from '../../components/ui/usePagination';
import { exportToCsv } from '../../lib/utils/exportCsv';
import { formatDate, formatDateTime, formatTime, istToday } from '../../lib/utils/formatting';

/**
 * Night-duty scheduler — shown to users with the `allocate_night_duty` capability
 * (e.g. a unit head). They pick their subordinates (technicians/people in their
 * plant, tier below them), pick dates on a calendar (or a repeat pattern for
 * rotation), and schedule night duty. Each date × person = one night_duty row.
 *
 * v2: the scheduling form is an INLINE right-side wizard panel (4 numbered
 * steps — date → employees → repeat → confirm) instead of a modal. The final
 * step calls the same night_duty upsert as before.
 */

type Acct = { id: string; name: string; role_id: string | null; plant_id: string | null; is_active: boolean };
type Duty = {
  id: string; technician_id: string; duty_date: string; status: string;
  checked_in_at: string | null; plant_id: string | null;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => istToday(); // IST day, not the browser's

// CSV export keeps the original English labels by design.
const STATUS_CFG: Record<string, { label: string; bg: string; color: string }> = {
  scheduled:  { label: 'Scheduled',  bg: '#EFF6FF', color: '#2563EB' },
  checked_in: { label: 'Checked in', bg: '#DCFCE7', color: '#16A34A' },
  completed:  { label: 'Completed',  bg: '#F1F5F9', color: '#64748B' },
  missed:     { label: 'Missed',     bg: '#FEF2F2', color: '#DC2626' },
};

export function NightDutyScheduler() {
  const { t } = useTranslation();
  const toast = useToast();

  // UI status labels (translated) — CSV export keeps English via STATUS_CFG.
  const statusLabels: Record<string, string> = {
    scheduled:  t('nightBoard.statusScheduled', 'Scheduled'),
    checked_in: t('nightBoard.statusCheckedIn', 'Checked in'),
    completed:  t('nightBoard.statusCompleted', 'Completed'),
    missed:     t('nightBoard.statusMissed', 'Missed'),
  };

  const wizardSteps = [
    { n: 1, title: t('nightBoard.step1Title', 'Choose Date'),                sub: t('nightBoard.step1Sub', 'Select the dates for night duty') },
    { n: 2, title: t('nightBoard.step2Title', 'Select Employees'),           sub: t('nightBoard.step2Sub', 'Choose available employees') },
    { n: 3, title: t('nightBoard.step3Title', 'Repeat Schedule (Optional)'), sub: t('nightBoard.step3Sub', 'Set recurrence and end date') },
    { n: 4, title: t('nightBoard.step4Title', 'Review & Confirm'),           sub: t('nightBoard.step4Sub', 'Review and assign duty') },
  ];

  const weekdayLabels = [
    t('nightBoard.weekdaySun', 'Sun'), t('nightBoard.weekdayMon', 'Mon'), t('nightBoard.weekdayTue', 'Tue'),
    t('nightBoard.weekdayWed', 'Wed'), t('nightBoard.weekdayThu', 'Thu'), t('nightBoard.weekdayFri', 'Fri'),
    t('nightBoard.weekdaySat', 'Sat'),
  ];
  const { activeProfile, roles } = useRoleContext();
  const { plantIds, isGlobal, plants, allowedPlants, ready: scopeReady } = usePlantScope();
  // Pickers offer only the plants this user may see; `plants` stays for labels.
  const pickerPlants = useMemo(() => plantsForPicker(allowedPlants, scopeReady), [allowedPlants, scopeReady]);

  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Record<string, number>>({});
  const [accts, setAccts] = useState<Acct[]>([]);
  const [duties, setDuties] = useState<Duty[]>([]);
  const [loading, setLoading] = useState(true);

  // Scheduling form
  const [monthCursor, setMonthCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [selectedTechIds, setSelectedTechIds] = useState<string[]>([]);
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [repeatUntil, setRepeatUntil] = useState('');
  // Duty plant: 'auto' = each person's own plant; or force a specific plant so a
  // multi-plant technician can hold separate duties at each plant per night.
  const [dutyPlant, setDutyPlant] = useState<string>('auto');
  const [saving, setSaving] = useState(false);
  const [techSearch, setTechSearch] = useState('');
  // The scheduling form lives in an inline right-side wizard panel.
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  // Below lg the wizard renders after the whole schedule table — scroll it into view on open.
  const wizardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (schedulerOpen && window.innerWidth < 1024) wizardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [schedulerOpen]);
  const [step, setStep] = useState(1);

  // Schedule-table filters (per mockup: search · plant · date range · status · reset)
  const [schedQ, setSchedQ] = useState('');
  const [schedPlant, setSchedPlant] = useState('all');
  const [schedStatus, setSchedStatus] = useState('all');
  const [schedFrom, setSchedFrom] = useState('');
  const [schedTo, setSchedTo] = useState('');
  const resetSchedFilters = () => { setSchedQ(''); setSchedPlant('all'); setSchedStatus('all'); setSchedFrom(''); setSchedTo(''); };

  const roleTier = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of roles) m[r.id] = r.level;
    return m;
  }, [roles]);
  const roleLabel = useMemo(() => Object.fromEntries(roles.map(r => [r.id, r.label])), [roles]);

  const myRank = tiers[activeProfile.role] ?? Number.MAX_SAFE_INTEGER;

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    let acctId: string | null = null;
    if (user?.id) {
      const { data: me } = await supabase.from('user_accounts').select('id').eq('auth_user_id', user.id).limit(1).returns<{ id: string }[]>();
      acctId = me?.[0]?.id ?? null;
    }
    const [{ data: tierRows }, { data: acctRows }, { data: dutyRows }] = await Promise.all([
      supabase.from('tiers').select('id, rank').returns<{ id: string; rank: number }[]>(),
      supabase.from('user_accounts').select('id, name, role_id, plant_id, is_active').returns<Acct[]>(),
      supabase.from('night_duty').select('id, technician_id, duty_date, status, checked_in_at, plant_id').gte('duty_date', todayIso()).order('duty_date').returns<Duty[]>(),
    ]);
    setMyAccountId(acctId);
    setTiers(Object.fromEntries((tierRows ?? []).map(t => [t.id, t.rank])));
    setAccts(acctRows ?? []);
    setDuties(dutyRows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Subordinates = active users in my plant(s), tier BELOW me, not me.
  const subordinates = useMemo(() => accts.filter(a => {
    if (!a.is_active || a.id === myAccountId) return false;
    if (!isGlobal && !(a.plant_id && plantIds.includes(a.plant_id))) return false;
    const rank = a.role_id ? (tiers[roleTier[a.role_id]] ?? 0) : 0;
    return rank < myRank;
  }), [accts, myAccountId, isGlobal, plantIds, tiers, roleTier, myRank]);

  const acctName = useMemo(() => Object.fromEntries(accts.map(a => [a.id, a.name])), [accts]);
  const plantName = useMemo(() => Object.fromEntries(plants.map(p => [p.id, p.name])), [plants]);

  // Search subordinates by name / role / level.
  const filteredSubs = useMemo(() => {
    const q = techSearch.trim().toLowerCase();
    if (!q) return subordinates;
    return subordinates.filter(s => {
      const rl = (s.role_id ? roleLabel[s.role_id] : '') || '';
      const lv = (s.role_id ? roleTier[s.role_id] : '') || '';
      return s.name.toLowerCase().includes(q) || rl.toLowerCase().includes(q) || lv.toLowerCase().includes(q);
    });
  }, [subordinates, techSearch, roleLabel, roleTier]);

  // Night-duty report stats (from the loaded upcoming/checked-in duties).
  const report = useMemo(() => {
    const td = todayIso(); // NOTE: not `t` — would shadow the i18n translate fn
    return {
      tonight: duties.filter(d => d.duty_date === td).length,
      scheduled: duties.filter(d => d.status === 'scheduled').length,
      checkedIn: duties.filter(d => d.status === 'checked_in').length,
      missed: duties.filter(d => d.status === 'missed').length,
    };
  }, [duties]);

  function toggleDate(d: string) {
    setSelectedDates(s => s.includes(d) ? s.filter(x => x !== d) : [...s, d]);
  }
  function toggleTech(id: string) {
    setSelectedTechIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  // "Repeat" helper: add every matching weekday from today..until into selectedDates.
  function applyRepeat() {
    if (!repeatDays.length || !repeatUntil) { toast.error(t('nightBoard.pickWeekdayEnd', 'Pick weekday(s) and an end date')); return; }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(repeatUntil + 'T00:00:00');
    if (end < start) { toast.error(t('nightBoard.endDatePast', 'End date is in the past')); return; }
    const add: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (repeatDays.includes(d.getDay())) add.push(iso(d));
    }
    setSelectedDates(s => [...new Set([...s, ...add])]);
    toast.success(add.length === 1
      ? t('nightBoard.addedDateOne', 'Added 1 date')
      : t('nightBoard.addedDatesMany', { defaultValue: 'Added {{n}} dates', n: add.length }));
  }

  async function schedule() {
    if (saving) return;
    if (!selectedTechIds.length) { toast.error(t('nightBoard.selectOnePerson', 'Select at least one person')); return; }
    if (!selectedDates.length) { toast.error(t('nightBoard.selectOneDate', 'Select at least one date')); return; }
    setSaving(true);
    try {
      const group = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? null;
      const rows = [];
      for (const techId of selectedTechIds) {
        const tech = accts.find(a => a.id === techId);
        for (const date of selectedDates) {
          rows.push({
            technician_id: techId,
            assigned_by: myAccountId,
            plant_id: dutyPlant === 'auto' ? (tech?.plant_id ?? null) : dutyPlant,
            duty_date: date,
            status: 'scheduled',
            recurrence_group: group,
          });
        }
      }
      // Idempotent per (technician, date, plant) — migration 52. Falls back to the
      // legacy (technician, date) key until that migration has been run. Skipped
      // duplicates are reported honestly instead of pretending they were created.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res = await (supabase.from('night_duty') as any)
        .upsert(rows, { onConflict: 'technician_id,duty_date,plant_id', ignoreDuplicates: true })
        .select('id');
      if (res.error && /no unique|exclusion constraint/i.test(res.error.message)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res = await (supabase.from('night_duty') as any)
          .upsert(rows, { onConflict: 'technician_id,duty_date', ignoreDuplicates: true })
          .select('id');
      }
      if (res.error) { toast.error(t('nightBoard.scheduleFailed', { defaultValue: 'Schedule failed: {{message}}', message: res.error.message })); return; }
      const created = res.data?.length ?? 0;
      const skipped = rows.length - created;
      if (created === 0) {
        toast.error(skipped === 1
          ? t('nightBoard.nothingNewOne', 'Nothing new — that slot already exists for the selected people/dates (same plant + date).')
          : t('nightBoard.nothingNewMany', { defaultValue: 'Nothing new — all {{n}} slots already exist for the selected people/dates (same plant + date).', n: skipped }));
        return; // keep the wizard open so the allocator can adjust
      }
      const scheduledMsg = created === 1
        ? t('nightBoard.scheduledSlotOne', 'Scheduled 1 duty slot')
        : t('nightBoard.scheduledSlotsMany', { defaultValue: 'Scheduled {{n}} duty slots', n: created });
      toast.success(skipped > 0
        ? `${scheduledMsg} · ${t('nightBoard.alreadyExisted', { defaultValue: '{{n}} already existed', n: skipped })}`
        : scheduledMsg);
      setSelectedDates([]); setSelectedTechIds([]); setRepeatDays([]); setRepeatUntil(''); setDutyPlant('auto');
      setSchedulerOpen(false); setStep(1); // close the wizard on success — back to the report
      await load();
    } finally { setSaving(false); }
  }

  function closeWizard() {
    setSchedulerOpen(false); setStep(1);
  }

  // Month grid
  const monthGrid = useMemo(() => {
    const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
    const first = new Date(y, m, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells: (string | null)[] = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(iso(new Date(y, m, d)));
    return cells;
  }, [monthCursor]);

  // Upcoming duties grouped by date (used for the calendar dots).
  const dutiesByDate = useMemo(() => {
    const m: Record<string, Duty[]> = {};
    for (const d of duties) (m[d.duty_date] ??= []).push(d);
    return m;
  }, [duties]);

  const today = todayIso();
  const SHIFT_LABEL = '09:00 PM – 07:00 AM';

  // Flat schedule rows for the mockup table: employee · role · plant · duty date ·
  // shift · status · check-in. Filters are client-side over the loaded duties.
  const acctById = useMemo(() => Object.fromEntries(accts.map(a => [a.id, a])), [accts]);
  const scheduleRows = useMemo(() => {
    const q = schedQ.trim().toLowerCase();
    return duties.map(d => {
      const acct = acctById[d.technician_id];
      const role = acct?.role_id ? (roleLabel[acct.role_id] || '') : '';
      const plant = (d.plant_id ? plantName[d.plant_id] : acct?.plant_id ? plantName[acct.plant_id] : '') || '';
      return { d, name: acctName[d.technician_id] || t('nightBoard.unknown', 'Unknown'), role, plant };
    }).filter(r =>
      (!q || r.name.toLowerCase().includes(q) || r.role.toLowerCase().includes(q) || r.plant.toLowerCase().includes(q))
      && (schedPlant === 'all' || r.plant === schedPlant)
      && (schedStatus === 'all' || r.d.status === schedStatus)
      && (!schedFrom || r.d.duty_date >= schedFrom)
      && (!schedTo || r.d.duty_date <= schedTo));
  }, [duties, acctById, acctName, roleLabel, plantName, schedQ, schedPlant, schedStatus, schedFrom, schedTo, t]);
  const schedPg = usePagination(scheduleRows, { resetKey: `${schedQ}|${schedPlant}|${schedStatus}|${schedFrom}|${schedTo}` });

  const PILL_TONE: Record<string, 'blue' | 'green' | 'slate' | 'red'> = {
    scheduled: 'blue', checked_in: 'green', completed: 'slate', missed: 'red',
  };

  /** Un-schedule a future duty (scheduled only — check-ins are audit history). */
  async function removeDuty(d: Duty) {
    const dateLabel = formatDate(d.duty_date);
    if (!window.confirm(t('nightBoard.removeDutyConfirm', { defaultValue: 'Remove this scheduled duty ({{date}})?', date: dateLabel }))) return;
    const { error } = await supabase.from('night_duty').delete().eq('id', d.id);
    if (error) { toast.error(t('nightBoard.removeFailed', { defaultValue: 'Remove failed: {{message}}', message: error.message })); return; }
    toast.success(t('nightBoard.dutyRemoved', 'Duty removed'));
    await load();
  }

  function exportSchedule() {
    exportToCsv(`night-duty-schedule-${today}`, [
      { header: 'Employee', key: 'name' }, { header: 'Role', key: 'role' }, { header: 'Plant', key: 'plant' },
      { header: 'Duty Date', key: 'date' }, { header: 'Shift Time', key: 'shift' }, { header: 'Status', key: 'status' },
      { header: 'Check-in', key: 'checkin' },
    ], scheduleRows.map(r => ({
      name: r.name, role: r.role, plant: r.plant, date: r.d.duty_date, shift: SHIFT_LABEL,
      status: STATUS_CFG[r.d.status]?.label ?? r.d.status,
      checkin: r.d.checked_in_at ? formatDateTime(r.d.checked_in_at) : '',
    })));
  }

  // ── Wizard step bodies ─────────────────────────────────────────────────────

  const calendar = (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setMonthCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))} style={navBtn}>‹</button>
        <div className="text-sm font-semibold">{monthCursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
        <button onClick={() => setMonthCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))} style={navBtn}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
        {weekdayLabels.map((w, i) => <div key={WEEKDAYS[i]} style={{ textAlign: 'center', fontSize: 10.5, color: '#94A3B8', fontWeight: 700, padding: '2px 0' }}>{w.toUpperCase()}</div>)}
        {monthGrid.map((d, i) => {
          if (!d) return <div key={i} />;
          const past = d < today;
          const on = selectedDates.includes(d);
          const has = (dutiesByDate[d]?.length ?? 0) > 0;
          return (
            <button
              key={i}
              disabled={past}
              onClick={() => toggleDate(d)}
              style={{
                height: 36, borderRadius: 8, border: '1px solid ' + (on ? '#F47651' : 'transparent'),
                background: on ? '#F47651' : (d === today ? '#FFF7ED' : 'transparent'),
                color: on ? '#fff' : (past ? '#CBD5E1' : '#334155'),
                cursor: past ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 600, position: 'relative',
              }}
            >
              {Number(d.slice(-2))}
              {has && <span style={{ position: 'absolute', bottom: 3, left: '50%', transform: 'translateX(-50%)', width: 4, height: 4, borderRadius: '50%', background: on ? '#fff' : '#16A34A' }} />}
            </button>
          );
        })}
      </div>
      {selectedDates.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide mb-1">{selectedDates.length === 1 ? t('nightBoard.selectedDateOne', 'Selected Date') : t('nightBoard.selectedDatesMany', { defaultValue: 'Selected Dates ({{n}})', n: selectedDates.length })}</div>
          <div className="text-[13px] font-semibold text-[#C5421F]">
            {[...selectedDates].sort().slice(0, 3).map(d => `${new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}, ${formatDate(d)}`).join(' · ')}
            {selectedDates.length > 3 && ` ${t('nightBoard.moreDates', { defaultValue: '+{{n}} more', n: selectedDates.length - 3 })}`}
          </div>
        </div>
      )}
    </div>
  );

  const peoplePicker = (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11.5px] font-bold text-slate-600">{t('nightBoard.whosOnDuty', { defaultValue: "Who's on duty ({{n}} selected)", n: selectedTechIds.length })}</div>
        {selectedTechIds.length > 0 && <button onClick={() => setSelectedTechIds([])} style={{ fontSize: 10.5, color: '#64748B', border: 'none', background: 'none', cursor: 'pointer' }}>{t('nightBoard.clear', 'clear')}</button>}
      </div>
      <input
        type="text" value={techSearch} onChange={e => setTechSearch(e.target.value)}
        placeholder={t('nightBoard.searchByNameRoleLevel', 'Search by name, role or level…')}
        style={{ width: '100%', padding: '8px 11px', border: '1px solid #E2E8F0', borderRadius: 10, fontSize: 12.5, outline: 'none', fontFamily: 'inherit', marginBottom: 6, boxSizing: 'border-box' }}
      />
      <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #E2E8F0', borderRadius: 10, padding: 4 }}>
        {loading && <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>{t('nightBoard.loading', 'Loading…')}</div>}
        {!loading && subordinates.length === 0 && <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>{t('nightBoard.noTeamMembers', 'No team members beneath you in your plant.')}</div>}
        {!loading && subordinates.length > 0 && filteredSubs.length === 0 && <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>{t('nightBoard.noMatchFor', { defaultValue: 'No match for "{{q}}".', q: techSearch })}</div>}
        {filteredSubs.map(s => {
          const on = selectedTechIds.includes(s.id);
          const lvl = s.role_id ? roleTier[s.role_id] : '';
          return (
            <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', cursor: 'pointer', padding: '6px 8px', borderRadius: 8, background: on ? '#FFF7ED' : 'transparent' }}>
              <input type="checkbox" checked={on} onChange={() => toggleTech(s.id)} />
              <span style={{ flex: 1, fontWeight: 600 }}>{s.name}</span>
              <span style={{ fontSize: 10.5, color: '#64748B' }}>{s.role_id ? roleLabel[s.role_id] : ''}</span>
              {lvl && <span className="badge" style={{ fontSize: 9.5, background: '#F1F5F9', color: '#64748B', padding: '1px 5px' }}>{lvl}</span>}
              <span style={{ fontSize: 10, color: '#CBD5E1' }}>{s.plant_id ? plantName[s.plant_id] : ''}</span>
            </label>
          );
        })}
      </div>

      {/* Duty plant — lets a multi-plant technician be scheduled per plant */}
      <div className="mt-3">
        <div className="text-[11.5px] font-bold text-slate-600 mb-1">{t('nightBoard.dutyPlantLabel', 'Duty plant')}</div>
        <select
          value={dutyPlant}
          onChange={e => setDutyPlant(e.target.value)}
          style={{ width: '100%', padding: '8px 11px', border: '1px solid #E2E8F0', borderRadius: 10, fontSize: 12.5, fontFamily: 'inherit', background: '#fff', cursor: 'pointer' }}
        >
          <option value="auto">{t('nightBoard.autoOwnPlant', "Auto — each person's own plant")}</option>
          {pickerPlants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="text-[10.5px] text-slate-400 mt-1">{t('nightBoard.dutyPlantHint', 'Pick a specific plant to schedule someone at a plant other than their own — e.g. a second duty the same night at another plant.')}</div>
      </div>
    </div>
  );

  const repeatHelper = (
    <div>
      <div className="text-[11.5px] font-bold text-slate-600 mb-1.5">{t('nightBoard.repeatOptional', 'Repeat (for rotation) — optional')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        {weekdayLabels.map((w, idx) => {
          const on = repeatDays.includes(idx);
          return (
            <button key={WEEKDAYS[idx]} onClick={() => setRepeatDays(s => on ? s.filter(x => x !== idx) : [...s, idx])}
              style={{ padding: '5px 9px', borderRadius: 8, border: '1px solid ' + (on ? '#F47651' : '#E2E8F0'), background: on ? '#F47651' : '#fff', color: on ? '#fff' : '#475569', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{w}</button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: '#64748B' }}>{t('nightBoard.until', 'until')}</span>
        <input type="date" value={repeatUntil} min={today} onChange={e => setRepeatUntil(e.target.value)}
          style={{ padding: '7px 10px', border: '1px solid #E2E8F0', borderRadius: 10, fontSize: 12.5, fontFamily: 'inherit' }} />
        <ButtonV2 size="sm" variant="outline" onClick={applyRepeat}>{t('nightBoard.addDates', 'Add dates')}</ButtonV2>
      </div>
      <div className="text-[11px] text-slate-400 mt-2">{t('nightBoard.repeatHint', { defaultValue: 'Adds every matching weekday between today and the end date to your selected dates ({{n}} so far).', n: selectedDates.length })}</div>
    </div>
  );

  const review = (
    <div>
      <div className="text-[11.5px] font-bold text-slate-600 mb-2">{t('nightBoard.review', 'Review')}</div>
      <div className="rounded-[10px] border border-slate-200 divide-y divide-slate-100">
        <div className="flex justify-between px-3.5 py-2.5 text-[13px]"><span className="text-slate-500">{t('nightBoard.employees', 'Employees')}</span><span className="font-semibold">{selectedTechIds.length}</span></div>
        <div className="flex justify-between px-3.5 py-2.5 text-[13px]"><span className="text-slate-500">{t('nightBoard.nights', 'Nights')}</span><span className="font-semibold">{selectedDates.length}</span></div>
        <div className="flex justify-between px-3.5 py-2.5 text-[13px]"><span className="text-slate-500">{t('nightBoard.dutyPlantLabel', 'Duty plant')}</span><span className="font-semibold">{dutyPlant === 'auto' ? t('nightBoard.eachPersonsOwn', "Each person's own") : (plantName[dutyPlant] ?? '—')}</span></div>
        <div className="flex justify-between px-3.5 py-2.5 text-[13px]"><span className="text-slate-500">{t('nightBoard.dutySlots', 'Duty slots')}</span><span className="font-semibold">{selectedTechIds.length * selectedDates.length}</span></div>
      </div>
      {selectedTechIds.length > 0 && (
        <div className="text-[12px] text-slate-500 mt-2 leading-relaxed">
          {selectedTechIds.map(id => acctName[id] || t('nightBoard.unknown', 'Unknown')).join(', ')}
        </div>
      )}
      {(selectedTechIds.length === 0 || selectedDates.length === 0) && (
        <div className="text-[12px] text-amber-600 mt-2">{t('nightBoard.pickBeforeConfirm', 'Pick at least one date (step 1) and one employee (step 2) before confirming.')}</div>
      )}
    </div>
  );

  const stepBody = step === 1 ? calendar : step === 2 ? peoplePicker : step === 3 ? repeatHelper : review;

  // What each step must have before you may advance. Step 3 (repeat) is
  // optional by design, so it has no requirement.
  const canLeaveStep =
    step === 1 ? selectedDates.length > 0 :
    step === 2 ? selectedTechIds.length > 0 :
    true;
  const stepBlockedReason =
    step === 1 && !selectedDates.length ? t('nightBoard.selectOneDate', 'Select at least one date') :
    step === 2 && !selectedTechIds.length ? t('nightBoard.selectOnePerson', 'Select at least one person') :
    null;

  return (
    <div className={schedulerOpen ? 'grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-4 items-start mb-5' : 'mb-5'}>
    <div>
      {/* KPI cards — "View →" links drive the schedule-table filters */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label={t('nightBoard.onDutyTonight', 'On Duty Tonight')} value={loading ? '…' : report.tonight} caption={t('nightBoard.employees', 'Employees')}
          viewLabel={t('nightBoard.viewList', 'View list')} onView={() => { resetSchedFilters(); setSchedFrom(today); setSchedTo(today); }} />
        <StatCard label={t('nightBoard.upcomingDuties', 'Upcoming Duties')} value={loading ? '…' : report.scheduled} caption={t('nightBoard.scheduledAhead', 'Scheduled ahead')}
          viewLabel={t('nightBoard.viewCalendar', 'View calendar')} onView={() => { resetSchedFilters(); setSchedStatus('scheduled'); }} />
        <StatCard label={t('nightBoard.checkedInLabel', 'Checked In')} value={loading ? '…' : report.checkedIn} caption={t('nightBoard.todayCaption', 'Today')}
          valueTone={report.checkedIn > 0 ? 'green' : 'default'}
          viewLabel={t('nightBoard.viewCheckins', 'View check-ins')} onView={() => { resetSchedFilters(); setSchedStatus('checked_in'); }} />
        <StatCard label={t('nightBoard.missedCheckins', 'Missed Check-ins')} value={loading ? '…' : report.missed} caption={t('nightBoard.employees', 'Employees')}
          valueTone={report.missed > 0 ? 'orange' : 'default'}
          viewLabel={t('nightBoard.viewDetails', 'View details')} onView={() => { resetSchedFilters(); setSchedStatus('missed'); }} />
      </div>

    <SectionCard
      flush
      title={t('nightBoard.nightDutySchedule', 'Night Duty Schedule')}
      subtitle={t('nightBoard.scheduleSubtitle', 'Assign your team onto night-duty shifts. Rotate by scheduling different people on different nights.')}
      actions={
        <>
          <ButtonV2 variant="outline" icon={<Download />} onClick={exportSchedule} disabled={!scheduleRows.length}>
            {t('common.export', 'Export')}
          </ButtonV2>
          {!schedulerOpen && (
            <ButtonV2 variant="accent" icon={<Plus />} onClick={() => setSchedulerOpen(true)}>
              {t('nightBoard.assignNightDuty', 'Assign Night Duty')}
            </ButtonV2>
          )}
        </>
      }
    >
      {/* Filters — search · plant · date range · status · reset */}
      <div className="px-5 pb-4">
        <FilterBar
          className="!p-0 !border-0"
          search={schedQ} onSearch={setSchedQ} searchPlaceholder={t('nightBoard.searchEmployeePlaceholder', 'Search employee, role or plant…')}
          onReset={resetSchedFilters}
        >
          <FilterSelect icon={<Building2 />} value={schedPlant} onChange={setSchedPlant}
            options={[{ value: 'all', label: t('common.allPlants', 'All Plants') }, ...pickerPlants.map(p => ({ value: p.name, label: p.name }))]} />
          <div className="flex items-center gap-1.5">
            <input type="date" value={schedFrom} onChange={e => setSchedFrom(e.target.value)}
              className="rounded-[10px] border border-slate-200 bg-white text-[13px] text-slate-700 py-2.5 px-3 hover:bg-slate-50" />
            <span className="text-slate-400 text-[12px]">–</span>
            <input type="date" value={schedTo} onChange={e => setSchedTo(e.target.value)}
              className="rounded-[10px] border border-slate-200 bg-white text-[13px] text-slate-700 py-2.5 px-3 hover:bg-slate-50" />
          </div>
          <FilterSelect icon={<Activity />} value={schedStatus} onChange={setSchedStatus}
            options={[
              { value: 'all', label: t('common.allStatus', 'All Status') },
              { value: 'scheduled', label: statusLabels.scheduled },
              { value: 'checked_in', label: statusLabels.checked_in },
              { value: 'completed', label: statusLabels.completed },
              { value: 'missed', label: statusLabels.missed },
            ]} />
        </FilterBar>
      </div>

      {/* Schedule table */}
      <div className="overflow-x-auto scroll-x">
        <table className="dt2">
          <thead>
            <tr>
              <th>{t('nightBoard.thEmployee', 'Employee')}</th><th>{t('nightBoard.thRole', 'Role')}</th><th>{t('common.plant', 'Plant')}</th><th>{t('nightBoard.thDutyDate', 'Duty Date')}</th>
              <th>{t('nightBoard.thShiftTime', 'Shift Time')}</th><th>{t('nightBoard.thStatus', 'Status')}</th><th>{t('nightBoard.thCheckin', 'Check-in')}</th><th>{t('nightBoard.thActions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {schedPg.pageRows.map(r => (
              <tr key={r.d.id}>
                <td className="font-semibold text-slate-700">{r.name}</td>
                <td className="text-slate-500">{r.role || '—'}</td>
                <td className="text-slate-500">{r.plant || '—'}</td>
                <td>
                  <div className="text-slate-700 font-medium">{formatDate(r.d.duty_date)}</div>
                  <div className="text-[11px] text-slate-400">{new Date(r.d.duty_date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                </td>
                <td className="text-slate-500">{SHIFT_LABEL}</td>
                <td><StatusPill tone={PILL_TONE[r.d.status] ?? 'slate'} label={statusLabels[r.d.status] ?? r.d.status} /></td>
                <td>
                  {r.d.checked_in_at ? (
                    <>
                      <div className="text-slate-700">{formatTime(r.d.checked_in_at)}</div>
                      <div className="text-[11px] text-slate-400">{formatDate(r.d.checked_in_at)}</div>
                    </>
                  ) : <span className="text-slate-300">—</span>}
                </td>
                <td>
                  {r.d.status === 'scheduled'
                    ? <ButtonV2 size="sm" variant="outline" onClick={() => removeDuty(r.d)}>{t('nightBoard.remove', 'Remove')}</ButtonV2>
                    : <span className="text-slate-300 text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Below the scrolling table, not inside it — a full-width row is cut off on a phone. */}
      {schedPg.pageRows.length === 0 && (
        <div className="text-center text-slate-400 py-8 text-sm border-t border-slate-100">
          {loading ? '…' : duties.length === 0 ? t('nightBoard.noUpcomingDuty', 'No upcoming night duty scheduled.') : t('nightBoard.noDutiesMatch', 'No duties match your filters.')}
        </div>
      )}
      <TablePaginationV2 controls={schedPg.controls} label={t('nightBoard.records', 'records')} />
    </SectionCard>
    </div>

    {/* ── Inline wizard panel: Assign Night Duty ─────────────────────────── */}
    {schedulerOpen && (
      <div ref={wizardRef} className="card2 p-5 lg:sticky lg:top-4">
        <div className="flex items-start justify-between mb-1">
          <div className="font-heading font-semibold text-[17px]">{t('nightBoard.assignNightDuty', 'Assign Night Duty')}</div>
          <button onClick={closeWizard} aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 -mr-1"><X size={16} /></button>
        </div>
        <div className="text-[12.5px] text-slate-500 mb-4">{t('nightBoard.wizardSubtitle', 'Schedule night duty for employees.')}</div>

        {/* Step list */}
        <div className="flex flex-col gap-3 mb-4">
          {wizardSteps.map(s => {
            const active = s.n === step;
            const done = s.n < step;
            return (
              <button key={s.n} onClick={() => setStep(s.n)} className="flex items-start gap-3 text-left" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                <span
                  className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5"
                  style={active ? { background: '#F47651', color: '#fff' }
                    : done ? { background: '#FFEDE5', color: '#C5421F' }
                    : { background: '#F1F5F9', color: '#94A3B8' }}
                >
                  {s.n}
                </span>
                <span>
                  <span className={`block text-[13px] font-semibold ${active ? 'text-slate-900' : 'text-slate-500'}`}>{s.title}</span>
                  <span className="block text-[11px] text-slate-400">{s.sub}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-slate-100 pt-4">
          {stepBody}
        </div>

        {/* Why Next is unavailable — a disabled button with no explanation just
            reads as broken. */}
        {stepBlockedReason && (
          <div style={{ fontSize: 11.5, color: '#B45309', marginTop: 10 }}>{stepBlockedReason}</div>
        )}

        {/* Footer buttons */}
        <div className="flex items-center justify-between gap-2 mt-5">
          <ButtonV2 variant="outline" onClick={step === 1 ? closeWizard : () => setStep(s => s - 1)}>
            {step === 1 ? t('nightBoard.cancel', 'Cancel') : t('nightBoard.back', 'Back')}
          </ButtonV2>
          {step < 4 ? (
            // Each step gates its own requirement. Without this the wizard let
            // you walk from "Select Employees" to Review with nobody selected —
            // typing a name into the SEARCH box looks like picking someone, so
            // you only discovered the mistake at the very end.
            <ButtonV2 variant="primary" onClick={() => setStep(s => s + 1)} disabled={!canLeaveStep}>
              {t('nightBoard.next', 'Next')}
            </ButtonV2>
          ) : (
            <ButtonV2 variant="primary" onClick={schedule} disabled={saving || !selectedTechIds.length || !selectedDates.length}>
              {saving
                ? t('nightBoard.scheduling', 'Scheduling…')
                : selectedDates.length === 1
                  ? t('nightBoard.confirmNightsOne', { defaultValue: 'Confirm · {{techs}}× {{dates}} night', techs: selectedTechIds.length, dates: selectedDates.length })
                  : t('nightBoard.confirmNightsMany', { defaultValue: 'Confirm · {{techs}}× {{dates}} nights', techs: selectedTechIds.length, dates: selectedDates.length })}
            </ButtonV2>
          )}
        </div>
      </div>
    )}
    </div>
  );
}

const navBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 8, border: '1px solid #E2E8F0', background: '#fff', cursor: 'pointer', fontSize: 16, color: '#475569' };
