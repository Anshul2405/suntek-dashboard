import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { fetchAllRows } from '../../../lib/fetchAll';
import { useToast } from '../../../components/ui/toast';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { isAdminProfile } from '../../../lib/profiles';
import { useColumnLive } from '../../../lib/schemaProbe';
import { useMyIdentity } from '../../../lib/useMyIdentity';
import { formatDate, istToday } from '../../../lib/utils/formatting';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination, ButtonV2, SegmentTabs, DateRangeFilter } from '../../../components/v2';
import { findBusyPayment, fmtINRFull, maskAccount, type PaymentRow } from '../../../lib/payments';
import { BUSY_COMPANIES } from '../../../lib/busyCompanies';
import { useBusyMovementsByCompany, useBusyPayees, type BusyCompany } from '../../../lib/busyPayees';
import { DateInput } from '../../../components/ui/DateInput';
import { useUrlFilters } from '../../../lib/urlFilters';
import { isValidIfsc, normalizeIfsc } from '../../../lib/validate/ifsc';
import { logActivity } from '../../../lib/activityWrite';
import { useRights } from '../../../lib/access/useRights';
import { ensureLateApproval } from '../../../lib/opsControls';
import {
  BUSY_OPEN_STATUSES, PAYMENT_STAGES, busyUpdatesToSave, missingBank, nextMoves, normalizeStatus, stageCounts,
  type PaymentActor, type PaymentStage,
} from '../../../lib/paymentFlow';

const input = 'block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-full max-sm:min-h-[44px] max-sm:text-[16px]';
const label = 'text-xs text-slate-600 min-w-0';
/** Filter selects: same height and type as the DateRangeFilter boxes. */
const FILTER = 'px-2.5 py-2 rounded-[10px] border border-slate-200 text-[12.5px] bg-white max-sm:w-full max-sm:min-h-[44px] max-sm:text-[15px]';

const BLANK = {
  company: '' as BusyCompany | '', payee: '', manual: false, exceptionReason: '',
  pay_date: '', amount: '', purpose: '', account_no: '', ifsc: '', bank: '', remarks: '', plant_id: '',
};

const TONE: Record<PaymentStage, { bg: string; color: string }> = {
  input_done: { bg: '#F1F5F9', color: '#334155' },
  payment_pending: { bg: '#FEF9C3', color: '#A16207' },
  payment_approved: { bg: '#DCFCE7', color: '#15803D' },
  payment_processing: { bg: '#FFEDD5', color: '#C2410C' },
  payment_completed: { bg: '#DBEAFE', color: '#1D4ED8' },
  busy_updated: { bg: '#CCFBF1', color: '#0F766E' },
  rejected: { bg: '#FEE2E2', color: '#B91C1C' },
};

type Tab = 'all' | PaymentStage;
const isLegacy = (r: PaymentRow) => r.flow_version == null;
const stageOf = (r: PaymentRow) => normalizeStatus(r.status, isLegacy(r));
const companyShort = (code: string | null | undefined) => BUSY_COMPANIES.find(c => c.code === code)?.short ?? '—';

/**
 * Payments — the Axis payment machine. Six saved stages (lib/paymentFlow.ts),
 * company first, payees from that company's Busy feed (read only), a separate
 * exception path for payees not in Busy, stage tabs with counts from the table.
 * "Updated in Busy" is saved when the read-only Busy feed shows the payment (or
 * someone types the voucher no). Nothing is ever written to Busy.
 * Needs migration 0040; until then it says so and shows saved rows read-only.
 */
export function BookPayments() {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  // User Management → Add / Edit / Delete ticks (and Purchase-book tabs).
  const rights = useRights();
  const me = useMyIdentity();
  const { allowedPlants, ready, isGlobal, inScope, plants } = usePlantScope();
  const tableLive = useColumnLive('purchase_payments', 'id');
  const v2 = useColumnLive('purchase_payments', 'company_code');
  const admin = isAdminProfile(activeProfile);
  const role = activeProfile.baseRoleId || activeProfile.id;
  const actor: PaymentActor = {
    authId: me.authUserId,
    name: activeProfile.name,
    admin,
    accounts: role === 'accountant_delhi' || role === 'accountant_other',
    manager: role === 'management',
  };
  const confirmsBusy = admin || actor.accounts || actor.manager;
  const pickerPlants = plantsForPicker(allowedPlants, ready);

  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [range, setRange] = useState({ from: '', to: '' });
  const [companyFilter, setCompanyFilter] = useState<'' | BusyCompany>('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'busy' | 'manual'>('all');
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bankEdit, setBankEdit] = useState<{ id: string; account_no: string; ifsc: string; bank: string } | null>(null);

  const { data: payees, isLoading: payeesLoading } = useBusyPayees(form.company);
  const { data: feedByCompany } = useBusyMovementsByCompany(tableLive && loaded);

  // All rows for the date range (paged — counts are exact, not a capped sample).
  useEffect(() => {
    if (!tableLive || !ready) return;
    let alive = true;
    void fetchAllRows<PaymentRow>((from, to) => {
      let q = supabase.from('purchase_payments').select('*');
      if (range.from) q = q.gte('pay_date', range.from);
      if (range.to) q = q.lte('pay_date', range.to);
      return q.order('pay_date', { ascending: false }).order('created_at', { ascending: false }).range(from, to).returns<PaymentRow[]>();
    }).then(({ data, error }) => {
      if (!alive) return;
      if (error) setErr(error.message || 'error');
      setRows(data);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [tableLive, ready, range.from, range.to]);

  // Plant rows follow the plant grant; head-office rows (no plant) are for
  // accounts / management. Same rule as the 0040 policy — the server enforces it.
  const visible = useMemo(() => rows.filter(r => (r.plant_id
    ? inScope(r.plant_id)
    : isGlobal || admin || actor.accounts || actor.manager)), [rows, inScope, isGlobal, admin, actor.accounts, actor.manager]);

  const filtered = useMemo(() => visible.filter(r =>
    (!companyFilter || r.company_code === companyFilter)
    && (sourceFilter === 'all' || (sourceFilter === 'manual' ? r.payee_source === 'manual' : r.payee_source !== 'manual'))), [visible, companyFilter, sourceFilter]);
  const counts = useMemo(() => stageCounts(filtered.map(r => ({ ...r, legacy: isLegacy(r) }))), [filtered]);
  // Opened from Activity Log (?payment=<id>): that one payment, "Show all" clears it.
  const focus = useUrlFilters(['payment'] as const);
  const focusId = focus.values.payment;
  const tabRows = useMemo(() => (focusId ? visible.filter(r => r.id === focusId)
    : tab === 'all' ? filtered : filtered.filter(r => stageOf(r) === tab)), [filtered, visible, tab, focusId]);
  const page = usePagination(tabRows, { resetKey: `${tab}|${companyFilter}|${sourceFilter}|${range.from}|${range.to}` });

  // Matches in the read-only Busy feed (per company; old rows with no company → any).
  const busyTried = useRef(new Set<string>());
  const [busyNeedsSql, setBusyNeedsSql] = useState<Set<string>>(new Set());
  const busyMatch = useMemo(() => {
    const m = new Map<string, string>();
    if (!feedByCompany) return m;
    for (const r of visible) {
      // Any open stage: Busy may be paid before Axis is walked through (Sidak, 29 Oct 2026).
      const st = stageOf(r);
      if (st === 'busy_updated' || st === 'rejected') continue;
      const feed = r.company_code ? feedByCompany[r.company_code] ?? [] : Object.values(feedByCompany).flat();
      const hit = findBusyPayment(r, feed);
      if (hit) m.set(r.id, hit.sub);
    }
    return m;
  }, [visible, feedByCompany]);

  // Save "Updated in Busy" once a match shows — so the tick no longer vanishes
  // when the 3-day feed moves on. Only people allowed to confirm it, once per row.
  useEffect(() => {
    if (!v2 || !confirmsBusy || busyMatch.size === 0) return;
    const todo = busyUpdatesToSave(visible, r => busyMatch.get(r.id) ?? null);
    if (!todo.length) return;
    // Each row once per visit (a refused save is not retried on every render).
    // A finished save is always shown, even if the page re-rendered meanwhile —
    // dropping it left a row saved in the database but not green on screen.
    const fresh = todo.filter(({ id }) => !busyTried.current.has(id));
    for (const { id } of fresh) busyTried.current.add(id);
    void (async () => {
      for (const { id, voucher } of fresh) {
        const patch = { status: 'busy_updated' as const, busy_voucher: voucher, busy_match: 'auto' as const, flow_version: 2 };
        const { error } = await updateRows('purchase_payments', patch).eq('id', id).in('status', [...BUSY_OPEN_STATUSES]);
        if (!error) setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
        // Before migration 0043 the database only allows Completed → Updated in Busy.
        else if (/cannot move/i.test(error.message || '')) setBusyNeedsSql(prev => new Set(prev).add(id));
      }
    })();
  }, [v2, confirmsBusy, busyMatch, visible]);

  const amount = Number(form.amount);
  // IFSC, when typed: 11 characters, 0 in the 5th place.
  const ifscBad = !!form.ifsc.trim() && !isValidIfsc(form.ifsc);
  const canSave = v2 && !ifscBad && !!form.company && !!form.pay_date && !!form.payee.trim() && Number.isFinite(amount) && amount > 0
    && !!form.purpose.trim() && (!form.manual || !!form.exceptionReason.trim()) && (isGlobal || !!form.plant_id);
  const formMissingBank = missingBank({ account_no: form.account_no, ifsc: form.ifsc });

  async function save() {
    if (!canSave) return;
    // Back-date limit (User Management → Back-date limits). A future pay date is fine.
    const allowedDate = await ensureLateApproval({
      module: 'payments', entryDate: form.pay_date, profile: activeProfile,
      bufferDays: rights.backDays('payments', [form.plant_id]),
    });
    if (!allowedDate) { setErr(t('common.lateBlocked', 'Not saved: this date is further back than allowed. A request has gone to Management; once approved, save again with the same date.')); return; }
    setBusy(true);
    setErr(null);
    try {
      const { data, error } = await insertRows('purchase_payments', {
        company_code: form.company,
        pay_date: form.pay_date,
        beneficiary: form.payee.trim(),
        payee_source: form.manual ? 'manual' : 'busy',
        exception_reason: form.manual ? form.exceptionReason.trim() : null,
        purpose: form.purpose.trim(),
        account_no: form.account_no.replace(/\s+/g, '') || null,
        ifsc: normalizeIfsc(form.ifsc) || null,
        bank: form.bank.trim() || null,
        amount,
        remarks: form.remarks.trim() || null,
        input_by: activeProfile.name,
        plant_id: form.plant_id || null,
        status: 'input_done',
        flow_version: 2,
      }).select('*').single();
      if (error) { setErr(error.message); return; }
      if (data) {
        const row = data as PaymentRow;
        setRows(prev => [row, ...prev]);
        // A line in the Activity Log that opens this payment (needs 0042).
        void logActivity({
          type: 'payment', date: row.pay_date, done_by: activeProfile.name, verified_by: null, photo_url: null,
          equipment: `Payment: ${row.beneficiary || ''}`.trim(), plant_id: row.plant_id ?? null,
          note: `${fmtINRFull(row.amount)} · ${companyShort(row.company_code)}${row.purpose ? ` · ${row.purpose}` : ''}`,
        }, { type: 'payment', id: row.id }, { onlyIfLinked: true });
      }
      setShowForm(false);
      setForm(BLANK);
      toast.success(t('payments.savedOkV2', 'Payment entered (Input Done). Delhi accounts check it and send it for approval.'));
    } finally {
      setBusy(false);
    }
  }

  async function move(row: PaymentRow, to: PaymentStage) {
    let extra: Partial<PaymentRow> = {};
    if (to === 'rejected') {
      const reason = window.prompt(t('payments.rejectReason', 'Why is this payment rejected?')) ?? '';
      if (!reason.trim()) return;
      extra = { reject_reason: reason.trim() };
    }
    if (to === 'busy_updated') {
      const voucher = busyMatch.get(row.id) ?? window.prompt(t('payments.busyVoucherPrompt', 'Busy payment voucher no.')) ?? '';
      if (!voucher.trim()) return;
      extra = { busy_voucher: voucher.trim(), busy_match: busyMatch.has(row.id) ? 'auto' : 'manual' };
    }
    setBusy(true);
    try {
      // The server stamps who / when (0040 trigger) and refuses wrong order or people.
      const patch = { status: to, flow_version: 2, ...extra } as Partial<PaymentRow>;
      const { data, error } = await updateRows('purchase_payments', patch).eq('id', row.id).select('*').single();
      if (error) { toast.error(error.message); return; }
      setRows(prev => prev.map(r => (r.id === row.id ? (data as PaymentRow) ?? { ...r, ...patch } : r)));
    } finally {
      setBusy(false);
    }
  }

  async function saveBank() {
    if (!bankEdit) return;
    if (bankEdit.ifsc.trim() && !isValidIfsc(bankEdit.ifsc)) {
      toast.error(t('common.ifscInvalid', 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. UTIB0000123).'));
      return;
    }
    setBusy(true);
    try {
      const patch = { account_no: bankEdit.account_no.replace(/\s+/g, '') || null, ifsc: normalizeIfsc(bankEdit.ifsc) || null, bank: bankEdit.bank.trim() || null };
      const { error } = await updateRows('purchase_payments', patch).eq('id', bankEdit.id);
      if (error) { toast.error(error.message); return; }
      setRows(prev => prev.map(r => (r.id === bankEdit.id ? { ...r, ...patch, missing_bank: missingBank(patch) } : r)));
      setBankEdit(null);
    } finally {
      setBusy(false);
    }
  }

  const stageLabel = (s: PaymentStage) => ({
    input_done: t('payments.stageInputDone', 'Input Done'),
    payment_pending: t('payments.stagePending', 'Payment Pending'),
    payment_approved: t('payments.stageApproved', 'Payment Approved'),
    payment_processing: t('payments.stageProcessing', 'Payment Processing (Axis)'),
    payment_completed: t('payments.stageCompleted', 'Payment Completed'),
    busy_updated: t('payments.stageBusy', 'Updated in Busy'),
    rejected: t('payments.stageRejected', 'Rejected'),
  })[s];
  /** Short stage names for the table's Status column (the header already says Status). */
  const stageShort = (s: PaymentStage) => ({
    input_done: t('payments.stageInputDone', 'Input Done'),
    payment_pending: t('payments.stageShortPending', 'Pending'),
    payment_approved: t('payments.stageShortApproved', 'Approved'),
    payment_processing: t('payments.stageShortProcessing', 'Processing (Axis)'),
    payment_completed: t('payments.stageShortCompleted', 'Completed'),
    busy_updated: t('payments.stageBusy', 'Updated in Busy'),
    rejected: t('payments.stageRejected', 'Rejected'),
  })[s];
  const moveLabel = (s: PaymentStage) => ({
    input_done: '',
    payment_pending: t('payments.moveToPending', 'Send for approval'),
    payment_approved: t('payments.moveApprove', 'Approve'),
    payment_processing: t('payments.moveProcessing', 'Keyed into Axis'),
    payment_completed: t('payments.moveCompleted', 'Paid by Axis'),
    busy_updated: t('payments.moveBusy', 'Confirm in Busy'),
    rejected: t('payments.moveReject', 'Reject'),
  })[s];
  const blockedText = (reason: string) => ({
    role: t('payments.blockedRole', 'Not your step'),
    own_row: t('payments.blockedOwn', 'You entered this — someone else approves'),
    missing_bank: t('payments.blockedBank', 'Add account no + IFSC first'),
    order: '',
  } as Record<string, string>)[reason] ?? '';
  const stampFor = (r: PaymentRow): string | null => {
    const s = stageOf(r);
    const pair = s === 'payment_pending' ? [r.pending_by, r.pending_at]
      : s === 'payment_approved' ? [r.approved_by, r.approved_at]
      : s === 'payment_processing' ? [r.processing_by ?? r.input_done_by, r.processing_at ?? r.input_done_at]
      : s === 'payment_completed' ? [r.completed_by ?? r.payment_done_by, r.completed_at ?? r.payment_done_at]
      : s === 'busy_updated' ? [r.busy_updated_by, r.busy_updated_at ?? r.busy_done_at]
      : s === 'rejected' ? [r.rejected_by, r.rejected_at] : [null, null];
    return pair[1] ? `${pair[0] || '—'} · ${formatDate(pair[1])}` : null;
  };
  /** Under the status badge: just the day (who did it is on hover) so Status stays narrow. */
  const stampDay = (r: PaymentRow): string | null => stampFor(r)?.split(' · ').pop() ?? null;

  /** What one row shows and allows — shared by the desktop table and the phone cards. */
  const rowInfo = (r: PaymentRow) => {
    const s = stageOf(r);
    return {
      s,
      tone: TONE[s],
      noBank: missingBank(r),
      moves: v2 ? nextMoves(r, actor, isLegacy(r)) : [],
      editingBank: bankEdit?.id === r.id,
      bankEditable: v2 && (actor.accounts || admin || actor.manager)
        && ['input_done', 'payment_pending', 'payment_approved'].includes(s),
      seen: s !== 'busy_updated' && s !== 'rejected' ? busyMatch.get(r.id) : undefined,
      plantName: r.plant_id ? plants.find(p => p.id === r.plant_id)?.name : undefined,
    };
  };
  const payeeBadge = (r: PaymentRow) => r.payee_source === 'manual'
    ? <span className="badge shrink-0" style={{ background: '#FEF3C7', color: '#92400E', fontSize: 10 }} title={r.exception_reason ?? t('payments.badgeException', 'Not in Busy — exception')}>{t('payments.badgeManualShort', 'Not in Busy')}</span>
    : r.payee_source === 'busy' ? <span className="badge shrink-0" style={{ background: '#E0F2FE', color: '#0369A1', fontSize: 10 }} title={t('payments.badgeBusy', 'Busy payee')}>{t('payments.badgeBusyShort', 'Busy')}</span> : null;
  /** Lines under the status badge: who/when, Busy voucher, seen in Busy, reject reason. */
  const statusNotes = (r: PaymentRow, s: PaymentStage, seen: string | undefined, phone = false) => (
    <>
      {/* Phones have no hover: the card says who moved it as well as the day. */}
      {stampFor(r) && <div className="text-xs text-slate-400 leading-snug" title={stampFor(r) ?? ''}>{phone ? `${stageShort(s)}: ${stampFor(r)}` : stampDay(r)}</div>}
      {s === 'busy_updated' && r.busy_voucher && <div className="text-xs text-slate-400">{r.busy_voucher}{r.busy_match === 'manual' ? ` · ${t('payments.busyManual', 'typed')}` : ''}</div>}
      {seen && <div className="text-xs text-teal-700">{t('payments.busySeen', { defaultValue: 'Seen in Busy: {{v}}', v: seen })}</div>}
      {seen && busyNeedsSql.has(r.id) && <div className="text-[11px] text-amber-700">{t('payments.busyNeedsSql', 'Turns green once migration 0043 is applied')}</div>}
      {s === 'rejected' && r.reject_reason && <div className="text-xs text-red-600 max-w-[200px] truncate" title={r.reject_reason}>{r.reject_reason}</div>}
      {isLegacy(r) && <div className="text-[10px] text-slate-400">{t('payments.legacyRow', 'Entered before the six stages')}</div>}
    </>
  );
  /** Next-stage buttons + Bank details. `phone`: 44px buttons in a wrapping row. */
  const rowActions = (r: PaymentRow, info: ReturnType<typeof rowInfo>, phone = false) => {
    const btn = phone ? 'min-h-[44px] px-3 rounded-lg border text-[13px] font-bold' : 'text-xs font-bold';
    return (
      <div className={phone ? 'flex flex-wrap items-center gap-2' : 'flex flex-col items-start gap-1'}>
        {info.moves.map(({ to, check }) => check.ok ? (
          <button key={to} type="button"
            className={`${btn} ${to === 'rejected' ? 'text-red-600' : 'text-blue-700'} ${phone ? (to === 'rejected' ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50') : ''}`}
            disabled={busy} onClick={() => void move(r, to)}>{moveLabel(to)}</button>
        ) : check.reason !== 'role' && check.reason !== 'order' ? (
          <span key={to} className={`text-[11px] text-slate-400 whitespace-normal ${phone ? 'w-full' : 'max-w-[170px]'}`}>{moveLabel(to)}: {blockedText(check.reason)}</span>
        ) : null)}
        {info.bankEditable && !info.editingBank && (
          <button type="button" className={phone ? 'min-h-[44px] px-3 rounded-lg border border-slate-200 text-[13px] text-slate-600' : 'text-xs text-slate-600 underline'}
            onClick={() => setBankEdit({ id: r.id, account_no: r.account_no ?? '', ifsc: r.ifsc ?? '', bank: r.bank ?? '' })}>{t('payments.editBank', 'Bank details')}</button>
        )}
      </div>
    );
  };
  /** Bank details editor (own row in the table; inside the card on a phone). */
  const bankEditor = (r: PaymentRow) => bankEdit && (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-500 max-sm:w-full">{t('payments.editBank', 'Bank details')} · {r.beneficiary}</span>
      <input className="border border-slate-200 rounded px-2 py-1 text-xs w-40 max-sm:w-full max-sm:min-h-[44px] max-sm:text-[16px]" placeholder={t('payments.account', 'A/c number')} value={bankEdit.account_no} onChange={e => setBankEdit({ ...bankEdit, account_no: e.target.value })} />
      <input className="border border-slate-200 rounded px-2 py-1 text-xs w-32 max-sm:w-full max-sm:min-h-[44px] max-sm:text-[16px]" placeholder="IFSC" value={bankEdit.ifsc} onChange={e => setBankEdit({ ...bankEdit, ifsc: e.target.value })} />
      <input className="border border-slate-200 rounded px-2 py-1 text-xs w-32 max-sm:w-full max-sm:min-h-[44px] max-sm:text-[16px]" placeholder={t('payments.bank', 'Bank')} value={bankEdit.bank} onChange={e => setBankEdit({ ...bankEdit, bank: e.target.value })} />
      <button type="button" className="text-xs font-bold text-emerald-700 max-sm:min-h-[44px] max-sm:px-4 max-sm:rounded-lg max-sm:border max-sm:border-emerald-200" disabled={busy} onClick={() => void saveBank()}>{t('payments.saveBank', 'Save')}</button>
      <button type="button" className="text-xs text-slate-500 max-sm:min-h-[44px] max-sm:px-4" onClick={() => setBankEdit(null)}>{t('common.cancel', 'Cancel')}</button>
    </div>
  );
  const emptyText = !loaded ? '…' : filtered.length === 0 && visible.length > 0 ? t('payments.noMatch', 'No payments match these filters.') : tab !== 'all' && filtered.length > 0 ? t('payments.noneInStage', 'No payments at this stage.') : t('payments.empty', 'No live payments yet.');

  if (!tableLive) {
    return (
      <div className="card2 p-4 mb-4">
        <div className="text-sm font-bold mb-1">{t('payments.title', 'Payments — live')}</div>
        <p className="text-xs text-slate-500">{t('payments.notApplied', 'The live payments table is not applied yet (migration 0038_dispatch_payments_vijay.sql). Until it is, nothing can be entered here; the workbook Payments sheet below is the record.')}</p>
      </div>
    );
  }

  const tabs: Tab[] = ['all', ...PAYMENT_STAGES, 'rejected'];

  return (
    <div className="card2 p-4 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-bold">{t('payments.titleV2', 'Payments — Axis')}</div>
          <p className="text-xs text-slate-500 mt-0.5">{t('payments.hintV2', 'Input Done → Payment Pending (Delhi accounts) → Payment Approved (management, not the person who entered it) → Payment Processing (Axis, Delhi accounts) → Payment Completed → Updated in Busy (from the Busy feed — Busy is only read).')}</p>
        </div>
        {v2 && !showForm && rights.can('payments', 'add') && (
          <ButtonV2 variant="primary" className="max-sm:w-full" onClick={() => { setForm({ ...BLANK, pay_date: istToday(), plant_id: pickerPlants.length === 1 ? pickerPlants[0].id : '' }); setErr(null); setShowForm(true); }}>
            {t('payments.add', 'New payment')}
          </ButtonV2>
        )}
      </div>

      {!v2 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
          {t('payments.needs0040', 'Payment stages need migration 0040 (not applied). Saved payments are shown read-only below; new entries open once it is applied.')}
        </p>
      )}

      {showForm && (
        <div className="border border-slate-200 rounded-xl p-3 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className={label}>{t('payments.company', 'Busy company *')}
              <select className={input} value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value as BusyCompany | '', payee: '' }))}>
                <option value="">{t('payments.pickCompany', 'Pick the company first…')}</option>
                {BUSY_COMPANIES.map(c => <option key={c.code} value={c.code}>{c.short} ({c.code})</option>)}
              </select>
            </label>
            <label className={`${label} lg:col-span-2`}>{t('payments.payee', 'Payee *')}
              {form.manual ? (
                <input className={input} value={form.payee} disabled={!form.company} onChange={e => setForm(f => ({ ...f, payee: e.target.value }))} />
              ) : (
                <select className={input} value={form.payee} disabled={!form.company} onChange={e => {
                  const p = (payees ?? []).find(x => x.name === e.target.value);
                  setForm(f => ({
                    ...f,
                    payee: e.target.value,
                    account_no: p?.accountNo || f.account_no,
                    ifsc: p?.ifsc || f.ifsc,
                    bank: p?.bank || f.bank,
                  }));
                }}>
                  <option value="">{!form.company ? t('payments.pickCompanyFirst', 'Pick the company first') : payeesLoading ? '…' : (payees?.length ? t('payments.pickPayee', 'Pick a payee from Busy…') : t('payments.noBusyPayees', 'No payees in this company’s Busy feed'))}</option>
                  {(payees ?? []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              )}
              <span className="flex items-center gap-2 mt-1 max-sm:min-h-[44px]">
                <input type="checkbox" className="max-sm:w-5 max-sm:h-5" checked={form.manual} disabled={!form.company} onChange={e => setForm(f => ({ ...f, manual: e.target.checked, payee: '' }))} />
                {t('payments.notInBusy', 'Payee not in Busy (exception)')}
              </span>
            </label>
            <label className={label}>{t('payments.amount', 'Amount (₹)')} *
              <input className={input} inputMode="decimal" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
              {/* The full figure, never shortened to lakh. */}
              <span className="block text-[11px] text-slate-500 mt-1 min-h-[16px]">{form.amount.trim() && Number.isFinite(Number(form.amount)) ? fmtINRFull(form.amount) : ' '}</span>
            </label>
            <label className={`${label} sm:col-span-2`}>{t('payments.purpose', 'Purpose *')}
              <input className={input} value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.date', 'Date')}
              <DateInput className={input} value={form.pay_date} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.plant', 'Plant')}
              <select className={input} value={form.plant_id} onChange={e => setForm(f => ({ ...f, plant_id: e.target.value }))}>
                <option value="">{isGlobal ? t('payments.noPlant', 'Head office / none') : t('payments.pickPlant', 'Pick a plant…')}</option>
                {pickerPlants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className={label}>{t('payments.account', 'A/c number')}
              <input className={input} inputMode="numeric" autoComplete="off" value={form.account_no} onChange={e => setForm(f => ({ ...f, account_no: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.ifsc', 'IFSC')}
              <input className={input} autoComplete="off" value={form.ifsc} aria-invalid={ifscBad || undefined}
                style={ifscBad ? { borderColor: '#DC2626' } : undefined}
                onChange={e => setForm(f => ({ ...f, ifsc: e.target.value }))} />
              {ifscBad && <span className="block text-[11px] text-red-600 mt-1">{t('common.ifscInvalid', 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. UTIB0000123).')}</span>}
            </label>
            <label className={label}>{t('payments.bank', 'Bank')}
              <input className={input} value={form.bank} onChange={e => setForm(f => ({ ...f, bank: e.target.value }))} />
            </label>
            <label className={`${label} sm:col-span-2 lg:col-span-4`}>{t('payments.notes', 'Notes')}
              <input className={input} value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
            </label>
            {/* At the end, so ticking "not in Busy" never pushes the other fields around. */}
            {form.manual && (
              <label className={`${label} sm:col-span-2 lg:col-span-4`}>{t('payments.exceptionReason', 'Why is this payee not in Busy? *')}
                <input className={input} value={form.exceptionReason} onChange={e => setForm(f => ({ ...f, exceptionReason: e.target.value }))} />
              </label>
            )}
          </div>
          {formMissingBank && <p className="text-xs text-amber-700 mt-2">{t('payments.missingBankHint', 'Bank details missing — it can be entered, but not keyed into Axis until account no and IFSC are filled.')}</p>}
          <p className="text-xs text-slate-500 mt-1">{t('payments.inputBy', { defaultValue: 'Input by {{name}}', name: activeProfile.name })} · {t('payments.busyReadOnlyNote', 'Payees come from the Busy feed (read only). The feed has no bank details.')}</p>
          {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
          {/* Phones: Save stays under the thumb (pinned above the home indicator). */}
          <div className="flex gap-2 mt-3 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-3 max-sm:px-3 max-sm:pt-2 max-sm:pb-[max(8px,env(safe-area-inset-bottom))] max-sm:bg-white max-sm:border-t max-sm:border-slate-200" data-testid="payment-save-bar">
            <ButtonV2 variant="primary" className="max-sm:flex-1" disabled={!canSave || busy} onClick={() => void save()}>{t('payments.save', 'Save payment')}</ButtonV2>
            <ButtonV2 className="max-sm:flex-1" onClick={() => setShowForm(false)}>{t('common.cancel', 'Cancel')}</ButtonV2>
          </div>
        </div>
      )}

      {focusId && (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 flex flex-wrap items-center gap-2">
          {!loaded ? '…' : tabRows.length ? t('payments.focusOne', 'The payment from the Activity Log.') : t('payments.focusGone', 'That payment is not in your list — deleted, or outside your plants.')}
          <button type="button" className="font-semibold underline" onClick={() => focus.set({ payment: '' })}>{t('storereq.linkShowAll', 'Show all')}</button>
        </div>
      )}
      <SegmentTabs className="mb-3" value={tab} onChange={setTab}
        items={tabs.map(k => ({ key: k, label: k === 'all' ? t('payments.tabAll', 'All') : stageLabel(k), count: k === 'all' ? filtered.length : counts[k] }))} />

      {/* One filter bar: date range, company, payee source — same height, labels above. */}
      <div className="flex flex-wrap items-end gap-3 mb-3 max-sm:flex-col max-sm:items-stretch">
        <DateRangeFilter from={range.from} to={range.to} onChange={setRange} />
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-500 font-medium px-0.5">{t('payments.companyShort', 'Company')}</span>
          <select className={FILTER} value={companyFilter} onChange={e => setCompanyFilter(e.target.value as '' | BusyCompany)}>
            <option value="">{t('payments.allCompanies', 'All companies')}</option>
            {BUSY_COMPANIES.map(c => <option key={c.code} value={c.code}>{c.short}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-500 font-medium px-0.5">{t('payments.payeeSource', 'Payee')}</span>
          <select className={FILTER} value={sourceFilter} onChange={e => setSourceFilter(e.target.value as typeof sourceFilter)}>
            <option value="all">{t('payments.sourceAll', 'Busy and manual payees')}</option>
            <option value="busy">{t('payments.sourceBusy', 'Payee from Busy')}</option>
            <option value="manual">{t('payments.sourceManual', 'Not in Busy (exception)')}</option>
          </select>
        </label>
      </div>

      {!showForm && err && <p className="text-xs text-red-600 mb-3">{err}</p>}
      {/* Phones and tablets (below 1024px, where the sidebar leaves no room for the one-line table): one card per payment — date, payee, full amount, status, actions. */}
      <div className="lg:hidden flex flex-col gap-2" data-testid="payment-cards">
        {page.pageRows.map(r => {
          const info = rowInfo(r);
          const { s, tone, noBank } = info;
          return (
            <div key={r.id} className="rounded-xl border border-slate-200 p-3" data-testid="payment-card">
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="whitespace-nowrap">{formatDate(r.pay_date)}</span>
                <span className="truncate min-w-0" title={info.plantName}>{companyShort(r.company_code)}{info.plantName ? ` · ${info.plantName}` : ''}</span>
              </div>
              <div className="flex items-start justify-between gap-2 mt-1">
                <div className="min-w-0">
                  <div className="font-semibold text-[15px] leading-snug break-words">{r.beneficiary}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {payeeBadge(r)}
                    <span className="text-xs text-slate-500 truncate">{r.purpose || r.remarks || '—'}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold text-[16px] whitespace-nowrap" data-testid="payment-card-amount" title={String(r.amount)}>{fmtINRFull(r.amount)}</div>
                  <span className="badge whitespace-nowrap mt-1 inline-block" style={{ background: tone.bg, color: tone.color }}>{stageShort(s)}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs">
                {noBank
                  ? <span className="text-red-600 font-semibold">{t('payments.badgeMissingBank', 'Bank details missing')}</span>
                  : <span className="text-slate-400">{t('payments.acShort', 'A/c')} ··{(r.account_no || '').replace(/\s+/g, '').slice(-4)}</span>}
                {!noBank && r.ifsc && !isValidIfsc(r.ifsc) && <span className="text-red-600 font-semibold">{t('payments.badgeIfscShort', 'IFSC ✗')}</span>}
                {r.input_by && <span className="text-slate-400">{t('payments.inputByShort', 'Input by')}: {r.input_by}</span>}
              </div>
              <div className="mt-1">{statusNotes(r, s, info.seen, true)}</div>
              {info.editingBank
                ? <div className="mt-2 rounded-lg bg-slate-50 p-2">{bankEditor(r)}</div>
                : <div className="mt-2">{rowActions(r, info, true)}</div>}
            </div>
          );
        })}
        {page.pageRows.length === 0 && <div className="text-center text-slate-400 py-4 text-sm">{emptyText}</div>}
      </div>
      <div className="overflow-x-auto max-lg:hidden">
        {/* One line per payment: Date | Company | Beneficiary | A/c | Amount | Purpose | Input by | Status | Action. */}
        <table className="dt2 dt2-tight text-sm" style={{ tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th>{t('payments.date', 'Date')}</th>
              <th>{t('payments.companyShort', 'Company')}</th>
              <th>{t('payments.beneficiaryShort', 'Beneficiary')}</th>
              <th>{t('payments.acShort', 'A/c')}</th>
              <th className="num">{t('payments.amountShort', 'Amount')}</th>
              <th>{t('payments.purposeShort', 'Purpose')}</th>
              <th>{t('payments.inputByShort', 'Input by')}</th>
              <th>{t('payments.status', 'Status')}</th>
              <th>{t('payments.action', 'Action')}</th>
            </tr>
          </thead>
          <tbody>
            {page.pageRows.map(r => {
              const info = rowInfo(r);
              const { s, tone, noBank, editingBank, seen, plantName } = info;
              return (
                <React.Fragment key={r.id}>
                <tr className="align-top">
                  <td className="whitespace-nowrap">{formatDate(r.pay_date)}</td>
                  <td className="whitespace-nowrap" title={plantName}>{companyShort(r.company_code)}{plantName ? <span className="text-xs text-slate-400"> · {plantName}</span> : null}</td>
                  <td className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 max-w-[150px] min-[1400px]:max-w-[240px]">
                      <span className="font-medium truncate" title={r.beneficiary}>{r.beneficiary}</span>
                      {payeeBadge(r)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-xs" title={[r.account_no ? maskAccount(r.account_no) : '', r.ifsc, r.bank].filter(Boolean).join(' · ')}>
                    {noBank
                      ? <span className="text-red-600 font-semibold">{t('payments.badgeMissingBank', 'Bank details missing')}</span>
                      : <span className="text-slate-400">{(r.account_no || '').replace(/\s+/g, '').slice(-4)}</span>}
                    {/* Saved before the IFSC check: say so, so accounts fix it before Axis. */}
                    {!noBank && r.ifsc && !isValidIfsc(r.ifsc) && <div className="text-red-600 font-semibold" title={`${r.ifsc} — ${t('common.ifscInvalid', 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. UTIB0000123).')}`}>{t('payments.badgeIfscShort', 'IFSC ✗')}</div>}
                  </td>
                  <td className="num whitespace-nowrap font-semibold" title={String(r.amount)}>{fmtINRFull(r.amount)}</td>
                  <td className="max-w-[90px] truncate" title={[r.purpose, r.remarks].filter(Boolean).join(' · ')}>{r.purpose || r.remarks || '—'}</td>
                  <td className="max-w-[80px] truncate" title={r.input_by ?? ''}>{r.input_by}</td>
                  <td className="max-w-[130px]">
                    <span className="badge whitespace-nowrap" style={{ background: tone.bg, color: tone.color }} title={stageLabel(s)}>{stageShort(s)}</span>
                    {statusNotes(r, s, seen)}
                  </td>
                  <td className="max-w-[160px]">{rowActions(r, info)}</td>
                </tr>
                {editingBank && (
                  <tr>
                    <td colSpan={9} className="bg-slate-50">{bankEditor(r)}</td>
                  </tr>
                )}
                </React.Fragment>
              );
            })}
            {page.pageRows.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-4">{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <TablePagination controls={page.controls} />
    </div>
  );
}
