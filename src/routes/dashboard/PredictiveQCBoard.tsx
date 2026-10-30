import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { StatCard, StatusPill, InfoBanner, type PillTone } from '../../components/v2';
import { SkeletonRows, ErrorState, EmptyState } from '../../components/ui/states';
import { KpiInfoButton } from '../../components/KpiInfoButton';
import { NotesButton } from '../../components/mentions';
import type { Database } from '../../lib/database.types';
import { displayLocationName } from '../../lib/plantLabels';

type BatchRow = Database['public']['Tables']['active_batches']['Row'] & { plants?: { name: string | null } | null };
type ReadingRow = Database['public']['Tables']['batch_readings']['Row'];

const GOLDEN_POINTS = 12;
const TOL_GREEN = 3; // % within target
const TOL_AMBER = 5;

/** The proven healthy gravity trajectory for a grade (saturating rise to target). */
function goldenCurve(grade: number, points = GOLDEN_POINTS): number[] {
  const start = 1000;
  return Array.from({ length: points }, (_, i) => {
    const x = i / (points - 1);
    return Math.round(start + (grade - start) * (1 - Math.exp(-3 * x)));
  });
}

interface BatchProjection {
  batch: BatchRow;
  grade: number;
  golden: number[];
  live: number[];
  projected: number;
  devPct: number;
  status: 'green' | 'amber' | 'red';
  chart: { i: number; golden: number; live: number | null }[];
}

const STATUS_CFG: Record<BatchProjection['status'], { label: string; color: string; pill: PillTone }> = {
  green: { label: 'On track', color: '#16A34A', pill: 'green' },
  amber: { label: 'Drifting', color: '#D97706', pill: 'amber' },
  red:   { label: 'Off-spec risk', color: '#DC2626', pill: 'red' },
};

export function PredictiveQCBoard() {
  const { t } = useTranslation();
  // Plant-scoped (fail-closed): a user sees batches of their own plants only.
  const { scopeQuery, ready: scopeReady, plantIds, isGlobal } = usePlantScope();
  const scopeKey = isGlobal ? 'all' : plantIds.join(',');
  const { data, isLoading, isError, refetch } = useQuery<{ batches: BatchRow[]; readings: ReadingRow[] }>({
    queryKey: ['predictive-qc', scopeKey],
    enabled: scopeReady,
    queryFn: async () => {
      const { data: batches, error: be } = await scopeQuery(supabase
        .from('active_batches').select('*, plants(name)')).eq('status', 'active').returns<BatchRow[]>();
      if (be) throw be;
      const ids = (batches ?? []).map(b => b.id);
      let readings: ReadingRow[] = [];
      if (ids.length) {
        const { data: rd } = await supabase
          .from('batch_readings').select('*').in('batch_id', ids)
          .order('timestamp', { ascending: true }).returns<ReadingRow[]>();
        readings = rd ?? [];
      }
      return { batches: batches ?? [], readings };
    },
  });

  const projections = useMemo<BatchProjection[]>(() => {
    const batches = data?.batches ?? [];
    const readings = data?.readings ?? [];
    return batches.map(b => {
      const grade = parseInt(b.recipe || '', 10) || b.final_gravity || 1400;
      const golden = goldenCurve(grade);
      const live = readings
        .filter(r => r.batch_id === b.id && r.cp_gravity != null)
        .map(r => r.cp_gravity as number);
      // Project final by drift vs the golden curve at the same points.
      const goldenPartial = golden.slice(0, live.length);
      const ratios = live.map((v, i) => (goldenPartial[i] ? v / goldenPartial[i] : 1));
      const driftFactor = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
      const projected = Math.round(grade * driftFactor);
      const devPct = (driftFactor - 1) * 100;
      const status: BatchProjection['status'] =
        Math.abs(devPct) <= TOL_GREEN ? 'green' : Math.abs(devPct) <= TOL_AMBER ? 'amber' : 'red';
      const chart = golden.map((g, i) => ({ i: i + 1, golden: g, live: i < live.length ? live[i] : null }));
      return { batch: b, grade, golden, live, projected, devPct, status, chart };
    });
  }, [data]);

  const counts = useMemo(() => ({
    green: projections.filter(p => p.status === 'green').length,
    amber: projections.filter(p => p.status === 'amber').length,
    red: projections.filter(p => p.status === 'red').length,
  }), [projections]);

  return (
    <>
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Live Predictive QC', what: 'Every running batch projected to where it will land — its live gravity curve against the proven golden-batch trajectory for that grade, hours before closure.', source: 'Derived', note: 'Golden curve per grade; projection = drift vs golden carried to the endpoint. Detector 4.1 raises flags into the Anomaly Center.' }} />
          <StatCard className="h-full" icon={<Gauge />} tone="blue"
            label={t('predictiveQc.runningBatches')} value={isLoading ? '…' : projections.length} />
        </div>
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<CheckCircle2 />} tone="green"
          valueTone={counts.green > 0 ? 'green' : 'default'}
          label={t('predictiveQc.status_green')} value={isLoading ? '…' : counts.green}
          caption={t('predictiveQc.onTrackCount', { count: counts.green })} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<AlertCircle />} tone="amber"
          valueTone={counts.amber > 0 ? 'amber' : 'default'}
          label={t('predictiveQc.status_amber')} value={isLoading ? '…' : counts.amber}
          caption={t('predictiveQc.driftingCount', { count: counts.amber })} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<AlertTriangle />} tone="red"
          valueTone={counts.red > 0 ? 'red' : 'default'}
          label={t('predictiveQc.status_red')} value={isLoading ? '…' : counts.red}
          caption={t('predictiveQc.atRiskCount', { count: counts.red })} />
      </div>

      {/* Golden-batch model explainer */}
      <InfoBanner className="mb-4">
        <span className="font-semibold text-slate-700">{t('predictiveQc.goldenBatchModel')}</span>
        {' — '}{t('predictiveQc.perGradeTrajectory')} · {t('predictiveQc.steerHint')}
      </InfoBanner>

      {isLoading ? (
        <div className="card2 p-5"><SkeletonRows rows={6} /></div>
      ) : isError ? (
        <div className="card2 p-5"><ErrorState title={t('predictiveQc.errorLoadTitle')} onRetry={() => refetch()} /></div>
      ) : projections.length === 0 ? (
        <div className="card2 p-5"><EmptyState title={t('predictiveQc.emptyTitle')} message={t('predictiveQc.emptyMessage')} /></div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {projections.map(p => {
            const cfg = STATUS_CFG[p.status];
            return (
              <div key={p.batch.id} className="col-span-12 lg:col-span-6 card2 p-5" style={{ borderTop: `3px solid ${cfg.color}` }}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="text-base font-heading font-semibold">{t('predictiveQc.batchLabel', { no: p.batch.batch_no })}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{t('predictiveQc.batchMeta', { plant: displayLocationName(p.batch.plants?.name) || '—', grade: p.grade, count: p.live.length })}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={cfg.pill} dot label={t('predictiveQc.status_' + p.status)} />
                    <NotesButton
                      entityType="active_batch"
                      entityId={p.batch.id}
                      entityLabel={`Batch ${p.batch.batch_no}${p.batch.plants?.name ? ' · ' + p.batch.plants.name : ''}`}
                      route="/dashboard/predictive-qc"
                    />
                  </div>
                </div>
                <div style={{ height: 160 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={p.chart} margin={{ top: 5, right: 8, bottom: 0, left: -18 }}>
                      <XAxis dataKey="i" tick={{ fontSize: 10 }} stroke="#cbd5e1" />
                      <YAxis domain={['dataMin - 30', 'dataMax + 30']} tick={{ fontSize: 10 }} stroke="#cbd5e1" />
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <ReferenceLine y={p.grade} stroke="#94a3b8" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="golden" name="Golden" stroke="#94a3b8" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="live" name="Live" stroke={cfg.color} strokeWidth={2.5} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs">
                  <span className="text-slate-500">{t('predictiveQc.projectedFinal')} <span className="font-bold num" style={{ color: cfg.color }}>{p.projected}</span> {t('predictiveQc.vsTarget', { grade: p.grade })}</span>
                  <span className="font-semibold" style={{ color: cfg.color }}>{p.devPct >= 0 ? '+' : ''}{p.devPct.toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
