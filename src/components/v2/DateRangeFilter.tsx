import { useTranslation } from 'react-i18next';
import { normalizeDayRange, formatDate } from '../../lib/utils/formatting';
import { cn } from '../../lib/utils/cn';
import { DateInput } from '../ui/DateInput';

/**
 * From / To calendar-day filter, shared by every list (Maintenance, Store Req,
 * Stock, Activity Log, FAR, Sales, Incidents, Upload History, Night duty).
 *
 * Contract (lib/utils/formatting → inIstDayRange):
 *  • days are IST calendar days and BOTH ends are inclusive;
 *  • an empty bound is no filter;
 *  • To before From is swapped and said out loud — never a silently empty table.
 * Values are 'YYYY-MM-DD' (what <input type="date"> produces).
 */
export function DateRangeFilter({
  from, to, onChange, className, label,
}: {
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
  className?: string;
  label?: string;
}) {
  const { t } = useTranslation();
  const { swapped, from: f, to: tt } = normalizeDayRange(from, to);
  const input = 'px-2.5 py-2 rounded-[10px] border border-slate-200 text-[12.5px] bg-white focus:outline-none focus:ring-2 focus:ring-slate-200';
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="date-range-filter">
      <span className="text-[11px] text-slate-500 font-medium px-0.5">{label ?? t('common.dateRange', 'Date (from – to)')}</span>
      {/* Phones: the two boxes share the row (no box past the card edge). */}
      <div className="flex items-center gap-1.5 max-sm:w-full">
        <span className="max-sm:flex-1 max-sm:min-w-0">
          <DateInput aria-label={t('common.fromDate', 'From')} value={from}
            onChange={e => onChange({ from: e.target.value, to })} className={cn(input, 'max-sm:w-full')} />
        </span>
        <span className="text-slate-400 text-xs">–</span>
        <span className="max-sm:flex-1 max-sm:min-w-0">
          <DateInput aria-label={t('common.toDate', 'To')} value={to}
            onChange={e => onChange({ from, to: e.target.value })} className={cn(input, 'max-sm:w-full')} />
        </span>
        {(from || to) && (
          <button type="button" onClick={() => onChange({ from: '', to: '' })}
            className="text-[11.5px] font-semibold text-slate-500 hover:text-slate-800 px-1 max-sm:min-w-[44px] max-sm:min-h-[44px]"
            title={t('common.clearDates', 'Clear dates')}>✕</button>
        )}
      </div>
      {swapped && (
        <span className="text-[10.5px] text-amber-700 px-0.5" role="status">
          {t('common.datesSwapped', { defaultValue: 'Showing {{from}} – {{to}} (dates were reversed)', from: formatDate(f), to: formatDate(tt) })}
        </span>
      )}
    </div>
  );
}
