import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { useToast } from '../../../components/ui/toast';
import { useRoleContext } from '../../../contexts/RoleContext';
import { isAdminProfile } from '../../../lib/profiles';
import { fmtINR } from '../../../hooks/useBusyData';
import { ButtonV2 } from '../../../components/v2';
import type { Database } from '../../../lib/database.types';

type PayRow = Database['public']['Tables']['other_payments']['Row'];
type Kind = PayRow['kind'];
type Status = PayRow['status'];

const KINDS: Kind[] = ['freight', 'service', 'bill', 'advance', 'other'];

const TONE: Record<Status, { bg: string; color: string; label: string }> = {
  requested: { bg: '#FEF9C3', color: '#A16207', label: 'Requested' },
  approved: { bg: '#DCFCE7', color: '#15803D', label: 'Approved' },
  paid: { bg: '#DBEAFE', color: '#1D4ED8', label: 'Paid' },
};

function roleId(id: string, base?: string) {
  return base || id;
}

export function OtherPayments() {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const role = roleId(activeProfile.id, activeProfile.baseRoleId);
  const admin = isAdminProfile(activeProfile);
  const canRequest = admin || role === 'purchase_manager' || role === 'management';
  const canApprove = admin || role === 'management';
  const canPay = admin || role === 'accountant_delhi' || role === 'accountant_other';
  const [rows, setRows] = useState<PayRow[]>([]);
  const [form, setForm] = useState({ kind: 'freight' as Kind, payee: '', amount: '', note: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, error } = await supabase.from('other_payments').select('*').order('created_at', { ascending: false }).returns<PayRow[]>();
    if (!error && data) setRows(data);
  }

  useEffect(() => { void load(); }, []);

  async function notify(roles: string[], title: string, body: string) {
    await insertRows('notifications', {
      target_roles: roles,
      title,
      body,
      type: 'info',
      route: '/dashboard/purchase/book?tab=payments',
      actor_name: activeProfile.name,
      actor_role: role,
      read_by: [],
    });
  }

  async function requestPay() {
    const amount = Number(form.amount);
    if (!form.payee.trim() || !Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    try {
      const { data, error } = await insertRows('other_payments', {
        kind: form.kind,
        payee: form.payee.trim(),
        amount,
        note: form.note.trim() || null,
        status: 'requested',
        requested_by: activeProfile.name,
      }).select('*').single();
      if (error) { toast.error(error.message); return; }
      if (data) setRows(prev => [data as PayRow, ...prev]);
      await notify(
        ['management', 'admin'],
        t('pay.requestedTitle', 'Payment requested: {{payee}}', { payee: form.payee.trim() }),
        `${form.kind} · ${fmtINR(amount)}`,
      );
      setForm({ kind: 'freight', payee: '', amount: '', note: '' });
      toast.success(t('pay.requestedOk', 'Marked yellow. Management has been asked to approve.'));
    } finally { setBusy(false); }
  }

  async function setStatus(row: PayRow, status: Status) {
    setBusy(true);
    try {
      const patch = status === 'approved'
        ? { status, approved_by: activeProfile.name, approved_at: new Date().toISOString() }
        : { status, paid_by: activeProfile.name, paid_at: new Date().toISOString() };
      const { error } = await updateRows('other_payments', patch).eq('id', row.id);
      if (error) { toast.error(error.message); return; }
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, ...patch } : r));
      if (status === 'approved') {
        await notify(['accountant_delhi', 'accountant_other', 'admin'], t('pay.approvedTitle', 'Payment approved: {{payee}}', { payee: row.payee }), fmtINR(Number(row.amount)));
        toast.success(t('pay.approvedOk', 'Marked green. Accounts can pay it.'));
      } else {
        await notify(['purchase_manager', 'admin'], t('pay.paidTitle', 'Payment made: {{payee}}', { payee: row.payee }), fmtINR(Number(row.amount)));
        toast.success(t('pay.paidOk', 'Marked blue. The payment is done.'));
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="card2 p-4 mb-4">
      <div className="text-sm font-bold mb-1">{t('pay.title', 'Payments other than raw material')}</div>
      <p className="text-xs text-slate-500 mb-3">{t('pay.hint', 'Freight, services, bills and advances. Yellow when requested, green when management approves, blue when accounts pays.')}</p>
      {canRequest && (
        <div className="flex flex-wrap gap-2 mb-4 items-end">
          <label className="text-xs text-slate-600">
            {t('pay.kind', 'Type')}
            <select className="block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value as Kind }))}>
              {KINDS.map(k => <option key={k} value={k}>{t(`pay.kind_${k}`, k)}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            {t('pay.payee', 'Payee')}
            <input className="block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" value={form.payee} onChange={e => setForm(f => ({ ...f, payee: e.target.value }))} />
          </label>
          <label className="text-xs text-slate-600">
            {t('pay.amount', 'Amount')}
            <input className="block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-32" inputMode="decimal" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
          </label>
          <label className="text-xs text-slate-600 flex-1 min-w-[160px]">
            {t('pay.note', 'Note')}
            <input className="block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-full" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </label>
          <ButtonV2 variant="primary" disabled={busy || !form.payee.trim() || !form.amount} onClick={() => void requestPay()}>
            {t('pay.request', 'Request payment')}
          </ButtonV2>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="dt2 text-sm">
          <thead>
            <tr>
              <th>{t('pay.kind', 'Type')}</th>
              <th>{t('pay.payee', 'Payee')}</th>
              <th className="num">{t('pay.amount', 'Amount')}</th>
              <th>{t('pay.status', 'Status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="text-center text-slate-400 py-4">{t('pay.empty', 'No other payments yet.')}</td></tr>}
            {rows.map(row => {
              const tone = TONE[row.status] || TONE.requested;
              return (
                <tr key={row.id}>
                  <td>{t(`pay.kind_${row.kind}`, row.kind)}</td>
                  <td>{row.payee}{row.note ? <div className="text-xs text-slate-400">{row.note}</div> : null}</td>
                  <td className="num">{fmtINR(Number(row.amount))}</td>
                  <td><span className="badge" style={{ background: tone.bg, color: tone.color }}>{t(`pay.status_${row.status}`, tone.label)}</span></td>
                  <td>
                    {row.status === 'requested' && canApprove && (
                      <button type="button" className="text-xs font-bold text-emerald-700" disabled={busy} onClick={() => void setStatus(row, 'approved')}>{t('pay.approve', 'Approve')}</button>
                    )}
                    {row.status === 'approved' && canPay && (
                      <button type="button" className="text-xs font-bold text-blue-700" disabled={busy} onClick={() => void setStatus(row, 'paid')}>{t('pay.markPaid', 'Mark paid')}</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
