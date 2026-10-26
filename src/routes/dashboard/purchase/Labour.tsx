import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { SlidePanel, PanelField, PanelInput, PanelTextarea, PanelDivider, PanelFooter } from '../../../components/SlidePanel';
import { SkeletonRows, ErrorState } from '../../../components/ui/states';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th } from '../../../components/v2';
import { useMentionNotifier } from '../../../lib/mentions';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { withEmbedFallback } from '../../../lib/scopedList';
import type { Database } from '../../../lib/database.types';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 } from '../../../components/v2';

type LabourRow = Database['public']['Tables']['labour_costs']['Row'] & { plants?: { name: string | null } | null };

export function Labour() {
  const { t } = useTranslation();
  const { scopeQuery } = usePlantScope();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [costs, setCosts] = useState<LabourRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState({ baseRate: '1487', targetRate: '1450', overhead: '12', transport: '85', reason: '' });
  const notifyMentions = useMentionNotifier();

  async function load() {
    try {
      const { data, error } = await withEmbedFallback(
        scopeQuery(supabase.from('labour_costs').select('*, plants(name)')).order('date', { ascending: false }).returns<LabourRow[]>(),
        () => scopeQuery(supabase.from('labour_costs').select('*')).order('date', { ascending: false }).returns<LabourRow[]>(),
        'Labour.costs',
      );
      if (error) throw error;
      setCosts(data || []);
      setLoadError(false);
    } catch (err) {
      console.error('[Labour] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    await notifyMentions(form.reason, { entityLabel: t('labour.entityLabel', 'Labour rate update'), route: '/dashboard/purchase/labour' });
    setSaved(true);
    setTimeout(() => { setOpen(false); setSaved(false); }, 1600);
  }

  function handleClose() { setOpen(false); setSaved(false); }

  const totalCost = costs.reduce((s, c) => s + (c.computed_cost || 0), 0);
  const flaggedCount = costs.filter(c => c.is_flagged).length;

  const cSort = useSortable(costs, {
    plant:        c => c.plants?.name ?? '',
    date:         c => new Date(c.date),
    purchaseQty:  c => c.purchased_qty,
    salesQty:     c => c.sales_qty,
    computedCost: c => c.computed_cost ?? 0,
    targetCost:   c => c.target_cost ?? 0,
    perMt:        c => c.per_mt_cost ?? 0,
    variance:     c => c.variance_pct ?? 0,
    flag:         c => (c.is_flagged ? 1 : 0),
  }, { key: 'date', dir: 'desc' });
  // Paged — this list grows with use; page 1 again when the rows change.
  const { pageRows: pagedCosts, controls: costPager } = usePagination(cSort.sorted, { resetKey: `labour|${cSort.sort.key}|${cSort.sort.dir}` });

  return (
    <>
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-5 mb-5">
        <div className="col-span-12 lg:col-span-3 card p-5">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('labour.kpiTotalCost')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">
            {totalCost > 0 ? `₹ ${totalCost.toLocaleString('en-IN')}` : '—'}
          </div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('labour.kpiRecords')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">{costs.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">{t('labour.kpiRecordsSub')}</div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('labour.kpiAvgPerMt')}</div>
          <div className="text-[28px] font-extrabold mt-1 num">
            {costs.length > 0
              ? `₹ ${Math.round(costs.reduce((s, c) => s + (c.per_mt_cost || 0), 0) / costs.length).toLocaleString('en-IN')}`
              : '—'}
          </div>
        </div>
        <div className="col-span-12 lg:col-span-3 card p-5">
          <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('labour.kpiVarianceFlagged')}</div>
          <div className={`text-[28px] font-extrabold mt-1 num ${flaggedCount > 0 ? 'text-amber-600' : ''}`}>
            {t('labour.plantCount', { count: flaggedCount })}
          </div>
        </div>
      </div>

      {/* Per-plant table — green-soft */}
      <div className="card2 p-6 mb-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-base font-bold font-heading">{t('labour.logTitle')}</div>
            <div className="text-xs text-slate-500">
              {t('labour.logSubtitle')}
            </div>
          </div>
          <button className="btn-outline rounded-[10px] px-3 py-2 text-xs font-semibold" onClick={() => setOpen(true)}>
            {t('labour.editFormula')}
          </button>
        </div>
        {loadError ? (
          <ErrorState title={t('labour.loadErrorTitle')} message={t('labour.loadErrorMessage')}
            onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
        ) : loading ? (
          <SkeletonRows rows={5} />
        ) : (
        <>
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <Th sortKey="plant" s={cSort}>{t('labour.colPlant')}</Th>
                  <Th sortKey="date" s={cSort} firstDir="desc">{t('labour.colDate')}</Th>
                  <Th sortKey="purchaseQty" s={cSort} firstDir="desc" className="num">{t('labour.colPurchaseQty')}</Th>
                  <Th sortKey="salesQty" s={cSort} firstDir="desc" className="num">{t('labour.colSalesQty')}</Th>
                  <Th sortKey="computedCost" s={cSort} firstDir="desc" className="num">{t('labour.colComputedCost')}</Th>
                  <Th sortKey="targetCost" s={cSort} firstDir="desc" className="num">{t('labour.colTargetCost')}</Th>
                  <Th sortKey="perMt" s={cSort} firstDir="desc" className="num">{t('labour.colPerMt')}</Th>
                  <Th sortKey="variance" s={cSort} firstDir="desc">{t('labour.colVariance')}</Th>
                  <Th sortKey="flag" s={cSort} firstDir="desc">{t('labour.colFlag')}</Th>
                </tr>
              </thead>
              <tbody>
                {pagedCosts.map(c => {
                  const vPct = c.variance_pct || 0;
                  const tColor = vPct > 0 ? '#D97706' : vPct < 0 ? '#16A34A' : '#475569';
                  const tBg    = vPct > 0 ? '#FEF3C7' : vPct < 0 ? '#DCFCE7' : '#F1F5F9';
                  const tLbl   = vPct > 0 ? t('labour.varianceOver', { pct: vPct.toFixed(1) }) : vPct < 0 ? t('labour.varianceUnder', { pct: Math.abs(vPct).toFixed(1) }) : t('labour.onTarget');
                  return (
                    <tr key={c.id} style={{ cursor: 'pointer' }}>
                      <td className="font-semibold">{c.plants?.name || '—'}</td>
                      <td className="text-slate-500 text-xs">{c.date}</td>
                      <td className="num text-slate-500">{c.purchased_qty ?? '—'}</td>
                      <td className="num text-slate-500">{c.sales_qty ?? '—'}</td>
                      <td className="num font-bold">₹ {(c.computed_cost || 0).toLocaleString('en-IN')}</td>
                      <td className="num text-slate-500">₹ {(c.target_cost || 0).toLocaleString('en-IN')}</td>
                      <td className="num">₹ {(c.per_mt_cost || 0).toLocaleString('en-IN')}</td>
                      <td>
                        <span className="badge" style={{ background: tBg, color: tColor }}>{tLbl}</span>
                      </td>
                      <td>{c.is_flagged ? <span className="badge" style={{ background: '#FEE2E2', color: '#DC2626' }}>{t('labour.flagBadge')}</span> : '—'}</td>
                    </tr>
                  );
                })}
                {costs.length === 0 && (
                  <tr><td colSpan={9} className="text-center text-slate-400 py-6 text-sm">{t('labour.emptyState')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {cSort.sorted.length > 0 && <TablePaginationV2 controls={costPager} label={t('labour.nounEntries', 'entries')} />}
        </>
        )}
      </div>

      {/* Slide panel */}
      <SlidePanel open={open} onClose={handleClose} title={t('labour.panelTitle')} subtitle={t('labour.panelSubtitle')}>
        <div style={{ padding: '12px 14px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 12, marginBottom: 20, fontSize: 12, color: '#475569', lineHeight: 1.6 }}>
          <strong>{t('labour.currentFormulaLabel')}</strong><br />
          {t('labour.currentFormula')}
        </div>

        <PanelField label={t('labour.fieldBaseRate')}>
          <PanelInput type="number" value={form.baseRate} onChange={e => set('baseRate', e.target.value)} />
        </PanelField>

        <PanelField label={t('labour.fieldTargetRate')}>
          <PanelInput type="number" value={form.targetRate} onChange={e => set('targetRate', e.target.value)} />
        </PanelField>

        <PanelField label={t('labour.fieldOverhead')}>
          <PanelInput type="number" value={form.overhead} onChange={e => set('overhead', e.target.value)} />
        </PanelField>

        <PanelField label={t('labour.fieldTransport')}>
          <PanelInput type="number" value={form.transport} onChange={e => set('transport', e.target.value)} />
        </PanelField>

        <PanelDivider />

        {form.baseRate && form.targetRate && (
          <div style={{ padding: '12px 14px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 12, marginBottom: 20, fontSize: 13 }}>
            {t('labour.preview', { base: parseInt(form.baseRate).toLocaleString('en-IN'), target: parseInt(form.targetRate).toLocaleString('en-IN'), variance: Math.abs(parseInt(form.baseRate) - parseInt(form.targetRate)) })}
          </div>
        )}

        <PanelField label={t('labour.fieldReason')}>
          <PanelTextarea placeholder={t('labour.reasonPlaceholder')} value={form.reason} onChange={e => set('reason', e.target.value)} />
        </PanelField>

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('labour.saveFormula')}
          successLabel={t('labour.formulaUpdated')}
          successSub={t('labour.formulaUpdatedSub')}
        />
      </SlidePanel>
    </>
  );
}
