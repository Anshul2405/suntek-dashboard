import React, { createContext, useContext } from 'react';
import { useAnomalyFindings, type AnomalyContextValue } from '../lib/anomaly/useAnomalyFindings';

const AnomalyContext = createContext<AnomalyContextValue>({
  scan: undefined, findings: [], criticalCount: 0, urgentCount: 0,
  loading: false, error: false, refetch: () => {},
});

export function useAnomalies() {
  return useContext(AnomalyContext);
}

/**
 * The app-wide badge (sidebar) and Caution button sit on every page, most of
 * which have no company picker — so they always count every company.
 */
export function AnomalyProvider({ children }: { children: React.ReactNode }) {
  const value = useAnomalyFindings('all');
  return <AnomalyContext.Provider value={value}>{children}</AnomalyContext.Provider>;
}
