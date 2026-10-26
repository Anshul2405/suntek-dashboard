import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Sparkles, ArrowRight } from 'lucide-react';
import { SlidePanel } from '../SlidePanel';
import { MiniBarChart } from '../charts/AnalyticsViz';
import { useNarrative } from '../../lib/anomaly/useAnomalies';
import type { AnomalyFinding } from '../../lib/anomaly/types';
import { formatDate } from '../../lib/utils/formatting';

const SEV_COLOR = { urgent: '#DC2626', warning: '#D97706', info: '#2563EB' } as const;
const SEV_KEY = { urgent: 'anomaly.sevUrgent', warning: 'anomaly.sevWarning', info: 'anomaly.sevInfo' } as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#F8FAFC', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{value}</div>
    </div>
  );
}

export function AnomalyDrilldown({ finding, open, onClose }: {
  finding: AnomalyFinding | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const narrative = useNarrative();

  // Fetch the AI narrative when a finding is opened
  useEffect(() => {
    if (open && finding) narrative.mutate(finding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, finding?.id]);

  if (!finding) return null;
  const d = finding.detail || {};
  const sev = SEV_COLOR[finding.severity];

  // Build a small trend series from whatever evidence the finding carries
  const trendData = buildTrend(finding, t);

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      subtitle={t('anomaly.typeTier', { defaultValue: '{{type}} · Tier {{tier}}', type: finding.anomaly_type, tier: finding.tier })}
      title={finding.title}
    >
      {/* Severity ribbon */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '5px 12px', borderRadius: 20, background: `${sev}14`, color: sev,
        fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {t('anomaly.severityScore', {
          defaultValue: '{{severity}} · score {{pct}}%',
          severity: t(SEV_KEY[finding.severity], finding.severity),
          pct: (finding.score * 100).toFixed(0),
        })}
      </div>

      <div style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.6, marginBottom: 18 }}>{finding.body}</div>

      {/* Evidence stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
        {evidenceStats(finding, t).map(s => <Stat key={s.label} {...s} />)}
      </div>

      {/* Trend mini-chart */}
      {trendData && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
            {trendData.label}
          </div>
          <MiniBarChart data={trendData.data} labels={trendData.labels} color={sev} height={48} />
        </div>
      )}

      {/* AI analysis block */}
      <div style={{
        border: '1px solid #E9D5FF', background: 'linear-gradient(180deg,#FAF5FF,#fff)',
        borderRadius: 16, padding: '16px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Sparkles size={15} color="#9333EA" />
          <span style={{ fontSize: 12, fontWeight: 800, color: '#7E22CE', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('anomaly.aiAnalysis', 'AI analysis')}</span>
          {narrative.data && (
            <span style={{ marginLeft: 'auto', fontSize: 9, color: '#A78BFA', fontWeight: 600 }}>
              {t('anomaly.sourceConfidence', { defaultValue: '{{source}} · {{confidence}} confidence', source: narrative.data.source, confidence: narrative.data.confidence })}
            </span>
          )}
        </div>

        {narrative.isPending && (
          <div style={{ fontSize: 12.5, color: '#94A3B8' }}>{t('anomaly.analysingRootCause', 'Analysing the root cause…')}</div>
        )}
        {narrative.isError && (
          <div style={{ fontSize: 12.5, color: '#94A3B8' }}>{t('anomaly.aiUnavailable', 'AI analysis unavailable.')}</div>
        )}
        {narrative.data && (
          <>
            <div style={{ fontSize: 13, color: '#3B0764', lineHeight: 1.6 }}>{narrative.data.narrative}</div>

            {narrative.data.hypotheses?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#9333EA', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{t('anomaly.likelyCauses', 'Likely causes')}</div>
                {narrative.data.hypotheses.map((h, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: '#4C1D95', marginBottom: 4 }}>
                    <span style={{ color: '#A855F7' }}>•</span><span>{h}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8, background: '#fff', border: '1px solid #E9D5FF', borderRadius: 12, padding: '10px 12px' }}>
              <ArrowRight size={15} color="#16A34A" style={{ marginTop: 1, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#15803D', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{t('anomaly.recommendedAction', 'Recommended action')}</div>
                <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.5 }}>{narrative.data.recommended_action}</div>
              </div>
            </div>
          </>
        )}
      </div>
    </SlidePanel>
  );
}

// ── Evidence helpers ──────────────────────────────────────────────────────────

const inr = (n: number) => (Math.abs(n) >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : `₹${Math.round(n || 0).toLocaleString('en-IN')}`);
const pc = (n: number) => `${(n * 100).toFixed(1)}%`;

const fmtMetric = (metric: string, v: number) => metric === 'margin_pct' ? pc(v) : inr(v);

function evidenceStats(f: AnomalyFinding, t: TFunction): { label: string; value: string }[] {
  const d = f.detail || {};
  if (f.anomaly_type.startsWith('TS_')) {
    return [
      { label: t('anomaly.evValueLabelled', { defaultValue: 'Value ({{label}})', label: d.label }), value: fmtMetric(d.metric, d.value) },
      { label: t('anomaly.evExpectedBaseline', 'Expected (baseline)'), value: fmtMetric(d.metric, d.baseline) },
      { label: t('anomaly.zScore', 'z-score'), value: `${(d.z ?? 0).toFixed(2)}σ` },
      { label: t('anomaly.evRobustZ', 'Robust z (MAD)'), value: `${(d.robustZ ?? 0).toFixed(2)}σ` },
    ];
  }
  switch (f.anomaly_type) {
    case 'MARGIN_COMPRESSION':
      return [
        { label: t('anomaly.evRecentMargin', 'Recent margin'), value: pc(d.recentMarginPct) },
        { label: t('anomaly.evPriorMargin', 'Prior margin'), value: pc(d.priorMarginPct) },
        { label: t('anomaly.evRecentPurchase14d', 'Recent purchase (14d)'), value: inr(d.recentPurch) },
        { label: t('anomaly.evPriorPurchase14d', 'Prior purchase (14d)'), value: inr(d.priorPurch) },
      ];
    case 'A14_vendor_switch':
      return [
        { label: t('anomaly.evNewTopVendor', 'New top vendor'), value: d.newVendor || '—' },
        { label: t('anomaly.evNewVendorSpend', 'New vendor spend'), value: inr(d.newVendorSpend) },
        { label: t('anomaly.evDisplacedVendor', 'Displaced vendor'), value: d.priorTopVendor || '—' },
        { label: t('anomaly.evPurchase14d', 'Purchase 14d'), value: inr(d.recentPurchTotal) },
      ];
    case 'A6_revenue_pace':
      return [
        { label: t('anomaly.evMtdSales', 'MTD sales'), value: inr(d.mtdSales) },
        { label: t('anomaly.evLastMonthPace', 'Last month pace'), value: inr(d.prevPaceSales) },
      ];
    case 'A7_customer_silent':
      return [
        { label: t('anomaly.evDaysSilent', 'Days silent'), value: `${d.daysSilent}` },
        { label: t('anomaly.evFyRevenue', 'FY revenue'), value: inr(d.fyRevenue) },
        { label: t('anomaly.evOutstanding', 'Outstanding'), value: inr(d.outstanding) },
        { label: t('anomaly.evLastInvoice', 'Last invoice'), value: d.lastInvoice ? formatDate(d.lastInvoice) : '—' },
      ];
    case 'A8_credit_risk':
      return [
        { label: t('anomaly.evOutstanding', 'Outstanding'), value: inr(d.outstanding) },
        { label: t('anomaly.evLastInvoice', 'Last invoice'), value: t('time.daysAgo', { count: d.daysSilent }) },
        { label: t('anomaly.evFyRevenue', 'FY revenue'), value: inr(d.fyRevenue) },
      ];
    default:
      return [
        { label: t('anomaly.evMetric', 'Metric'), value: `${f.metric_value ?? '—'}` },
        { label: t('anomaly.evBaseline', 'Baseline'), value: `${f.baseline_value ?? '—'}` },
      ];
  }
}

function buildTrend(f: AnomalyFinding, t: TFunction): { label: string; data: number[]; labels: string[] } | null {
  const d = f.detail || {};
  if (f.anomaly_type.startsWith('TS_')) {
    const scale = d.metric === 'margin_pct' ? 100 : 1 / 1e7;
    const suffix = d.metric === 'margin_pct' ? '%' : '₹ (Cr)';
    return {
      label: t('anomaly.trendExpectedVsActual', { defaultValue: 'Expected vs actual {{suffix}}', suffix }),
      data: [(d.baseline || 0) * scale, (d.value || 0) * scale],
      labels: [t('anomaly.tooltipExpected', 'Expected'), d.label],
    };
  }
  switch (f.anomaly_type) {
    case 'MARGIN_COMPRESSION':
      return {
        label: t('anomaly.trendMarginPriorRecent', 'Margin %: prior → recent'),
        data: [d.priorMarginPct * 100, d.recentMarginPct * 100],
        labels: [t('anomaly.prior14d', 'Prior 14d'), t('anomaly.last14d', 'Last 14d')],
      };
    case 'A14_vendor_switch':
      return {
        label: t('anomaly.trendPurchasePriorRecent', 'Purchase ₹ (Cr): prior → recent'),
        data: [(d.priorPurchTotal || 0) / 1e7, (d.recentPurchTotal || 0) / 1e7],
        labels: [t('anomaly.prior14d', 'Prior 14d'), t('anomaly.last14d', 'Last 14d')],
      };
    case 'A6_revenue_pace':
      return {
        label: t('anomaly.trendSalesPace', 'Sales pace ₹ (Cr)'),
        data: [(d.prevPaceSales || 0) / 1e7, (d.mtdSales || 0) / 1e7],
        labels: [t('anomaly.lastMonth', 'Last month'), t('anomaly.thisMonth', 'This month')],
      };
    default:
      return null;
  }
}
