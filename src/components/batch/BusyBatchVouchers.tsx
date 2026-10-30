import { useTranslation } from 'react-i18next';
import { fmtINR, type BusyBatchVoucher } from '../../hooks/useBusyData';
import { useBusyCompany } from '../../contexts/BusyCompanyContext';
import { formatDate } from '../../lib/utils/formatting';

/**
 * Busy manufacturing vouchers (VchType 5) for the company picked in the top
 * bar, from the last Busy read. Read only: these are Busy's voucher numbers,
 * not the plant batch-sheet numbers (P26-12), and nothing here fills, links or
 * writes either one.
 */
export function BusyBatchVouchers({ rows, loading, error, plantBatchNos }: {
  rows: BusyBatchVoucher[] | undefined;
  loading: boolean;
  error: boolean;
  /** Plant batch-sheet numbers on this page (upper case) — only to mark an exact same number. */
  plantBatchNos: Set<string>;
}) {
  const { t } = useTranslation();
  const { code } = useBusyCompany();
  const list = rows ?? [];
  const showCompany = code === 'all';
  return (
    <div className="card2 p-6 mb-5">
      <div className="text-base font-bold font-heading">{t('batchProd.busyVouchersTitle', 'Busy manufacturing vouchers (this company, last read)')}</div>
      <div className="text-xs text-slate-500 mb-3">
        {t('batchProd.busyVouchersSub', 'From the last Busy read, VchType 5 — Busy’s voucher number, not the plant batch-sheet number. Read only.')}
      </div>
      {loading ? (
        <div className="text-sm text-slate-400">…</div>
      ) : error ? (
        <div className="text-sm text-amber-700">{t('batchProd.busyVouchersDown', 'The Busy feed could not be read, so no manufacturing vouchers are shown.')}</div>
      ) : list.length === 0 ? (
        <div className="text-sm text-slate-400">{t('batchProd.busyVouchersEmpty', 'No manufacturing vouchers for this company in the last Busy read.')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="dt2 text-sm">
            <thead>
              <tr>
                <th>{t('batchProd.busyColVoucher', 'Voucher no')}</th>
                <th>{t('batchProd.busyColDate', 'Date')}</th>
                {showCompany && <th>{t('batchProd.busyColCompany', 'Company')}</th>}
                <th className="num">{t('batchProd.busyColAmount', 'Amount')}</th>
                <th>{t('batchProd.busyColParty', 'Party')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((v, i) => (
                <tr key={`${v.company ?? ''}|${v.batchNo}|${v.date}|${i}`}>
                  <td className="font-mono">
                    {v.batchNo}
                    {plantBatchNos.has((v.batchNo || '').trim().toUpperCase()) && (
                      <div className="text-[10px] text-slate-400">{t('batchProd.busyAlsoPlant', 'same number as a plant batch sheet')}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{v.date ? formatDate(v.date) : '—'}</td>
                  {showCompany && <td>{v.company || '—'}</td>}
                  <td className="num tabular-nums">{Number.isFinite(Number(v.amount)) ? fmtINR(Number(v.amount)) : '—'}</td>
                  <td>{v.party || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
