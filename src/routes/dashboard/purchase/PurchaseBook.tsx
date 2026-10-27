import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SkeletonRows } from '../../../components/ui/states';
import meta from '../../../lib/purchaseBookMeta.json';
import { fmtINR, useOverviewKPIs } from '../../../hooks/useBusyData';
import { BusyPurchasesCard } from '../../../components/BusyPurchasesCard';
import { SegmentTabs } from '../../../components/v2/SegmentTabs';
import { StatCard, InfoBanner } from '../../../components/v2';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useTextFilter } from '../../../components/ui/TableSearch';
import { TableSearch } from '../../../components/ui/TableSearch';
import { formatDate } from '../../../lib/utils/formatting';
import { DispatchLog } from './DispatchLog';

const BOOK_TABS = ['purchases', 'payments', 'paraffin', 'requirements', 'dispatch', 'kolkata', 'shd'] as const;
type BookTab = (typeof BOOK_TABS)[number];

type Row = Record<string, string | number | boolean | null>;

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  updated: { bg: '#CFFAFE', color: '#0E7490' },
  input: { bg: '#FFEDD5', color: '#C2410C' },
  done: { bg: '#DCFCE7', color: '#15803D' },
  stopped: { bg: '#FEE2E2', color: '#B91C1C' },
  pending: { bg: '#FEF9C3', color: '#A16207' },
  received: { bg: '#DCFCE7', color: '#15803D' },
  approved: { bg: '#FEF9C3', color: '#A16207' },
  dispatched: { bg: '#FFEDD5', color: '#C2410C' },
  proforma: { bg: '#F3E8FF', color: '#7E22CE' },
  open: { bg: '#F1F5F9', color: '#475569' },
};

const COLUMNS: Record<BookTab, Array<{ key: string; label: string; money?: boolean }>> = {
  purchases: [
    { key: 'date', label: 'Date' },
    { key: 'company', label: 'Company' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'item', label: 'Item' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'qty', label: 'Qty' },
    { key: 'amount', label: 'Amount', money: true },
    { key: 'status', label: 'Payment' },
    { key: 'place', label: 'Place' },
  ],
  payments: [
    { key: 'date', label: 'Date' },
    { key: 'company', label: 'Company' },
    { key: 'beneficiary', label: 'Beneficiary' },
    { key: 'amount', label: 'Amount', money: true },
    { key: 'status', label: 'Status' },
    { key: 'inputer', label: 'Input by' },
    { key: 'remarks', label: 'Remarks' },
  ],
  paraffin: [
    { key: 'date', label: 'Date' },
    { key: 'company', label: 'Company' },
    { key: 'party', label: 'Party' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'qty', label: 'Qty' },
    { key: 'payable', label: 'Payable', money: true },
    { key: 'due', label: 'Due' },
    { key: 'cheque', label: 'Cheque' },
  ],
  requirements: [
    { key: 'date', label: 'Date' },
    { key: 'company', label: 'Company' },
    { key: 'item', label: 'Item' },
    { key: 'qty', label: 'Qty' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'status', label: 'Status' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'amount', label: 'Amount' },
  ],
  dispatch: [
    { key: 'date', label: 'Date' },
    { key: 'destination', label: 'Destination' },
    { key: 'document', label: 'Document' },
    { key: 'from', label: 'From' },
    { key: 'sender', label: 'Sender' },
    { key: 'receiver', label: 'Receiver' },
    { key: 'vehicle', label: 'Vehicle' },
    { key: 'received', label: 'Received' },
  ],
  kolkata: [
    { key: 'date', label: 'Date' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'material', label: 'Material' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'qty', label: 'Qty' },
    { key: 'rate', label: 'Rate', money: true },
    { key: 'amount', label: 'Amount', money: true },
  ],
  shd: [
    { key: 'date', label: 'Date' },
    { key: 'company', label: 'Company' },
    { key: 'gravity', label: 'Gravity' },
    { key: 'qty', label: 'Qty' },
    { key: 'price', label: 'Price' },
    { key: 'amount', label: 'Amount', money: true },
    { key: 'truck', label: 'Truck' },
  ],
};

const WORKBOOK_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function dateKey(value: unknown): number {
  const m = WORKBOOK_DATE.exec(String(value || ''));
  if (!m) return 0;
  return Number(m[3] + m[2] + m[1]);
}

/** The workbook writes dates as 22.10.2026; show them like every other screen. */
function bookDate(value: unknown): string {
  const m = WORKBOOK_DATE.exec(String(value ?? '').trim());
  return m ? formatDate(`${m[3]}-${m[2]}-${m[1]}`) : String(value ?? '');
}

function isBookTab(value: string): value is BookTab {
  return (BOOK_TABS as readonly string[]).includes(value);
}

function cellText(value: Row[string], money?: boolean): string {
  if (value == null || value === '') return '—';
  if (money && typeof value === 'number') return fmtINR(value);
  return bookDate(value);
}

export function PurchaseBook({ tab, onTab }: { tab: string; onTab: (tab: BookTab) => void }) {
  const { t } = useTranslation();
  const active: BookTab = isBookTab(tab) ? tab : 'purchases';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [hideChlorine, setHideChlorine] = useState(true);
  const [rows, setRows] = useState<Record<BookTab, Row[]> | null>(null);

  useEffect(() => {
    let alive = true;
    // The workbook is a large JSON file. Load it after the page shell so
    // opening Purchase book does not freeze the tab on the parse.
    import('../../../lib/purchaseBook.json').then(mod => {
      if (!alive) return;
      const book = mod.default as unknown as Record<BookTab, Row[]>;
      setRows({
        purchases: book.purchases,
        payments: book.payments,
        paraffin: book.paraffin,
        requirements: book.requirements,
        dispatch: book.dispatch,
        kolkata: book.kolkata,
        shd: book.shd,
      });
    });
    return () => { alive = false; };
  }, []);

  // A new sheet starts unfiltered.
  const changeTab = (next: BookTab) => {
    setQ('');
    setStatus('all');
    onTab(next);
  };

  const statusLabel = (code: string) => {
    const labels: Record<string, string> = {
      updated: t('book.statusUpdated', 'Updated in Busy'),
      input: t('book.statusInput', 'Input done'),
      done: t('book.statusDone', 'Payment done'),
      stopped: t('book.statusStopped', 'Stopped'),
      pending: t('book.statusPending', 'Pending'),
      received: t('book.statusReceived', 'Received at factory'),
      approved: t('book.statusApproved', 'Approved'),
      dispatched: t('book.statusDispatched', 'Dispatched'),
      proforma: t('book.statusProforma', 'Proforma checked'),
      open: t('book.statusOpen', 'Open'),
    };
    return labels[code] || code;
  };

  const source = useMemo(() => rows?.[active] ?? [], [rows, active]);
  const statuses = useMemo(() => {
    const found = new Set<string>();
    for (const row of source) {
      if (typeof row.status === 'string' && row.status) found.add(row.status);
    }
    return [...found];
  }, [source]);

  const prepared = useMemo(() => {
    let list = source;
    if (active === 'purchases' && hideChlorine) list = list.filter(r => !r.chlorine);
    if (status !== 'all') list = list.filter(r => r.status === status);
    return [...list].sort((a, b) => dateKey(b.date) - dateKey(a.date));
  }, [source, active, hideChlorine, status]);

  const columns = COLUMNS[active];
  // Search what is on screen, so 22/10/2026 finds a row the workbook wrote as 22.10.2026.
  const filtered = useTextFilter(prepared, q, row => columns.map(col => cellText(row[col.key], col.money)));
  const { data: busy } = useOverviewKPIs();
  const page = usePagination(filtered, { resetKey: `${active}|${q}|${status}|${hideChlorine}` });

  if (!rows) {
    return <div className="card2 p-5"><SkeletonRows rows={8} /></div>;
  }

  const filtersOn = q.trim() !== '' || status !== 'all';

  return (
    <>
      <InfoBanner className="mb-4">
        {t('book.bannerLive', 'Tiles and tables marked Busy come straight from Busy, read only. The sheets below are the Purchase 2026-27 workbook. Supplier spellings are folded together. Account numbers are not kept here.')}
      </InfoBanner>

      <SegmentTabs
        className="mb-4"
        value={active}
        onChange={changeTab}
        items={BOOK_TABS.map(key => ({
          key,
          label: ({
            purchases: t('book.tabPurchases', 'Purchases'),
            payments: t('book.tabPayments', 'Payments'),
            paraffin: t('book.tabParaffin', 'Paraffin payments'),
            requirements: t('book.tabRequirements', 'Requirements'),
            dispatch: t('book.tabDispatch', 'Dispatch'),
            kolkata: t('book.tabKolkata', 'Kolkata'),
            shd: t('book.tabShd', 'SHD'),
          })[key],
          count: rows[key].length,
        }))}
      />

      {active === 'purchases' && (
        <div className="grid grid-cols-12 gap-4 mb-4">
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <StatCard
              label={t('book.busyPurchaseMtd', 'Purchase this month · Busy')}
              value={busy ? fmtINR(busy.purchaseMTD) : '…'}
              caption={busy?.purchaseNote || t('book.busyPurchaseMtdCaption', 'Purchase invoices in Busy, chlorine left out')}
            />
          </div>
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <StatCard
              label={t('book.busyPaymentsMtd', 'Paid to suppliers this month · Busy')}
              value={busy ? fmtINR(busy.paymentsMTD) : '…'}
              caption={t('book.busyPaymentsMtdCaption', 'Payment vouchers in Busy, up to today')}
            />
          </div>
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <StatCard
              label={t('book.sepPurchaseWorkbook', 'September purchase · workbook')}
              value={fmtINR(meta.purchaseSeptemberExChlorine)}
              caption={t('book.sepPurchaseCaption', 'Liquid chlorine token lines left out. Chlorinated paraffin stays in.')}
            />
          </div>
          <div className="col-span-12 sm:col-span-6 lg:col-span-3">
            <StatCard
              label={t('book.marineCoverWorkbook', 'Marine cover · workbook')}
              value={fmtINR(meta.marineBalance)}
              caption={t('book.marineAsOf', { defaultValue: 'Running balance on {{date}}', date: bookDate(meta.marineAsOf) })}
            />
          </div>
        </div>
      )}

      {active === 'purchases' && <BusyPurchasesCard />}
      {active === 'dispatch' && <DispatchLog />}

      {active === 'payments' && (
        <div className="grid grid-cols-12 gap-4 mb-4">
          <div className="col-span-12 sm:col-span-6">
            <StatCard label={t('book.statusUpdated', 'Updated in Busy')} value={String(meta.paymentCounts.updated ?? 0)} caption={t('book.colourCyan', 'Cyan amount cell on the Payments sheet')} />
          </div>
          <div className="col-span-12 sm:col-span-6">
            <StatCard label={t('book.statusInput', 'Input done')} value={String(meta.paymentCounts.input ?? 0)} caption={t('book.colourInput', 'Orange amount cell — typed, not yet updated in Busy')} />
          </div>
        </div>
      )}

      <div className="text-sm font-bold mb-2">{t('book.workbookSheet', 'Workbook sheet (history, read only)')}</div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-full sm:w-72">
          <TableSearch value={q} onChange={setQ} placeholder={t('book.search', 'Search this sheet…')} />
        </div>
        {statuses.length > 0 && (
          <select
            className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={status}
            onChange={e => setStatus(e.target.value)}
          >
            <option value="all">{t('book.allStatuses', 'All statuses')}</option>
            {statuses.map(code => (
              <option key={code} value={code}>{statusLabel(code)}</option>
            ))}
          </select>
        )}
        {active === 'purchases' && (
          <label className="text-sm text-slate-600 flex items-center gap-2">
            <input type="checkbox" checked={hideChlorine} onChange={e => setHideChlorine(e.target.checked)} />
            {t('book.hideChlorine', 'Hide liquid chlorine')}
          </label>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="dt">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col.key} className={col.money ? 'num' : undefined}>{t(`book.col_${col.key}`, col.label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.pageRows.map((row, i) => (
              <tr key={`${active}-${page.controls.from + i}`}>
                {columns.map(col => {
                  const value = row[col.key];
                  if (col.key === 'status' && typeof value === 'string') {
                    const tone = STATUS_STYLE[value] || STATUS_STYLE.open;
                    return (
                      <td key={col.key}>
                        <span className="badge" style={{ background: tone.bg, color: tone.color }}>{statusLabel(value)}</span>
                      </td>
                    );
                  }
                  return (
                    <td key={col.key} className={col.money ? 'num' : col.key === 'date' ? 'whitespace-nowrap' : undefined}>
                      {cellText(value, col.money)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {page.pageRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="text-center text-slate-400 py-6 text-sm">
                  {filtersOn ? t('book.empty', 'Nothing on this sheet matches.') : t('book.emptySheet', 'This sheet has no rows.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <TablePagination controls={page.controls} />
    </>
  );
}

export function PurchaseBookPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'purchases';
  return (
    <PurchaseBook
      tab={tab}
      onTab={next => setParams(prev => { const p = new URLSearchParams(prev); p.set('tab', next); return p; }, { replace: true })}
    />
  );
}
