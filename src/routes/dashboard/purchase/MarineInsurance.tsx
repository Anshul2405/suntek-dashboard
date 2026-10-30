import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows } from '../../../lib/db';
import { useMentionNotifier } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, OcrUpload, PanelFooter, PanelDateInput } from '../../../components/SlidePanel';
import { KpiInfoButton } from '../../../components/KpiInfoButton';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState } from '../../../components/ui/states';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th } from '../../../components/v2';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import type { Database } from '../../../lib/database.types';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 } from '../../../components/v2';
import { formatDate, istToday, istFyStartYear } from '../../../lib/utils/formatting';

type Panel = 'topup' | 'ledger' | null;
type LedgerRow = Database['public']['Tables']['marine_insurance']['Row'];

export function MarineInsurance() {
  const { t } = useTranslation();
  const toast = useToast();
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const { scopeQuery } = usePlantScope();
  const [panel, setPanel] = useState<Panel>(null);
  const [saved, setSaved] = useState(false);
  const [ledgerFilter, setLedgerFilter] = useState<'all' | 'top-up' | 'deduct'>('all');
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const today = istToday();
  const [form, setForm] = useState({ amount: '', reference: '', date: today, mode: 'NEFT', notes: '' });

  async function load() {
    try {
      const { data, error } = await scopeQuery(supabase.from('marine_insurance').select('*'))
        .order('date', { ascending: false })
        // Same-day entries: the last one entered carries the running balance.
        .order('created_at', { ascending: false })
        .returns<LedgerRow[]>();
      if (error) throw error;
      setLedger(data || []);
      setLoadError(false);
    } catch (err) {
      console.error('[MarineInsurance] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentBalance = ledger.length > 0 ? ledger[0].balance : 0;
  // Every figure on the cards comes from the ledger (nothing typed into the page).
  const fyStart = `${istFyStartYear(istToday())}-04-01`;
  const monthStart = `${istToday().slice(0, 7)}-01`;
  const topUpsFy = ledger.filter(l => l.type === 'top_up' && l.date >= fyStart);
  const lastTopUp = topUpsFy.reduce<string | null>((d, l) => (!d || l.date > d ? l.date : d), null);
  const deductionsMtd = ledger.filter(l => l.type === 'deduction' && l.date >= monthStart);
  const avgDeduction = deductionsMtd.length ? deductionsMtd.reduce((sum, l) => sum + Math.abs(Number(l.amount)), 0) / deductionsMtd.length : null;
  const belowThreshold = ledger.length > 0 && currentBalance < 1;

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    if (!form.amount.trim()) return;
    const topUpAmt = parseFloat(form.amount) || 0;
    const newBal = currentBalance + topUpAmt;
    const { data, error } = await insertRows('marine_insurance', {
      date: form.date,
      type: 'top_up',
      reference: form.reference || null,
      amount: topUpAmt,
      balance: newBal,
    }).select('*').single();

    if (error) {
      toast.error(t('marine.saveFailed', { message: error.message }));
      return;
    }
    if (data) setLedger(prev => [data as LedgerRow, ...prev]);
    await notifyMentions(form.notes, {
      entityType: 'marine_insurance', entityId: (data as LedgerRow | undefined)?.id,
      entityLabel: t('marine.entityLabel', 'Marine insurance top-up'), route: '/dashboard/purchase/marine',
    });
    const hits = await screenBlacklist(
      [{ value: form.reference, label: t('marine.colReference') }, { value: form.notes, label: t('marine.notesLabel') }],
      { workflow: 'Marine Insurance', source: 'entry', entityLabel: t('marine.entityLabel', 'Marine insurance top-up') },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('marine.blacklistHit', { value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }
    setSaved(true);
    setTimeout(() => { setPanel(null); setSaved(false); setForm({ amount: '', reference: '', date: today, mode: 'NEFT', notes: '' }); }, 1600);
  }

  function handleClose() { setPanel(null); setSaved(false); }

  const newBalance = form.amount ? (currentBalance + parseFloat(form.amount || '0')).toFixed(2) : null;

  const ledgerList = ledger.filter(l =>
    ledgerFilter === 'all' ? true : ledgerFilter === 'top-up' ? l.type === 'top_up' : l.type === 'deduction'
  );
  // Full-ledger panel pages too; switching top-ups / deductions goes back to page 1.
  const { pageRows: ledgerListPage, controls: ledgerListPager } = usePagination(ledgerList, { resetKey: ledgerFilter });

  const lSort = useSortable(ledger, {
    date:      l => new Date(l.date),
    type:      l => l.type,
    reference: l => l.reference,
    amount:    l => l.amount,
    balance:   l => l.balance,
  }, { key: 'date', dir: 'desc' });
  // Paged — this list grows with use; page 1 again when the rows change.
  const { pageRows: pagedLedger, controls: ledgerPager } = usePagination(lSort.sorted, { resetKey: `ledger|${lSort.sort.key}|${lSort.sort.dir}` });

  return (
    <>
      {/* Balance + stats */}
      <div className="grid grid-cols-12 gap-5 mb-5">
        <div className="col-span-12 lg:col-span-6 card p-6" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Marine Insurance Balance', what: 'Running prepaid balance on the open marine insurance policy. Every supplier dispatch auto-deducts the insured value. Balance drops below ₹1 Cr triggers a top-up alert.', source: 'Form entry', formLabel: 'Top-up form', formPath: '/dashboard/purchase/marine', note: 'Top-ups logged manually via the "Top up" slide panel. Auto-deduction is applied per dispatch entry.' }} />
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs text-slate-500 mb-1">{t('marine.balanceLabel')}</div>
              <div className="text-3xl font-extrabold num">
                {ledger.length ? `₹ ${currentBalance.toFixed(2)} Cr` : '—'}
              </div>
            </div>
            <div className="w-12 h-12 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-12V4l-8-2-8 2v6c0 8 8 12 8 12z"/>
              </svg>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500 mt-3 mb-3">
            <span>{t('marine.threshold')} ₹1 Cr</span>
            <span className={`font-semibold ${belowThreshold ? 'text-red-600' : 'text-slate-700'}`}>
              {!ledger.length ? t('marine.noLedgerYet', 'No ledger entries yet')
                : belowThreshold ? t('marine.belowThreshold', 'Below the ₹1 Cr top-up line') : t('marine.aboveThreshold', 'Above the ₹1 Cr top-up line')}
            </span>
          </div>
          <div className="font-semibold text-sm">{t('marine.autoDeductLive')}</div>
          <div className="text-xs text-slate-500 mb-3">
            {t('marine.autoDeductHint')}
          </div>
          <div className="flex gap-2">
            <button className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm" onClick={() => setPanel('topup')}>
              {t('marine.topUp')}
            </button>
            <button className="btn-outline rounded-[10px] px-4 py-2 font-semibold text-sm" onClick={() => setPanel('ledger')}>
              {t('marine.viewLedger')}
            </button>
          </div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Marine Insurance Top-ups FY', what: 'Number of times the marine insurance prepaid balance has been topped up during the current financial year. Frequent top-ups may indicate high dispatch volume or underestimated policy size.', source: 'Form entry', formLabel: 'Top-up form', formPath: '/dashboard/purchase/marine' }} />
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('marine.topUpsThisFy')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{loading ? '…' : topUpsFy.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">{lastTopUp ? `${t('marine.lastOn')} ${formatDate(lastTopUp)}` : t('marine.noTopUpsFy', 'No top-ups this FY')}</div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5" style={{ position: 'relative' }}>
          <KpiInfoButton info={{ title: 'Avg Deduction per Dispatch', what: 'Average marine insurance amount deducted for each supplier dispatch this month. Calculated from total MTD deductions divided by dispatch count. Reflects average shipment insured value.', source: 'Form entry', formLabel: 'Dispatch log (auto-deduct)', formPath: '/dashboard/purchase/marine', note: 'Deductions come from MARINE_LEDGER entries with type "deduct".' }} />
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('marine.avgDeductionDispatch')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{loading ? '…' : avgDeduction != null ? `₹ ${avgDeduction.toFixed(2)} Cr` : '—'}</div>
          <div className="text-[11px] text-slate-500 mt-1">{deductionsMtd.length ? t('marine.dispatchesMtd', { count: deductionsMtd.length }) : t('marine.noDeductionsMtd', 'No deductions this month')}</div>
        </div>
      </div>

      {/* Ledger table */}
      <div className="card2 p-6" style={{ position: 'relative' }}>
        <KpiInfoButton info={{ title: 'Marine Insurance Ledger', what: 'Transaction history of the marine insurance prepaid balance — all top-ups (credits) and dispatch deductions (debits). Running balance is shown per row. New top-ups entered via the "Top up" slide panel; deductions are auto-logged per supplier dispatch.', source: 'Form entry', formLabel: 'Top-up / View ledger panel', formPath: '/dashboard/purchase/marine', note: 'Data from MARINE_LEDGER mock (mockData.ts). Future: Supabase marine_ledger table.' }} />
        <div className="text-base font-bold font-heading mb-3">{t('marine.recentLedger')}</div>
        {loadError ? (
          <ErrorState title={t('marine.loadErrorTitle')} message={t('marine.loadErrorMessage')}
            onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
        ) : loading ? (
          <SkeletonRows rows={6} />
        ) : (
        <>
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <Th sortKey="date" s={lSort} firstDir="desc">{t('marine.colDate')}</Th><Th sortKey="type" s={lSort}>{t('marine.colType')}</Th><Th sortKey="reference" s={lSort}>{t('marine.colReference')}</Th>
                  <Th sortKey="amount" s={lSort} firstDir="desc" className="num">{t('marine.colAmount')}</Th><Th sortKey="balance" s={lSort} firstDir="desc" className="num">{t('marine.colBalance')}</Th>
                </tr>
              </thead>
              <tbody>
                {pagedLedger.map((l, i) => (
                  <tr key={l.id || i}>
                    <td className="text-slate-500">{formatDate(l.date)}</td>
                    <td>
                      {l.type === 'top_up'
                        ? <span className="badge" style={{ background: '#DCFCE7', color: '#16A34A' }}>{t('marine.badgeTopUp')}</span>
                        : <span className="badge" style={{ background: '#FEE2E2', color: '#DC2626' }}>{t('marine.badgeDeduct')}</span>
                      }
                    </td>
                    <td>{l.reference || '—'}</td>
                    <td className="num font-semibold" style={{ color: l.amount > 0 ? '#16A34A' : '#DC2626' }}>
                      {l.amount > 0 ? '+' : ''}₹ {Math.abs(l.amount)} Cr
                    </td>
                    <td className="num">₹ {l.balance} Cr</td>
                  </tr>
                ))}
                {ledger.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-slate-400 py-6 text-sm">{t('marine.noLedgerEntries')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {lSort.sorted.length > 0 && <TablePaginationV2 controls={ledgerPager} label={t('marine.nounEntries', 'entries')} />}
        </>
        )}
      </div>

      {/* Top-up panel */}
      <SlidePanel open={panel === 'topup'} onClose={handleClose} title={t('marine.topUpPanelTitle')} subtitle={t('marine.topUpPanelSubtitle')}>
        <PanelField label={t('marine.topUpAmountLabel')}>
          <PanelInput type="number" step="0.01" placeholder={t('marine.topUpAmountPlaceholder', 'e.g. 0.50')} value={form.amount} onChange={e => set('amount', e.target.value)} />
        </PanelField>

        {newBalance && (
          <div style={{ margin: '-8px 0 16px', padding: '10px 14px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 12, fontSize: 13 }}>
            {t('marine.newBalanceAfter')} <strong>₹ {newBalance} Cr</strong>
          </div>
        )}

        <PanelRow>
          <PanelField label={t('marine.referenceLabel')}>
            <PanelInput placeholder={t('marine.referencePlaceholder', 'e.g. POL-2026-4421')} value={form.reference} onChange={e => set('reference', e.target.value)} />
          </PanelField>
          <PanelField label={t('marine.paymentModeLabel')}>
            <PanelSelect value={form.mode} onChange={e => set('mode', e.target.value)}>
              <option value="NEFT">NEFT</option>
              <option value="RTGS">RTGS</option>
              <option value="Cheque">{t('marine.modeCheque', 'Cheque')}</option>
              <option value="DD">DD</option>
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelField label={t('marine.dateLabel')}>
          <PanelDateInput value={form.date} onChange={e => set('date', e.target.value)} />
        </PanelField>

        <PanelField label={t('marine.notesLabel')}>
          <PanelTextarea placeholder={t('marine.notesPlaceholder')} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </PanelField>

        <PanelDivider />

        <OcrUpload
          label={t('marine.ocrLabel')}
          hint={t('marine.ocrHint')}
          fields={[
            { key: 'amount',    label: t('marine.ocrFieldAmount'),    value: '1,50,000' },
            { key: 'reference', label: t('marine.ocrFieldRef'),       value: 'NEFT2026060900123' },
            { key: 'mode',      label: t('marine.ocrFieldMode'),      value: 'NEFT' },
          ]}
          onExtracted={data => {
            if (data.amount)    set('amount',    data.amount);
            if (data.reference) set('reference', data.reference);
            if (data.mode)      set('mode',      data.mode);
          }}
        />

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('marine.recordTopUp')}
          successLabel={t('marine.topUpRecorded')}
          successSub={t('marine.topUpRecordedSub')}
          disabled={!form.amount.trim()}
          requiredHint={t('marine.requiredHint')}
        />
      </SlidePanel>

      {/* Ledger view panel */}
      <SlidePanel open={panel === 'ledger'} onClose={handleClose} title={t('marine.fullLedgerTitle')} subtitle={t('marine.fullLedgerSubtitle')}>
        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['all', 'top-up', 'deduct'] as const).map(f => (
            <button
              key={f}
              onClick={() => setLedgerFilter(f === 'top-up' ? 'top-up' : f === 'deduct' ? 'deduct' : 'all')}
              style={{
                padding: '6px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                border: '1px solid',
                borderColor: ledgerFilter === f ? '#F47651' : '#E2E8F0',
                background: ledgerFilter === f ? '#FFF0EB' : '#F8FAFC',
                color: ledgerFilter === f ? '#F47651' : '#475569',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {f === 'all' ? t('marine.filterAll') : f === 'top-up' ? t('marine.filterTopUps') : t('marine.filterDeductions')}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94A3B8', alignSelf: 'center' }}>
            {t('marine.entriesCount', { count: ledgerList.length })}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ledgerListPage.map((l, i) => (
            <div key={l.id || i} style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid #F1F5F9', background: '#FAFAFA', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: l.type === 'top_up' ? '#16A34A' : '#DC2626',
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{l.reference || '—'}</div>
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{formatDate(l.date)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: l.amount > 0 ? '#16A34A' : '#DC2626' }}>
                  {l.amount > 0 ? '+' : ''}₹ {Math.abs(l.amount)} Cr
                </div>
                <div style={{ fontSize: 11, color: '#94A3B8' }}>{t('marine.balShort')} ₹ {l.balance} Cr</div>
              </div>
            </div>
          ))}
          {ledgerList.length === 0 && (
            <div style={{ textAlign: 'center', color: '#94A3B8', padding: '24px 0', fontSize: 13 }}>{t('marine.noEntries')}</div>
          )}
        </div>
        {ledgerList.length > 0 && <TablePaginationV2 controls={ledgerListPager} label={t('marine.nounEntries', 'entries')} />}
      </SlidePanel>
    </>
  );
}
