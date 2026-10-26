import { useQuery, useMutation } from '@tanstack/react-query';
import type { ScanResult, AnomalyFinding, Narrative, MetricsCatalog, TimeSeriesResult, Grain, AnalyticsResult } from './types';
import { fetchBusy, savedBusy } from '../../hooks/useBusyData';
import { useBusyCompany } from '../../contexts/BusyCompanyContext';

const BUSY_BASE = import.meta.env.VITE_BUSY_API_URL ?? '';

/** Full anomaly scan over real BUSY data — findings + problem-KPI snapshot. */
export function useAnomalyScan() {
  const { code } = useBusyCompany();
  return useQuery<ScanResult>({
    queryKey: ['anomaly-scan', code],
    queryFn: () => fetchBusy('/api/anomaly/scan', code),
    ...savedBusy<ScanResult>('/api/anomaly/scan', code),
    staleTime: 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });
}

/** Analytics bundle for the multi-plot grid. */
export function useAnalytics() {
  const { code } = useBusyCompany();
  return useQuery<AnalyticsResult>({
    queryKey: ['anomaly-analytics', code],
    queryFn: () => fetchBusy('/api/anomaly/analytics', code),
    ...savedBusy<AnalyticsResult>('/api/anomaly/analytics', code),
    staleTime: 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });
}

/** Metric + grain catalog for the explorer controls. */
export function useMetricsCatalog() {
  const { code } = useBusyCompany();
  return useQuery<MetricsCatalog>({
    queryKey: ['anomaly-metrics-catalog', code],
    queryFn: () => fetchBusy('/api/anomaly/metrics', code),
    ...savedBusy<MetricsCatalog>('/api/anomaly/metrics', code),
    staleTime: Infinity,
  });
}

/** Engineered time series for one metric at a chosen granularity. */
export function useMetricSeries(metric: string, grain: Grain) {
  const { code } = useBusyCompany();
  return useQuery<TimeSeriesResult>({
    queryKey: ['anomaly-timeseries', metric, grain, code],
    queryFn: () => fetchBusy(`/api/anomaly/timeseries?metric=${metric}&grain=${grain}`, code),
    ...savedBusy<TimeSeriesResult>(`/api/anomaly/timeseries?metric=${metric}&grain=${grain}`, code),
    staleTime: 60 * 1000,
    placeholderData: (prev) => prev, // keep prior chart while switching grain
  });
}

/** Trigger a server-side CSV export of all engineered features. */
export function useExportFeatures() {
  return useMutation<{ dir: string; count: number; files: any[] }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`${BUSY_BASE}/api/anomaly/export`, { headers: { 'ngrok-skip-browser-warning': '1' } });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
  });
}

/** Lazily fetch an AI root-cause narrative for one finding. */
export function useNarrative() {
  return useMutation<Narrative, Error, AnomalyFinding>({
    mutationFn: async (finding) => {
      const res = await fetch(`${BUSY_BASE}/api/anomaly/narrative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
        body: JSON.stringify({ finding }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
  });
}
