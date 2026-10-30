import { useTranslation } from 'react-i18next';
import { SectionCard } from './v2';
import { fmtINR, useSalesSites } from '../hooks/useBusyData';
import type { DeskSummary } from '../lib/salesDesks';

/**
 * NKG · Kolkata and SHD sales desks for the company picked in the top bar (or
 * all four). Read only. NKG · Kolkata = the NKG Plastochem book (0010) plus
 * parties named Kolkata / Calcutta / NKG in the other books (lib/salesDesks.ts).
 */
export function SalesDesksCard() {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useSalesSites();
  const desk = (d: DeskSummary | undefined, title: string, note: string) => (
    <div className="rounded-xl border border-slate-200 p-4 min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{title}</div>
      <div className="text-[24px] font-extrabold num mt-1">{isLoading ? '…' : d ? fmtINR(d.salesMTD) : '—'}</div>
      <div className="text-[11px] text-slate-500">
        {d && !isLoading
          ? d.invoiceCount == null
            ? t('desks.countUnknown', 'Invoice count: not in the feed for part of this desk')
            : t('desks.count', { defaultValue: '{{n}} invoices this month', n: d.invoiceCount })
          : ' '}
      </div>
      <div className="text-[11px] text-slate-400 mt-1">{note}</div>
      {d && d.top.length > 0 && (
        <ul className="mt-2 text-xs text-slate-700 space-y-0.5">
          {d.top.map((r) => (
            <li key={r.name} className="flex justify-between gap-2"><span className="truncate">{r.name}</span><span className="num">{fmtINR(r.salesMTD)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <SectionCard className="mb-4" title={t('desks.title', 'Sales desks · this month (Busy, read only)')}
      subtitle={t('desks.sub', 'NKG and Kolkata are one branch: the NKG Plastochem book (0010) plus parties named Kolkata, Calcutta or NKG in the other books. SHD = parties named SHD.')}>
      {isError ? (
        <p className="text-sm text-slate-500">{t('desks.down', 'The Busy feed could not be read, so the desks are not shown.')}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {desk(data?.kolkata, t('book.tabKolkata', 'NKG · Kolkata'), t('desks.kolkataNote', 'Whole 0010 book + Kolkata / Calcutta / NKG parties'))}
          {desk(data?.shd, t('desks.shd', 'SHD'), t('desks.shdNote', 'Parties named SHD (never NKG)'))}
        </div>
      )}
    </SectionCard>
  );
}
