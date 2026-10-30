import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IndianRupee, Wallet, Boxes } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useQuery } from '@tanstack/react-query';
import { SkeletonRows, ErrorState, EmptyState } from '../../components/ui/states';
import { KpiInfoButton } from '../../components/KpiInfoButton';
import { useSortable } from '../../components/ui/useSortable';
import { StatCard, SectionCard, ThV2 as Th } from '../../components/v2';
import { computeBatchCost, DEFAULT_COST_CONFIG, type CostConfig } from '../../lib/algorithms/costEngine';
import type { Database } from '../../lib/database.types';
import { displayLocationName } from '../../lib/plantLabels';

type BatchRow = Database['public']['Tables']['active_batches']['Row'] & { plants?: { name: string | null } | null };

const KG_PER_DRUM = 240;
const MT_PER_DRUM = KG_PER_DRUM / 1000;

const RATE_FIELDS: { key: keyof CostConfig; label: string; suffix: string }[] = [
  { key: 'paraffinRatePerKg', label: 'Paraffin (NP)', suffix: '₹/kg' },
  { key: 'cl2RatePerMT',      label: 'Chlorine (Cl₂)', suffix: '₹/MT' },
  { key: 'energyRatePerHour', label: 'Energy',         suffix: '₹/reactor-hr' },
  { key: 'labourPerMT',       label: 'Labour',         suffix: '₹/MT' },
  { key: 'overheadPct',       label: 'Overhead',       suffix: '%' },
];

function fmtINR(v: number): string {
  return `₹ ${Math.round(v).toLocaleString('en-IN')}`;
}

export function CostIntelligence() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<CostConfig>({ ...DEFAULT_COST_CONFIG });
  // Plant-scoped (fail-closed): a user sees batches of their own plants only.
  const { scopeQuery, ready: scopeReady, plantIds, isGlobal } = usePlantScope();
  const scopeKey = isGlobal ? 'all' : plantIds.join(',');

  const { data, isLoading, isError, refetch } = useQuery<BatchRow[]>({
    queryKey: ['cost-closed-batches', scopeKey],
    enabled: scopeReady,
    queryFn: async () => {
      const { data, error } = await scopeQuery(supabase
        .from('active_batches')
        .select('*, plants(name)'))
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .returns<BatchRow[]>();
      if (error) throw error;
      return data ?? [];
    },
  });

  const costed = useMemo(() => {
    return (data ?? []).map(b => {
      const outputMT = (b.total_drums ?? 0) * MT_PER_DRUM;
      const reactorHours = b.started_at && b.closed_at
        ? Math.max(0, (new Date(b.closed_at).getTime() - new Date(b.started_at).getTime()) / 3.6e6)
        : 0;
      const cost = computeBatchCost({
        paraffinWeightKg: b.paraffin_weight ?? 0,
        cl2QtyMT: b.hcl_quantity ?? 0, // proxy: HCL output tracks Cl2 consumption until a dedicated column lands
        reactorHours,
        outputMT,
      }, config);
      return { batch: b, outputMT, reactorHours, cost };
    });
  }, [data, config]);

  const summary = useMemo(() => {
    const withOutput = costed.filter(c => c.outputMT > 0);
    const totalLanded = costed.reduce((s, c) => s + c.cost.landedCost, 0);
    const avgPerMT = withOutput.length
      ? withOutput.reduce((s, c) => s + c.cost.costPerMT, 0) / withOutput.length
      : 0;
    return { totalLanded, avgPerMT, count: costed.length };
  }, [costed]);

  const cSort = useSortable(costed, {
    batch:     c => c.batch.batch_no,
    plant:     c => c.batch.plants?.name ?? '',
    output:    c => c.outputMT,
    reactor:   c => c.reactorHours,
    material:  c => c.cost.materialCost,
    labour:    c => c.cost.labourCost,
    energy:    c => c.cost.energyCost,
    overhead:  c => c.cost.overheadCost,
    landed:    c => c.cost.landedCost,
    costPerMT: c => c.cost.costPerMT,
  });

  function setRate(key: keyof CostConfig, value: string) {
    const n = parseFloat(value);
    setConfig(c => ({ ...c, [key]: Number.isFinite(n) ? n : 0 }));
  }

  return (
    <>
      {/* KPIs */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-6 lg:col-span-4 relative">
          <KpiInfoButton info={{ title: 'Avg landed cost / MT', what: 'Mean true landed cost per MT across closed batches — material + labour + energy + overhead. The foundation for margin and pricing checks.', source: 'Derived', note: 'computeBatchCost() over closed active_batches with the rates set on the right.' }} />
          <StatCard className="h-full" icon={<IndianRupee />} tone="blue"
            label={t('costIntel.kpiAvgLanded')}
            value={summary.avgPerMT > 0 ? fmtINR(summary.avgPerMT) : '—'}
            caption={t('costIntel.kpiAvgLandedSub')} />
        </div>
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-4" icon={<Wallet />}
          label={t('costIntel.kpiTotalLanded')}
          value={summary.totalLanded > 0 ? fmtINR(summary.totalLanded) : '—'}
          caption={t('costIntel.kpiTotalLandedSub')} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-4" icon={<Boxes />} tone="green"
          label={t('costIntel.kpiBatchesCosted')}
          value={summary.count}
          caption={t('costIntel.kpiBatchesCostedSub')} />
      </div>

      {/* Rate config */}
      <SectionCard className="mb-4" title={t('costIntel.costRatesTitle')} subtitle={t('costIntel.costRatesSub')}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {RATE_FIELDS.map(f => (
            <div key={f.key}>
              <div className="text-[11px] font-semibold text-slate-500 mb-1">{t(`costIntel.rate_${f.key}`)} <span className="text-slate-400">({f.suffix})</span></div>
              <input
                type="number"
                value={config[f.key]}
                onChange={e => setRate(f.key, e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-[10px] text-[13px] focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-300 transition"
              />
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Per-batch table */}
      <SectionCard flush title={t('costIntel.tableTitle')}>
        {isLoading ? (
          <div className="px-5 pb-5"><SkeletonRows rows={6} /></div>
        ) : isError ? (
          <div className="px-5 pb-5"><ErrorState title={t('costIntel.errorLoad')} onRetry={() => refetch()} /></div>
        ) : costed.length === 0 ? (
          <div className="px-5 pb-5"><EmptyState title={t('costIntel.emptyTitle')} message={t('costIntel.emptyMessage')} /></div>
        ) : (
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <Th sortKey="batch" s={cSort}>{t('costIntel.colBatch')}</Th><Th sortKey="plant" s={cSort}>{t('costIntel.colPlant')}</Th><Th sortKey="output" s={cSort} firstDir="desc" className="num">{t('costIntel.colOutput')}</Th><Th sortKey="reactor" s={cSort} firstDir="desc" className="num">{t('costIntel.colReactorHrs')}</Th>
                  <Th sortKey="material" s={cSort} firstDir="desc" className="num">{t('costIntel.colMaterial')}</Th><Th sortKey="labour" s={cSort} firstDir="desc" className="num">{t('costIntel.colLabour')}</Th><Th sortKey="energy" s={cSort} firstDir="desc" className="num">{t('costIntel.colEnergy')}</Th>
                  <Th sortKey="overhead" s={cSort} firstDir="desc" className="num">{t('costIntel.colOverhead')}</Th><Th sortKey="landed" s={cSort} firstDir="desc" className="num">{t('costIntel.colLanded')}</Th><Th sortKey="costPerMT" s={cSort} firstDir="desc" className="num">{t('costIntel.colCostPerMT')}</Th>
                </tr>
              </thead>
              <tbody>
                {cSort.sorted.map(({ batch, outputMT, reactorHours, cost }) => (
                  <tr key={batch.id}>
                    <td className="font-semibold">{batch.batch_no}</td>
                    <td className="text-slate-500">{displayLocationName(batch.plants?.name) || '—'}</td>
                    <td className="num">{outputMT.toFixed(1)}</td>
                    <td className="num text-slate-500">{reactorHours.toFixed(1)}</td>
                    <td className="num text-slate-500">{fmtINR(cost.materialCost)}</td>
                    <td className="num text-slate-500">{fmtINR(cost.labourCost)}</td>
                    <td className="num text-slate-500">{fmtINR(cost.energyCost)}</td>
                    <td className="num text-slate-500">{fmtINR(cost.overheadCost)}</td>
                    <td className="num font-bold">{fmtINR(cost.landedCost)}</td>
                    <td className="num font-semibold">{cost.costPerMT > 0 ? fmtINR(cost.costPerMT) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
