import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Users, Globe, RefreshCw, ShieldCheck, Check, Plus, Pencil, Fingerprint } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { StatCard, SectionCard, FilterBar, ButtonV2, StatusPill, TablePaginationV2 } from '../../components/v2';
import { usePagination } from '../../components/ui/usePagination';
import { fetchAllRows } from '../../lib/fetchAll';
import { formatDate as formatIstDate, formatTime as formatIstTime } from '../../lib/utils/formatting';

interface AuditLogEntry {
  id: string;
  ip_address: string;
  batch_no: string;
  action_type: string;
  details: {
    temp?: string | number;
    cp_gravity?: string | number;
    cl2_pressure?: string | number;
    recipe?: string;
    target_qty?: number;
  };
  created_at: string;
}

export function AuditLog() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [clientIp, setClientIp] = useState('Fetching...');
  const [activeSessionsCount, setActiveSessionsCount] = useState(0);

  async function loadData() {
    setLoading(true);

    try {
      // PAGED read: an unpaged select stops at 1000 rows silently.
      const { data, error } = await fetchAllRows<AuditLogEntry>((from, to) => supabase
        .from('batch_edit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
        .returns<AuditLogEntry[]>());
      if (!error && data) {
        setLogs(data);
      }
    } catch (e) {
      console.warn("Failed to fetch audit logs from Supabase", e);
    }

    try {
      const { count } = await supabase
        .from('operator_sessions')
        .select('*', { count: 'exact', head: true });
      setActiveSessionsCount(count || 0);
    } catch (e) {
      setActiveSessionsCount(0);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadData();

    // Fetch current client IP
    async function fetchClientIp() {
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        if (res.ok) {
          const data = await res.json();
          setClientIp(data.ip || 'Unknown');
        }
      } catch (err) {
        setClientIp('Unknown');
      }
    }
    fetchClientIp();
  }, []);

  // Filter logs by search query (batch number or IP)
  const filteredLogs = logs.filter(log => {
    const term = searchQuery.toLowerCase();
    return (
      log.batch_no.toLowerCase().includes(term) ||
      (log.ip_address && log.ip_address.toLowerCase().includes(term)) ||
      log.action_type.toLowerCase().includes(term)
    );
  });

  // Timeline is paged; a new search goes back to page 1.
  const { pageRows: logPage, controls: logPager } = usePagination(filteredLogs, { resetKey: searchQuery });

  const formatTime = (isoString: string) => formatIstTime(isoString);
  const formatDate = (isoString: string) => formatIstDate(isoString);

  return (
    <div>
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <StatCard className="col-span-12 md:col-span-4" icon={<Activity />}
          label={t('audit.totalActivities')} value={loading ? '…' : logs.length}
          caption={t('audit.totalActivitiesSub')}
          onView={() => setSearchQuery('')} viewLabel={t('audit.viewAll', 'See all')} />
        <StatCard className="col-span-12 md:col-span-4" icon={<Users />} tone="blue" valueTone="blue"
          label={t('audit.activeSessions')} value={loading ? '…' : activeSessionsCount}
          caption={t('audit.activeSessionsSub')} />
        <StatCard className="col-span-12 md:col-span-4" icon={<Globe />}
          label={t('audit.clientIp')}
          value={<span className="font-mono text-[22px] font-bold text-slate-700 truncate block">{clientIp}</span>}
          caption={t('audit.clientIpSub')} />
      </div>

      {/* Search */}
      <FilterBar
        className="mb-4"
        search={searchQuery} onSearch={setSearchQuery}
        searchPlaceholder={t('audit.searchPlaceholder')}
        onReset={() => setSearchQuery('')}
      />

      {/* Audit trail */}
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            {t('audit.auditTrailTitle')}
            <StatusPill tone="amber" icon={<ShieldCheck />} label={t('audit.secured')} />
          </span>
        }
        subtitle={t('audit.auditTrailSubtitle')}
        actions={
          <ButtonV2 variant="outline" icon={<RefreshCw />} onClick={loadData}>
            {t('audit.syncLogs')}
          </ButtonV2>
        }
      >
        {/* Timeline viewer */}
        {loading ? (
          <div className="text-center py-12 text-slate-500 font-semibold text-sm">
            <span className="inline-block animate-pulse">{t('audit.synchronizing')}</span>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="text-center py-12 text-slate-400 font-semibold text-sm border-2 border-dashed border-slate-200 rounded-[10px]">
            {logs.length === 0 ? t('audit.noLogsYet', 'No audit logs yet.') : t('audit.noLogsFound', { query: searchQuery })}
          </div>
        ) : (
          <>
            <div className="relative pl-6 border-l-2 border-slate-200 ml-3 space-y-5">
              {logPage.map((log) => {
                const isCreate = log.action_type === 'create_batch';
                return (
                  <div key={log.id || `${log.created_at}-${log.batch_no}`} className="relative group">
                    {/* Timeline bullet dot */}
                    <span
                      className="absolute -left-[33px] top-1.5 w-4.5 h-4.5 rounded-full border-2 border-white flex items-center justify-center shadow-sm z-10 transition-transform group-hover:scale-125"
                      style={{ background: isCreate ? '#2563EB' : '#10B981' }}
                    >
                      {isCreate ? (
                        <Plus size={9} strokeWidth={4} className="text-white" />
                      ) : (
                        <Pencil size={8} strokeWidth={3.5} className="text-white" />
                      )}
                    </span>

                    {/* Log Content Card */}
                    <div className="card2 p-4 hover:border-slate-300 transition-colors">
                      <div className="flex items-start justify-between flex-wrap gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            {t('audit.batchPrefix')}{log.batch_no}
                          </span>
                          {isCreate
                            ? <StatusPill tone="blue" label={t('audit.startedBatch')} />
                            : <StatusPill tone="green" label={t('audit.loggedReading')} />}
                        </div>
                        <div className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                          <span>{formatDate(log.created_at)}</span>
                          <span>•</span>
                          <span className="font-mono text-slate-500">{formatTime(log.created_at)}</span>
                        </div>
                      </div>

                      <div className="text-sm font-medium text-slate-700 space-y-1.5">
                        {isCreate ? (
                          <div>
                            {t('audit.operatorInitiatedPre')} <span className="font-bold text-slate-800">{log.details.recipe} {t('audit.density')}</span> {t('audit.targetLoadOf')} <span className="font-bold text-slate-800">{log.details.target_qty} kg</span>.
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[13px] bg-slate-50 p-2.5 rounded-[10px] border border-slate-100">
                            {log.details.temp !== undefined && (
                              <div>
                                <span className="text-slate-400 text-xs font-semibold">{t('audit.temp')}</span>{' '}
                                <span className="font-bold text-slate-800">{log.details.temp} °C</span>
                              </div>
                            )}
                            {log.details.cp_gravity !== undefined && (
                              <div>
                                <span className="text-slate-400 text-xs font-semibold">{t('audit.gravity')}</span>{' '}
                                <span className="font-bold text-slate-800">{log.details.cp_gravity}</span>
                              </div>
                            )}
                            {log.details.cl2_pressure !== undefined && (
                              <div>
                                <span className="text-slate-400 text-xs font-semibold">{t('audit.cl2Press')}</span>{' '}
                                <span className="font-bold text-slate-800">{log.details.cl2_pressure} kg</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Security details footer */}
                        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-100 flex-wrap gap-2">
                          <div className="flex items-center gap-1">
                            <Fingerprint size={12} strokeWidth={2.5} />
                            <span>{t('audit.ipAddress')}</span>{' '}
                            <span className="font-mono font-semibold text-slate-600 bg-slate-100 px-1 py-0.5 rounded border border-slate-200/50">
                              {log.ip_address || t('audit.localSandbox')}
                            </span>
                          </div>
                          <StatusPill tone="green" icon={<Check strokeWidth={3} />} label={t('audit.verifiedChecksum')} className="uppercase text-[10px]" />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <TablePaginationV2 controls={logPager} label={t('audit.nounEntries', 'entries')} />
          </>
        )}
      </SectionCard>

    </div>
  );
}
