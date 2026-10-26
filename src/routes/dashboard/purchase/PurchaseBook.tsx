import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SkeletonRows } from '../../../components/ui/states';
import { OtherPayments } from './OtherPayments';
import meta from '../../../lib/purchaseBookMeta.json';
import { fmtINR, useOverviewKPIs } from '../../../hooks/useBusyData';
import { BusyPurchasesCard } from '../../../components/BusyPurchasesCard';
import { SegmentTabs } from '../../../components/v2/SegmentTabs';
import { StatCard, InfoBanner } from '../../../components/v2';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useTextFilter } from '../../../components/ui/TableSearch';
import { TableSearch } from '../../../components/ui/TableSearch';
import { supabase } from '../../../lib/supabase';
import type { Database } from '../../../lib/database.types';

type DispatchRow = Database['public']['Tables']['dispatch_logs']['Row'];

function LiveDispatch() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<DispatchRow[]>([]);

  useEffect(() => {
    void supabase.from('dispatch_logs').select('*').order('date', { ascending: false }).limit(40).returns<DispatchRow[]>()
      .then(({ data }) => { if (data) setRows(data); });
  }, []);

  return (
    <div className="card2 p-4 mb-4">
      <div className="text-sm font-bold mb-1">{t('book.liveDispatch', 'In transit from requirements')}</div>
      <p className="text-xs text-slate-500 mb-3">{t('book.liveDispatchHint', 'Written when a buyer marks a requirement in transit. The sheet below is the older workbook.')}</p>
      <div className="overflow-x-auto">
        <table className="dt2 text-sm">
          <thead>
            <tr>
              <th>{t('book.colDate', 'Date')}</th>
              <th>{t('book.colItem', 'Item')}</th>
              <th>{t('book.colSupplier', 'Supplier')}</th>
              <th>{t('book.colVehicle', 'Vehicle')}</th>
              <th>{t('book.colDestination', 'Destination')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="text-center text-slate-400 py-4">{t('book.liveDispatchEmpty', 'Nothing in transit from a requirement yet.')}</td></tr>}
            {rows.map(row => (
              <tr key={row.id}>
                <td>{row.date}</td>
                <td>{row.item || '—'}</td>
                <td>{row.supplier || '—'}</td>
                <td>{row.vehicle_no || '—'}</td>
                <td>{row.destination || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const BOOK_TABS = ['purchases', 'payments', 'paraffin', 'requirements', 'dispatch', 'kolkata', 'shd'] as const;
export type BookTab = (typeof BOOK_TABS)[number];

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

function dateKey(value: unknown): number {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || ''));
  if (!m) return 0;
  return Number(m[3] + m[2] + m[1]);
}

function isBookTab(value: string): value is BookTab {
  return (BOOK_TABS as readonly string[]).includes(value);
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
      const book = mod.default as Record<BookTab, Row[]>;
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

  useEffect(() => {
    setQ('');
    setStatus('all');
  }, [active]);

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

  const source = rows?.[active] ?? [];
  const statuses = useMemo(() => {
    const found = new Set<string>();
    for (const row of source) {
      if (typeof row.status === 'string' && row.status) found.add(row.status);
    }
    return [...found];
  }, [source]);

  const prepared = useMemo(() => {
    let rows = source;
    if (active === 'purchases' && hideChlorine) rows = rows.filter(r => !r.chlorine);
    if (status !== 'all') rows = rows.filter(r => r.status === status);
    return [...rows].sort((a, b) => dateKey(b.date) - dateKey(a.date));
  }, [source, active, hideChlorine, status]);

  const columns = COLUMNS[active];
  const filtered = useTextFilter(prepared, q, row =>
    columns.map(col => {
      const value = row[col.key];
      return value == null ? '' : String(value);
    }),
  );
  const { data: busy } = useOverviewKPIs();
  const page = usePagination(filtered, { resetKey: `${active}|${q}|${status}|${hideChlorine}` });

  if (!rows) {
    return <div className="card2 p-5"><SkeletonRows rows={8} /></div>;
  }

  return (
    <>
      <InfoBanner className="mb-4">
        {t('book.bannerLive', 'Tiles and tables marked Busy come straight from Busy, read only. The sheets below are the Purchase 2026-27 workbook. Supplier spellings are folded together. Account numbers are not kept here.')}
      </InfoBanner>

      <SegmentTabs
        className="mb-4"
        value={active}
        onChange={onTab}
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
              caption={t('book.marineAsOf', 'Running balance on {{date}}', { date: meta.marineAsOf })}
            />
          </div>
        </div>
      )}

      {active === 'purchases' && <BusyPurchasesCard />}
      {active === 'payments' && <OtherPayments />}
      {active === 'dispatch' && <LiveDispatch />}

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
                <th key={col.key} className={col.money ? 'num' : undefined}>{col.label}</th>
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
                  const shown = value == null || value === ''
                    ? '—'
                    : col.money && typeof value === 'number'
                      ? fmtINR(value)
                      : String(value);
                  return <td key={col.key} className={col.money ? 'num' : undefined}>{shown}</td>;
                })}
              </tr>
            ))}
            {page.pageRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="text-center text-slate-400 py-6 text-sm">
                  {t('book.empty', 'Nothing on this sheet matches.')}
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
      onTab={next => setParams({ tab: next }, { replace: true })}
    />
  );
}
