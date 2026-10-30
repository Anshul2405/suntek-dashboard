import { useMemo } from 'react';
import { useAnomalyScan } from './useAnomalies';
import type { ScanResult, AnomalyFinding } from './types';
import { useRoleContext } from '../../contexts/RoleContext';
import type { BusyCompanyCode } from '../busyCompanies';

export interface AnomalyContextValue {
  scan: ScanResult | undefined;
  findings: AnomalyFinding[];     // role-scoped
  criticalCount: number;          // urgent + warning, role-scoped
  urgentCount: number;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

// Per-role anomaly scoping: which entity_types each role should see.
// Accountants → financial/customer; unit_head → ops/vendor/equipment; admin → all.
function scopeForRole(roleId: string): Set<string> | null {
  if (roleId === 'admin') return null; // all
  if (roleId === 'unit_head') return new Set(['vendor', 'equipment', 'plant', 'batch', 'kpi']);
  if (roleId === 'accountant_delhi' || roleId === 'accountant_other')
    return new Set(['customer', 'kpi', 'vendor']);
  return new Set(['kpi']);
}

/**
 * Role-scoped anomaly findings for one Busy company. With no company, the one
 * picked in the TopBar (used by the Anomaly page, which shows the picker).
 */
export function useAnomalyFindings(company?: BusyCompanyCode): AnomalyContextValue {
  const { activeProfile } = useRoleContext();
  const roleId = activeProfile?.id ?? 'admin';
  const { data: scan, isLoading, isError, refetch } = useAnomalyScan(company);

  const findings = useMemo(() => {
    const all = scan?.findings ?? [];
    const scope = scopeForRole(roleId);
    if (!scope) return all;
    return all.filter(f => !f.entity_type || scope.has(f.entity_type));
  }, [scan, roleId]);

  const urgentCount = findings.filter(f => f.severity === 'urgent').length;
  const criticalCount = findings.filter(f => f.severity === 'urgent' || f.severity === 'warning').length;

  return {
    scan, findings, criticalCount, urgentCount,
    loading: isLoading, error: isError, refetch: () => { void refetch(); },
  };
}

