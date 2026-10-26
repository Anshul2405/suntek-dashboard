import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, AlertCircle, Eye, CheckCircle2, Building2, Layers } from 'lucide-react';
import { StatCard, SectionCard, FilterBar, FilterSelect, SegmentTabs, ButtonV2, StatusPill, TablePaginationV2, type PillTone } from '../../components/v2';
import { usePagination } from '../../components/ui/usePagination';
import { useTable } from '../../hooks/useTable';
import { useToast } from '../../components/ui/toast';
import { SkeletonRows, ErrorState, EmptyState } from '../../components/ui/states';
import { MentionTextarea, CcSelect, NotesButton, MentionText } from '../../components/mentions';
import { useDirectory, addWatchers, notifyWatchers, truncate } from '../../lib/mentions';
import { useRoleContext } from '../../contexts/RoleContext';
import { useNotifications } from '../../contexts/NotificationsContext';
import type { Database } from '../../lib/database.types';

type FlagRow = Database['public']['Tables']['anomaly_flags']['Row'];
type Severity = FlagRow['severity'];
type Status = FlagRow['status'];

const SEV_CFG: Record<Severity, { label: string; bg: string; color: string; rank: number; pill: PillTone }> = {
  critical: { label: 'Critical', bg: '#FEE2E2', color: '#DC2626', rank: 0, pill: 'red' },
  warning:  { label: 'Warning',  bg: '#FEF3C7', color: '#D97706', rank: 1, pill: 'amber' },
  watch:    { label: 'Watch',    bg: '#DBEAFE', color: '#2563EB', rank: 2, pill: 'blue' },
};

const SOURCE_LABEL: Record<string, string> = {
  predictive_qc: 'Predictive QC',
  material_recon: 'Material Reconciliation',
  predictive_maint: 'Predictive Maintenance',
  throughput: 'Throughput',
  demand: 'Demand & Procurement',
  margin: 'Margin & Pricing',
  receivables: 'Receivables & Credit',
};

function fmtValue(v: number | null, unit: string | null): string | null {
  if (v == null) return null;
  if (unit === 'INR') return `₹ ${Number(v).toLocaleString('en-IN')}`;
  if (unit === 'MT') return `${v} MT`;
  if (unit === 'hours') return `${v} hrs`;
  return String(v);
}

export function AnomalyOperationsCenter() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const { addNotification } = useNotifications();
  const people = useDirectory();
  const { rows, isLoading, isError, refetch, update } = useTable<'anomaly_flags'>('anomaly_flags', {
    orderBy: 'created_at',
  });

  const [statusFilter, setStatusFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [plantFilter, setPlantFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  // Reason capture for resolve/dismiss (the §5.4 feedback signal).
  const [reasonFor, setReasonFor] = useState<{ id: string; action: 'resolved' | 'dismissed' } | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [reasonMentions, setReasonMentions] = useState<string[]>([]);
  const [reasonCc, setReasonCc] = useState<string[]>([]);

  const plants = useMemo(() => [...new Set(rows.map(r => r.plant).filter(Boolean))] as string[], [rows]);
  const sources = useMemo(() => [...new Set(rows.map(r => r.source_app))], [rows]);

  const counts = useMemo(() => {
    const open = rows.filter(r => r.status === 'open' || r.status === 'acknowledged');
    return {
      critical: open.filter(r => r.severity === 'critical').length,
      warning: open.filter(r => r.severity === 'warning').length,
      watch: open.filter(r => r.severity === 'watch').length,
      resolved: rows.filter(r => r.status === 'resolved' || r.status === 'dismissed').length,
    };
  }, [rows]);

  const visible = useMemo(() => {
    return rows
      .filter(r => {
        if (statusFilter === 'open') return r.status === 'open' || r.status === 'acknowledged';
        if (statusFilter === 'resolved') return r.status === 'resolved' || r.status === 'dismissed';
        return true;
      })
      .filter(r => plantFilter === 'all' || r.plant === plantFilter)
      .filter(r => sourceFilter === 'all' || r.source_app === sourceFilter)
      .sort((a, b) => {
        const s = SEV_CFG[a.severity].rank - SEV_CFG[b.severity].rank;
        if (s !== 0) return s;
        return (b.created_at || '').localeCompare(a.created_at || '');
      });
  }, [rows, statusFilter, plantFilter, sourceFilter]);
  // Paged cards; page 1 again when a filter changes.
  const { pageRows: visiblePage, controls: findingPager } = usePagination(visible, { resetKey: `${statusFilter}|${plantFilter}|${sourceFilter}` });

  async function setStatus(id: string, status: Status, resolution_reason?: string) {
    try {
      await update.mutateAsync({
        id,
        values: {
          status,
          ...(resolution_reason !== undefined ? { resolution_reason } : {}),
          ...(status === 'resolved' || status === 'dismissed' ? { resolved_at: new Date().toISOString() } : {}),
        },
      });
      toast.success(t('anomalyCenter.toast_flag_status', { status }));
    } catch (e) {
      toast.error(t('anomalyCenter.toast_update_failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function submitReason() {
    if (!reasonFor || !reasonText.trim()) return;
    const flag = rows.find((r) => r.id === reasonFor.id);
    const text = reasonText.trim();
    const action = reasonFor.action;
    await setStatus(reasonFor.id, action, text);

    // Tagged / CC'd people watch this flag and get notified of the change.
    const ref = { entityType: 'anomaly', entityId: reasonFor.id, entityLabel: flag?.title ?? 'Anomaly flag', route: '/dashboard/anomaly-center' };
    const actor = { id: activeProfile.id, name: activeProfile.name, role: activeProfile.roleLabel };
    const ccPeople = people.filter((p) => reasonCc.includes(p.id));
    const mPeople = people.filter((p) => reasonMentions.includes(p.id));
    if (ccPeople.length) await addWatchers(ref, ccPeople.map((p) => ({ id: p.id, name: p.name })), 'cc', actor.id);
    if (mPeople.length) await addWatchers(ref, mPeople.map((p) => ({ id: p.id, name: p.name })), 'mention', actor.id);
    await notifyWatchers({
      ref,
      actor,
      title: t('anomalyCenter.notif_title', { name: actor.name, action }),
      body: `${ref.entityLabel} — “${truncate(text)}”`,
      type: action === 'resolved' ? 'info' : 'info',
      addNotification,
      extraIds: [...reasonMentions, ...reasonCc],
    });

    setReasonFor(null);
    setReasonText('');
    setReasonMentions([]);
    setReasonCc([]);
  }

  return (
    <>
      {/* Severity summary */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<AlertTriangle />} tone="red"
          valueTone={counts.critical > 0 ? 'red' : 'default'}
          label={t('anomalyCenter.sev_critical')} value={isLoading ? '…' : counts.critical} caption={t('anomalyCenter.open_flags')} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<AlertCircle />} tone="amber"
          valueTone={counts.warning > 0 ? 'amber' : 'default'}
          label={t('anomalyCenter.sev_warning')} value={isLoading ? '…' : counts.warning} caption={t('anomalyCenter.open_flags')} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<Eye />} tone="blue"
          valueTone={counts.watch > 0 ? 'blue' : 'default'}
          label={t('anomalyCenter.sev_watch')} value={isLoading ? '…' : counts.watch} caption={t('anomalyCenter.open_flags')} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<CheckCircle2 />} tone="green" valueTone="green"
          label={t('anomalyCenter.resolved_dismissed')} value={isLoading ? '…' : counts.resolved} caption={t('anomalyCenter.cleared_total')} />
      </div>

      {/* Status view switch */}
      <SegmentTabs
        className="mb-4"
        items={(['open', 'resolved', 'all'] as const).map(s => ({ key: s, label: t(`anomalyCenter.filter_${s}`) }))}
        value={statusFilter}
        onChange={setStatusFilter}
      />

      {/* Filters */}
      <FilterBar className="mb-4">
        <FilterSelect icon={<Building2 />} value={plantFilter} onChange={setPlantFilter}
          options={[{ value: 'all', label: t('anomalyCenter.all_plants') }, ...plants.map(p => ({ value: p, label: p }))]} />
        <FilterSelect icon={<Layers />} value={sourceFilter} onChange={setSourceFilter}
          options={[{ value: 'all', label: t('anomalyCenter.all_sources') },
            ...sources.map(s => ({ value: s, label: t(`anomalyCenter.source_${s}`, { defaultValue: SOURCE_LABEL[s] || s }) }))]} />
        <div className="flex-1" />
        <span className="text-xs text-slate-500 self-center px-1">{t('anomalyCenter.count_shown', { count: visible.length })}</span>
      </FilterBar>

      {/* Feed */}
      <SectionCard
        title={t('anomalyCenter.feed_title', 'Anomaly feed')}
        subtitle={t('anomalyCenter.feed_subtitle', 'Flags raised by the anomaly applications, ranked by severity')}
      >
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : isError ? (
          <ErrorState title={t('anomalyCenter.error_load')} onRetry={() => refetch()} />
        ) : visible.length === 0 ? (
          rows.length > 0
            ? <EmptyState title={t('common.noRowsMatchFilters', 'No rows match these filters')} />
            : <EmptyState title={t('anomalyCenter.empty_title')} message={t('anomalyCenter.empty_message')} />
        ) : (
          <>
            <div className="space-y-3">
              {visiblePage.map(f => {
                const cfg = SEV_CFG[f.severity];
                const val = fmtValue(f.value_at_stake, f.value_unit);
                const isOpen = f.status === 'open' || f.status === 'acknowledged';
                return (
                  <div key={f.id} className="rounded-xl border border-slate-200 p-4" style={{ borderLeft: `3px solid ${cfg.color}` }}>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1.5">
                          <StatusPill tone={cfg.pill} label={t(`anomalyCenter.sev_${f.severity}`)} />
                          <span className="text-xs text-slate-500">{t(`anomalyCenter.source_${f.source_app}`, { defaultValue: SOURCE_LABEL[f.source_app] || f.source_app })}</span>
                          {f.plant && <span className="text-xs text-slate-400">· {f.plant}</span>}
                          {f.entity_label && <span className="text-xs text-slate-400">· {f.entity_label}</span>}
                          {f.status === 'acknowledged' && <StatusPill tone="purple" label={t('anomalyCenter.status_acknowledged')} />}
                          {f.status === 'resolved' && <StatusPill tone="green" label={t('anomalyCenter.status_resolved')} />}
                          {f.status === 'dismissed' && <StatusPill tone="slate" label={t('anomalyCenter.status_dismissed')} />}
                        </div>
                        <div className="text-sm font-semibold font-heading text-slate-800">{f.title}</div>
                        {f.evidence && <div className="text-xs text-slate-500 mt-1">{f.evidence}</div>}
                        {f.recommended_action && (
                          <div className="text-xs mt-2 px-3 py-2 rounded-[10px] bg-slate-50 border border-slate-100">
                            <span className="font-semibold text-slate-600">{t('anomalyCenter.recommended_label')} </span>
                            <span className="text-slate-600">{f.recommended_action}</span>
                          </div>
                        )}
                        {f.resolution_reason && (
                          <div className="text-[11px] text-slate-400 mt-2">{t('anomalyCenter.reason_label')} <MentionText text={f.resolution_reason} /></div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {val && <div className="text-sm font-bold font-heading num text-slate-700">{val}</div>}
                        {f.confidence != null && <div className="text-[11px] text-slate-400">{t('anomalyCenter.confidence', { pct: Math.round(f.confidence * 100) })}</div>}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                      {f.route && (
                        <ButtonV2 size="sm" variant="outline" onClick={() => navigate(f.route!)}>{t('anomalyCenter.open_source')}</ButtonV2>
                      )}
                      <NotesButton entityType="anomaly" entityId={f.id} entityLabel={f.title} route="/anomaly-center" />
                      {isOpen && (
                        <>
                          {f.status !== 'acknowledged' && (
                            <ButtonV2 size="sm" variant="outline" onClick={() => setStatus(f.id, 'acknowledged')}>{t('anomalyCenter.acknowledge')}</ButtonV2>
                          )}
                          <ButtonV2 size="sm" variant="outline" icon={<CheckCircle2 />}
                            className="text-green-700 hover:bg-green-50 hover:border-green-200"
                            onClick={() => { setReasonFor({ id: f.id, action: 'resolved' }); setReasonText(''); }}>
                            {t('anomalyCenter.resolve')}
                          </ButtonV2>
                          <ButtonV2 size="sm" variant="ghost"
                            onClick={() => { setReasonFor({ id: f.id, action: 'dismissed' }); setReasonText(''); }}>
                            {t('anomalyCenter.dismiss')}
                          </ButtonV2>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <TablePaginationV2 controls={findingPager} label={t('anomalyCenter.nounFindings', 'findings')} />
          </>
        )}
      </SectionCard>

      {/* Reason capture modal (feedback signal) */}
      {reasonFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(4px)' }} onClick={e => { if (e.target === e.currentTarget) setReasonFor(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="text-lg font-heading font-semibold mb-1">{reasonFor.action === 'resolved' ? t('anomalyCenter.modal_resolve_title') : t('anomalyCenter.modal_dismiss_title')}</div>
            <div className="text-xs text-slate-500 mb-4">
              {t('anomalyCenter.modal_hint')}
            </div>
            <MentionTextarea
              value={reasonText}
              onChange={setReasonText}
              onMentionsChange={setReasonMentions}
              placeholder={reasonFor.action === 'resolved' ? t('anomalyCenter.placeholder_resolve') : t('anomalyCenter.placeholder_dismiss')}
              style={{ minHeight: 90 }}
              autoFocus
            />
            <div className="mt-3">
              <CcSelect value={reasonCc} onChange={setReasonCc} label={t('anomalyCenter.also_notify_cc')} excludeIds={[activeProfile.id]} />
            </div>
            <div className="flex gap-3 mt-4">
              <ButtonV2 variant="outline" className="flex-1" onClick={() => setReasonFor(null)}>{t('anomalyCenter.cancel')}</ButtonV2>
              <ButtonV2 variant="primary" className="flex-1" disabled={!reasonText.trim()} onClick={submitReason}>
                {reasonFor.action === 'resolved' ? t('anomalyCenter.confirm_resolve') : t('anomalyCenter.confirm_dismiss')}
              </ButtonV2>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
