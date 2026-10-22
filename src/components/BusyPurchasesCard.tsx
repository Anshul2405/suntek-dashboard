import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { SkeletonRows } from './ui/states';
import { usePagination } from './ui/usePagination';
import { TablePaginationV2 as TablePagination } from './v2';
import { TableSearch, useTextFilter } from './ui/TableSearch';
import { fmtINR, useBusyPurchases, useOverviewKPIs } from '../hooks/useBusyData';
import { useBusyCompany } from '../contexts/BusyCompanyContext';

function fmtBusyDate(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function BusyPurchasesCard({ className = 'mb-4' }: { className?: string }) {
  const { t } = useTranslation();
  const { code } = useBusyCompany();
  const { data, isLoading, isError } = useBusyPurchases();
  const { data: overview } = useOverviewKPIs();
  const [searchParams] = useSearchParams();
  const linkedQ = (searchParams.get('busy') || '').trim();
  const [q, setQ] = useState(linkedQ);
  const [seenQ, setSeenQ] = useState(linkedQ);
  if (linkedQ !== seenQ) {
    setSeenQ(linkedQ);
    setQ(linkedQ);
  }
  const rows = useMemo(() => data ?? [], [data]);
  const filtered = useTextFilter(rows, q, (row) => [row.supplier, row.item, row.invoice, row.company, row.date]);
  const page = usePagination(filtered, { resetKey: `${code}|${q}` });
  const total = useMemo(() => filtered.reduce((sum, row) => sum + (Number(row.amount) || 0), 0), [filtered]);
  const showCompany = code === 'all';
  const cols = showCompany ? 6 : 5;

  return (
    <div className={`card2 p-4 ${className}`}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between mb-3">
        <div>
          <div className="text-sm font-bold mb-1">{t('book.busyPurchases', { defaultValue: 'Purchase invoices from Busy' })}</div>
          <p className="text-xs text-slate-500">{t('book.busyPurchasesHint', { defaultValue: 'Read only. The dashboard never writes back to Busy. The sheet below is the older workbook.' })}</p>
        </div>
        <div className="text-xs text-slate-500 tabular-nums md:text-right shrink-0 space-y-0.5">
          {overview?.purchaseMTD ? (
            <div className="text-slate-700 font-semibold">
              {t('book.busyPurchasesMtd', { defaultValue: 'This month in Busy: {{amount}}', amount: fmtINR(overview.purchaseMTD) })}
            </div>
          ) : null}
          {rows.length > 0 && (
            <div>{t('book.busyPurchasesTotal', { defaultValue: 'Latest {{count}} invoices · {{amount}}', count: filtered.length, amount: fmtINR(total) })}</div>
          )}
        </div>
      </div>
      {rows.length > 0 && (
        <div className="mb-3">
          <TableSearch value={q} onChange={setQ} placeholder={t('book.busyPurchasesSearch', { defaultValue: 'Search supplier, item or invoice…' })} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="dt2 text-sm">
          <thead>
            <tr>
              <th>{t('book.colDate', 'Date')}</th>
              {showCompany && <th>{t('book.colCompany', { defaultValue: 'Company' })}</th>}
              <th>{t('book.colSupplier', 'Supplier')}</th>
              <th>{t('book.colItem', 'Item')}</th>
              <th>{t('book.colInvoice', { defaultValue: 'Invoice' })}</th>
              <th className="num">{t('book.colAmount', { defaultValue: 'Amount' })}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={cols}><SkeletonRows rows={5} /></td></tr>}
            {!isLoading && (isError || rows.length === 0) && (
              <tr><td colSpan={cols} className="text-center text-slate-400 py-4">{t('book.busyPurchasesEmpty', { defaultValue: 'The last Busy read does not include purchase invoices yet. Sales and the overview stay on that read.' })}</td></tr>
            )}
            {!isLoading && rows.length > 0 && filtered.length === 0 && (
              <tr><td colSpan={cols} className="text-center text-slate-400 py-4">{t('book.busyPurchasesNoMatch', { defaultValue: 'No Busy purchase matches this search.' })}</td></tr>
            )}
            {page.pageRows.map((row, i) => (
              <tr key={`${row.company}-${row.invoice}-${row.date}-${i}`}>
                <td className="whitespace-nowrap tabular-nums">{row.date ? fmtBusyDate(row.date) : '—'}</td>
                {showCompany && <td className="whitespace-nowrap">{row.company || '—'}</td>}
                <td>{row.supplier || '—'}</td>
                <td>{row.item || '—'}</td>
                <td className="tabular-nums">{row.invoice || '—'}</td>
                <td className="num whitespace-nowrap">{fmtINR(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > 0 && <TablePagination controls={page.controls} />}
    </div>
  );
}
