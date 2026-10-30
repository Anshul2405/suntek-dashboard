import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, RefreshCw, Activity, Download, Cpu, Sparkles, Database, Check, Info, AlertCircle, AlertTriangle, Flame } from 'lucide-react';
import { WorkCard, SectionCard, ButtonV2 } from '../../components/v2';
import { SlidePanel } from '../../components/SlidePanel';
import { useAnomalyFindings } from '../../lib/anomaly/useAnomalyFindings';
import { useExportFeatures } from '../../lib/anomaly/useAnomalies';
import { AnomalyCard } from '../../components/anomaly/AnomalyCard';
import { ProblemKpiGrid } from '../../components/anomaly/ProblemKpiGrid';
import { AnomalyDrilldown } from '../../components/anomaly/AnomalyDrilldown';
import { MetricExplorer } from '../../components/anomaly/MetricExplorer';
import { AnomalyAnalyticsGrid } from '../../components/anomaly/AnomalyAnalyticsGrid';
import { LEVEL_LABEL, LEVEL_ORDER } from '../../lib/anomaly/levels';
import type { AnomalyFinding, Level } from '../../lib/anomaly/types';
import { formatDate } from '../../lib/utils/formatting';

/** Severity tier → icon (mild → extreme). */
const TIER_ICON: Record<Level, React.ReactNode> = {
  mild: <Info />, moderate: <AlertCircle />, heavy: <AlertTriangle />, extreme: <Flame />,
};

/** Severity tier → i18n key (the label map itself lives in lib/anomaly/levels). */
const LEVEL_KEY: Record<Level, string> = {
  mild: 'anomaly.levelMild', moderate: 'anomaly.levelModerate',
  heavy: 'anomaly.levelHeavy', extreme: 'anomaly.levelExtreme',
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="font-heading font-semibold text-[15px] text-slate-800 mb-3">{children}</div>;
}

export function AnomalyDashboard() {
  const { t } = useTranslation();
  // This page shows the company picker, so it follows the picked company.
  const { scan, findings, loading, error, refetch } = useAnomalyFindings();
  const exporter = useExportFeatures();
  const [selected, setSelected] = useState<AnomalyFinding | null>(null);
  const [tierModal, setTierModal] = useState<Level | null>(null);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    const a = params.get('a');
    if (a && findings.length) { const f = findings.find(x => x.id === a); if (f) setSelected(f); }
  }, [params, findings]);

  const levels = scan?.summary.levels ?? { mild: 0, moderate: 0, heavy: 0, extreme: 0 };
  const tierFindings = tierModal ? findings.filter(f => f.level === tierModal) : [];

  function openFinding(f: AnomalyFinding) { setTierModal(null); setSelected(f); setParams({ a: f.id }); }
  function closeFinding() { setSelected(null); setParams({}); }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="w-10 h-10 rounded-[10px] bg-amber-50 text-amber-500 inline-flex items-center justify-center shrink-0">
            <Activity size={18} />
          </span>
          <div className="text-[13px] text-slate-500">
            {t('anomaly.scanSubtitle')} · {scan?.anchor_date ? t('anomaly.dataThrough', { date: formatDate(scan.anchor_date) }) : '—'}
            {scan?._fallback && <span className="text-amber-600"> · {t('anomaly.cached')}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ButtonV2
            variant="outline"
            icon={exporter.isSuccess ? <Check className="text-green-600" /> : <Download />}
            onClick={() => exporter.mutate()}
          >
            {exporter.isPending ? t('anomaly.exporting') : exporter.isSuccess ? t('anomaly.savedCsvs', { count: exporter.data?.count }) : t('anomaly.exportFeatures')}
          </ButtonV2>
          <ButtonV2 variant="outline" icon={<RefreshCw />} onClick={() => refetch()}>
            {t('anomaly.rescan')}
          </ButtonV2>
        </div>
      </div>

      {/* Severity tiers (extreme → mild) — click a tier to view its anomalies */}
      <div className="grid grid-cols-12 gap-4 mb-1.5">
        {LEVEL_ORDER.map(l => (
          <WorkCard
            key={l}
            className={`col-span-12 sm:col-span-6 lg:col-span-3 h-full ${tierModal === l ? 'ring-2 ring-slate-300' : ''}`}
            icon={TIER_ICON[l]}
            label={t(LEVEL_KEY[l], LEVEL_LABEL[l])}
            value={levels[l]}
            onClick={() => setTierModal(l)}
          />
        ))}
      </div>
      <div className="text-[11px] text-slate-400 mb-5">{t('anomaly.clickTierHint')}</div>

      {/* Problem-KPI grid */}
      {scan?.kpis && scan.kpis.length > 0 && (
        <div className="mb-6">
          <SectionTitle>{t('anomaly.keyMetricsTitle')}</SectionTitle>
          <ProblemKpiGrid kpis={scan.kpis} />
        </div>
      )}

      {/* Risk analytics — multi-plot grid */}
      <div className="mb-6">
        <SectionTitle>{t('anomaly.riskAnalytics')}</SectionTitle>
        <AnomalyAnalyticsGrid />
      </div>

      {/* Metric Explorer — interactive charts with granularity */}
      <div className="mb-6">
        <SectionTitle>{t('anomaly.metricExplorerTitle')}</SectionTitle>
        <MetricExplorer />
      </div>

      {/* AI & methodology / data dependency panel */}
      <MethodologyPanel />

      {/* Tier popup — opened from a severity pill */}
      {tierModal && (
        <SlidePanel open onClose={() => setTierModal(null)} subtitle={t('anomaly.detectedAnomalies')}
          title={`${t(LEVEL_KEY[tierModal], LEVEL_LABEL[tierModal])} · ${tierFindings.length}`}>
          {loading ? (
            <div className="text-center py-10 text-slate-400 text-[13px]">{t('anomaly.scanningLiveData')}</div>
          ) : error ? (
            <div className="text-center py-10 text-slate-400 text-[13px]">{t('anomaly.engineUnreachable')}</div>
          ) : tierFindings.length === 0 ? (
            <div className="flex flex-col items-center py-9 text-green-600">
              <ShieldCheck size={34} />
              <div className="text-sm font-bold font-heading mt-2.5 text-green-700">{t('anomaly.noTierAnomalies', { level: t(LEVEL_KEY[tierModal], LEVEL_LABEL[tierModal]).toLowerCase() })}</div>
              <div className="text-xs text-slate-400 mt-1">{t('anomaly.nothingAtSeverity')}</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {tierFindings.map(f => <AnomalyCard key={f.id} finding={f} onClick={() => openFinding(f)} />)}
            </div>
          )}
        </SlidePanel>
      )}

      <AnomalyDrilldown finding={selected} open={!!selected} onClose={closeFinding} />
    </div>
  );
}

function MethodologyPanel() {
  const { t } = useTranslation();
  return (
    <SectionCard className="mt-6" title={t('anomaly.howItWorksTitle')}>
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-4 rounded-xl border border-slate-100 p-4" style={{ background: '#F8FAFC' }}>
          <div className="flex items-center gap-2.5 mb-2">
            <span className="w-8 h-8 rounded-[10px] bg-blue-50 text-blue-600 inline-flex items-center justify-center shrink-0"><Cpu size={15} /></span>
            <span className="font-semibold text-[13px] text-slate-800">{t('anomaly.statEngineTitle')}</span>
          </div>
          <div className="text-xs text-slate-600 leading-relaxed" dangerouslySetInnerHTML={{ __html: t('anomaly.statEngineBody', 'Deterministic detectors decide <strong>what</strong> is anomalous: rolling z-score, EWMA drift, robust MAD (outlier-tolerant), and IQR fences over engineered features. Severity tier = max(|z|, |robust-z|): mild ≥2σ, moderate ≥2.5σ, heavy ≥3.5σ, extreme ≥5σ.') }} />
        </div>
        <div className="col-span-12 lg:col-span-4 rounded-xl border border-slate-100 p-4" style={{ background: '#F8FAFC' }}>
          <div className="flex items-center gap-2.5 mb-2">
            <span className="w-8 h-8 rounded-[10px] bg-purple-50 text-purple-600 inline-flex items-center justify-center shrink-0"><Sparkles size={15} /></span>
            <span className="font-semibold text-[13px] text-slate-800">{t('anomaly.aiAnalystTitle')}</span>
          </div>
          <div className="text-xs text-slate-600 leading-relaxed" dangerouslySetInnerHTML={{ __html: t('anomaly.aiAnalystBody', 'Llama-3.3-70B explains <strong>why</strong> — the root-cause story and recommended action — given only the numbers the engine already computed. It never decides severity and never invents figures. Open any anomaly to see its analysis.') }} />
        </div>
        <div className="col-span-12 lg:col-span-4 rounded-xl border border-slate-100 p-4" style={{ background: '#F8FAFC' }}>
          <div className="flex items-center gap-2.5 mb-2">
            <span className="w-8 h-8 rounded-[10px] bg-green-50 text-green-600 inline-flex items-center justify-center shrink-0"><Database size={15} /></span>
            <span className="font-semibold text-[13px] text-slate-800">{t('anomaly.dataDependencyTitle')}</span>
          </div>
          <div className="text-xs text-slate-600 leading-relaxed" dangerouslySetInnerHTML={{ __html: t('anomaly.dataDependencyBody', 'Financial detectors run on <strong>real BUSY data</strong> (live, ~2 months). Statistical baselines sharpen as more history accrues; thin metrics show as <em>calibrating</em> rather than false-firing. Engineered features are exported to <code class="text-[11px]">data/anomaly/*.csv</code>.') }} />
        </div>
      </div>
    </SectionCard>
  );
}
