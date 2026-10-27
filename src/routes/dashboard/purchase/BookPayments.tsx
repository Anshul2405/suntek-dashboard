import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { useToast } from '../../../components/ui/toast';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { isAdminProfile } from '../../../lib/profiles';
import { useColumnLive } from '../../../lib/schemaProbe';
import { fmtINR, useRecentMovements } from '../../../hooks/useBusyData';
import { formatDate, istToday } from '../../../lib/utils/formatting';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination, ButtonV2 } from '../../../components/v2';
import { findBusyPayment, maskAccount, type PaymentRow, type PaymentStatus } from '../../../lib/payments';

const input = 'block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-full';
const label = 'text-xs text-slate-600 min-w-0';

const BLANK = { pay_date: '', beneficiary: '', account_no: '', amount: '', ifsc: '', bank: '', remarks: '', plant_id: '' };

const TONE: Record<PaymentStatus, { bg: string; color: string }> = {
  entered: { bg: '#FEF9C3', color: '#A16207' },
  input_done: { bg: '#FFEDD5', color: '#C2410C' },
  payment_done: { bg: '#DBEAFE', color: '#1D4ED8' },
  busy_done: { bg: '#DCFCE7', color: '#15803D' },
};

/**
 * Live payments — a separate list, not on any ticket. Entered with the
 * inputter's name; Delhi office marks Input done (Axis); management marks
 * Payment done; the Busy tick is read from the Busy feed (never written back).
 * Needs purchase_payments (migration 0038); until then it says so and the
 * workbook Payments sheet below stays the record.
 */
export function BookPayments() {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const { allowedPlants, ready, isGlobal, scopeQuery, plants } = usePlantScope();
  const live = useColumnLive('purchase_payments', 'id');
  const admin = isAdminProfile(activeProfile);
  const role = activeProfile.baseRoleId || activeProfile.id;
  const canInput = admin || role === 'accountant_delhi';
  const canPay = admin || role === 'management';
  const pickerPlants = plantsForPicker(allowedPlants, ready);
  // Every company: this tab has no company picker, and a payment may be booked in any of them.
  const { data: feed } = useRecentMovements(3, 'all');

  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!live || !ready) return;
    let alive = true;
    void scopeQuery(supabase.from('purchase_payments').select('*'))
      .order('pay_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
      .returns<PaymentRow[]>()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) setErr(error.message);
        setRows(data ?? []);
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [live, ready, scopeQuery]);

  const busyMatch = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.status !== 'payment_done') continue;
      const hit = findBusyPayment(r, feed ?? []);
      if (hit) m.set(r.id, hit.sub);
    }
    return m;
  }, [rows, feed]);

  const page = usePagination(rows);
  const amount = Number(form.amount);
  const canSave = !!form.pay_date && !!form.beneficiary.trim() && Number.isFinite(amount) && amount > 0
    && (isGlobal || !!form.plant_id);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const { data, error } = await insertRows('purchase_payments', {
        pay_date: form.pay_date,
        beneficiary: form.beneficiary.trim(),
        account_no: form.account_no.replace(/\s+/g, '') || null,
        ifsc: form.ifsc.trim().toUpperCase() || null,
        bank: form.bank.trim() || null,
        amount,
        remarks: form.remarks.trim() || null,
        input_by: activeProfile.name,
        plant_id: form.plant_id || null,
      }).select('*').single();
      if (error) { setErr(error.message); return; }
      if (data) setRows(prev => [data as PaymentRow, ...prev]);
      setShowForm(false);
      setForm(BLANK);
      toast.success(t('payments.savedOk', 'Payment entered. Delhi office marks Input done once it is keyed into Axis.'));
    } finally {
      setBusy(false);
    }
  }

  async function advance(row: PaymentRow, next: 'input_done' | 'payment_done') {
    setBusy(true);
    try {
      const at = new Date().toISOString();
      const patch = next === 'input_done'
        ? { status: next, input_done_by: activeProfile.name, input_done_at: at }
        : { status: next, payment_done_by: activeProfile.name, payment_done_at: at };
      const { error } = await updateRows('purchase_payments', patch).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...patch } : r)));
    } finally {
      setBusy(false);
    }
  }

  const statusText = (r: PaymentRow) => {
    if (r.status === 'busy_done' || busyMatch.has(r.id)) return t('payments.statusBusy', 'Done in Busy ✓');
    return ({
      entered: t('payments.statusEntered', 'Entered'),
      input_done: t('payments.statusInput', 'Input done (Axis)'),
      payment_done: t('payments.statusPaid', 'Payment done · waiting for Busy'),
      busy_done: t('payments.statusBusy', 'Done in Busy ✓'),
    } as Record<PaymentStatus, string>)[r.status];
  };

  if (!live) {
    return (
      <div className="card2 p-4 mb-4">
        <div className="text-sm font-bold mb-1">{t('payments.title', 'Payments — live')}</div>
        <p className="text-xs text-slate-500">{t('payments.notApplied', 'The live payments table is not applied yet (migration 0038_dispatch_payments_vijay.sql). Until it is, nothing can be entered here; the workbook Payments sheet below is the record.')}</p>
      </div>
    );
  }

  return (
    <div className="card2 p-4 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-bold">{t('payments.title', 'Payments — live')}</div>
          <p className="text-xs text-slate-500 mt-0.5">{t('payments.hint', 'Entered here → Delhi office marks Input done (Axis) → management marks Payment done → ticked Done when the payment shows in Busy. Busy is only read, never written.')}</p>
        </div>
        {!showForm && (
          <ButtonV2 variant="primary" onClick={() => { setForm({ ...BLANK, pay_date: istToday(), plant_id: pickerPlants.length === 1 ? pickerPlants[0].id : '' }); setErr(null); setShowForm(true); }}>
            {t('payments.add', 'New payment')}
          </ButtonV2>
        )}
      </div>

      {showForm && (
        <div className="border border-slate-200 rounded-xl p-3 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className={label}>{t('payments.date', 'Date')}
              <input type="date" className={input} value={form.pay_date} max={istToday()} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))} />
            </label>
            <label className={`${label} lg:col-span-2`}>{t('payments.beneficiary', 'Beneficiary name')}
              <input className={input} value={form.beneficiary} onChange={e => setForm(f => ({ ...f, beneficiary: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.amount', 'Amount (₹)')}
              <input className={input} inputMode="decimal" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.account', 'A/c number')}
              <input className={input} inputMode="numeric" autoComplete="off" value={form.account_no} onChange={e => setForm(f => ({ ...f, account_no: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.ifsc', 'IFSC')}
              <input className={input} autoComplete="off" value={form.ifsc} onChange={e => setForm(f => ({ ...f, ifsc: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.bank', 'Bank')}
              <input className={input} value={form.bank} onChange={e => setForm(f => ({ ...f, bank: e.target.value }))} />
            </label>
            <label className={label}>{t('payments.plant', 'Plant')}
              <select className={input} value={form.plant_id} onChange={e => setForm(f => ({ ...f, plant_id: e.target.value }))}>
                <option value="">{isGlobal ? t('payments.noPlant', 'Head office / none') : t('payments.pickPlant', 'Pick a plant…')}</option>
                {pickerPlants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className={`${label} sm:col-span-2 lg:col-span-4`}>{t('payments.remarks', 'Remarks')}
              <input className={input} value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
            </label>
          </div>
          <p className="text-xs text-slate-500 mt-2">{t('payments.inputBy', { defaultValue: 'Input by {{name}}', name: activeProfile.name })}</p>
          {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
          <div className="flex gap-2 mt-3">
            <ButtonV2 variant="primary" disabled={!canSave || busy} onClick={() => void save()}>{t('payments.save', 'Save payment')}</ButtonV2>
            <ButtonV2 onClick={() => setShowForm(false)}>{t('common.cancel', 'Cancel')}</ButtonV2>
          </div>
        </div>
      )}

      {!showForm && err && <p className="text-xs text-red-600 mb-3">{err}</p>}
      <div className="overflow-x-auto">
        <table className="dt2 text-sm">
          <thead>
            <tr>
              <th>{t('payments.date', 'Date')}</th>
              <th>{t('payments.beneficiaryShort', 'Beneficiary')}</th>
              <th className="num">{t('payments.amountShort', 'Amount')}</th>
              <th>{t('payments.bankShort', 'Bank / IFSC')}</th>
              <th>{t('payments.remarks', 'Remarks')}</th>
              <th>{t('payments.inputByShort', 'Input by')}</th>
              <th>{t('payments.status', 'Status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {page.pageRows.map(r => {
              const tone = TONE[busyMatch.has(r.id) ? 'busy_done' : r.status] ?? TONE.entered;
              return (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{formatDate(r.pay_date)}</td>
                  <td>{r.beneficiary}{r.account_no ? <div className="text-xs text-slate-400">{t('payments.acShort', 'A/c')} {maskAccount(r.account_no)}</div> : null}{r.plant_id ? <div className="text-xs text-slate-400">{plants.find(p => p.id === r.plant_id)?.name}</div> : null}</td>
                  <td className="num whitespace-nowrap">{fmtINR(Number(r.amount))}</td>
                  <td>{[r.bank, r.ifsc].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{r.remarks || '—'}</td>
                  <td>{r.input_by}</td>
                  <td>
                    <span className="badge" style={{ background: tone.bg, color: tone.color }}>{statusText(r)}</span>
                    {busyMatch.has(r.id) && <div className="text-xs text-slate-400">{busyMatch.get(r.id)}</div>}
                  </td>
                  <td className="whitespace-nowrap">
                    {r.status === 'entered' && canInput && (
                      <button type="button" className="text-xs font-bold text-orange-700" disabled={busy} onClick={() => void advance(r, 'input_done')}>{t('payments.markInput', 'Input done (Axis)')}</button>
                    )}
                    {r.status === 'input_done' && canPay && (
                      <button type="button" className="text-xs font-bold text-blue-700" disabled={busy} onClick={() => void advance(r, 'payment_done')}>{t('payments.markPaid', 'Payment done')}</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {page.pageRows.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-4">{loaded ? t('payments.empty', 'No live payments yet.') : '…'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <TablePagination controls={page.controls} />
    </div>
  );
}
