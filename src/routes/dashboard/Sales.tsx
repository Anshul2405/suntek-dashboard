import React, { useState } from 'react';
import { EmptyState } from '../../components/ui/states';
import { usePagination } from '../../components/ui/usePagination';
import { useTextFilter } from '../../components/ui/TableSearch';
import { useSortable } from '../../components/ui/useSortable';
import {
  StatCard, SectionCard, FilterBar, ButtonV2, StatusPill, InfoBanner,
  TablePaginationV2 as TablePagination, ThV2 as Th,
} from '../../components/v2';
import {
  IndianRupee, Landmark, Users, Wallet, ReceiptText, Gauge, UserCheck,
  PieChart, Factory, ArrowLeftRight, Scale, Repeat, Download, Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SlidePanel } from '../../components/SlidePanel';
import type { SalesContract } from '../../hooks/useBusyData';
import { BUSY_COMPANIES } from '../../lib/busyCompanies';

/** The all-companies view labels a party "Name · Chlorides"; history searches by name. */
function customerSearchName(label: string): string {
  const m = label.match(/^(.*) · ([^·]+)$/);
  return m && BUSY_COMPANIES.some(c => c.short === m[2].trim()) ? m[1].trim() : label;
}
import { supabase } from '../../lib/supabase';
import { insertRows } from '../../lib/db';
import { useSalesMTD, useSalesContracts, useAnalyticsKPIs, fmtINR } from '../../hooks/useBusyData';
import { DeltaBadge, BulletCompare } from '../../components/charts/AnalyticsViz';
import { KpiInfoButton } from '../../components/KpiInfoButton';
import { exportToXlsx } from '../../lib/utils/exportXlsx';
import { useRoleContext } from '../../contexts/RoleContext';
import { profileCanAccess } from '../../lib/profiles';
import { useToast } from '../../components/ui/toast';
import { OcrUploadCard } from '../../components/OcrUploadCard';

// Sales sheet OCR upload is available to management/finance roles only.
const CAN_UPLOAD_SHEET = ['admin', 'unit_head', 'accountant_delhi', 'accountant_other'];

interface NewContractForm {
  customer: string;
  density: string;
  lockedPrice: string;
  bookedQty: string;
}

const DENSITY_OPTIONS = ['1300', '1400', '1450', '1500'];

export function Sales() {
  const { t } = useTranslation();
  const toast = useToast();
  const [showModal, setShowModal] = useState(false);
  const { activeProfile } = useRoleContext();
  const { data: salesKPIs } = useSalesMTD();
  const { data: liveContracts } = useSalesContracts();
  const [salesSearch, setSalesSearch] = useState('');
  // Row click opens a real detail (B6) — the row used to look clickable and do nothing.
  const [detail, setDetail] = useState<SalesContract | null>(null);
  const navigate = useNavigate();
  const contractRows = liveContracts || [];
  const filteredContracts = useTextFilter(contractRows, salesSearch, c => [c.customer, c.status]);
  const salesSort = useSortable(filteredContracts, {
    customer: c => c.customer,
    totalSales: c => c.totalSales,
    mtdSales: c => c.mtdSales,
    invoiceCount: c => c.invoiceCount,
    outstanding: c => c.outstanding,
    status: c => c.status,
  });
  const salesPg = usePagination(salesSort.sorted, { resetKey: `${salesSearch}|${salesSort.sort.key}|${salesSort.sort.dir}` });
  const { data: analytics } = useAnalyticsKPIs();

  function handleExport() {
    const rows = (liveContracts || []).map(c => ({
      customer: c.customer,
      totalSales: c.totalSales,
      mtdSales: c.mtdSales,
      invoiceCount: c.invoiceCount,
      outstanding: c.outstanding,
      status: c.status,
    }));
    exportToXlsx(
      rows,
      [
        { header: 'Customer', key: 'customer' },
        { header: 'FY Sales (₹)', key: 'totalSales' },
        { header: 'MTD Sales (₹)', key: 'mtdSales' },
        { header: 'Invoices', key: 'invoiceCount' },
        { header: 'Outstanding (₹)', key: 'outstanding' },
        { header: 'Status', key: 'status' },
      ],
      'sales-contracts',
      activeProfile,
      'Sales Contracts',
    );
  }

  const [form, setForm] = useState<NewContractForm>({
    customer: '',
    density: '1400',
    lockedPrice: '',
    bookedQty: '',
  });
  const [formSaved, setFormSaved] = useState(false);

  function handleFormChange(field: keyof NewContractForm, value: string) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSaveContract() {
    if (!form.customer.trim() || !form.lockedPrice || !form.bookedQty) return;
    // Find or create customer
    let customerId: string | null = null;
    const { data: existingCustomers } = await supabase
      .from('customers')
      .select('id')
      .ilike('name', form.customer.trim())
      .limit(1)
      .returns<{ id: string }[]>();
    if (existingCustomers && existingCustomers.length > 0) {
      customerId = existingCustomers[0].id;
    } else {
      const { data: newCust } = await insertRows('customers', { name: form.customer.trim(), outstanding: 0, is_active: true })
        .select('id')
        .single();
      if (newCust) customerId = newCust.id;
    }
    if (!customerId) { toast.error(t('sales.customerCreateFailed', 'Failed to find or create customer. Please try again.')); return; }
    const { error } = await insertRows('sales_contracts', {
      customer_id: customerId,
      density: parseInt(form.density) || 1400,
      locked_price: parseFloat(form.lockedPrice) || 0,
      booked_qty: parseFloat(form.bookedQty) || 0,
      dispatched_qty: 0,
      status: 'open',
    });
    if (error) { toast.error(t('sales.saveFailed', { defaultValue: 'Save failed: {{message}}', message: error.message })); return; }
    setFormSaved(true);
    setTimeout(() => {
      setShowModal(false);
      setFormSaved(false);
      setForm({ customer: '', density: '1400', lockedPrice: '', bookedQty: '' });
    }, 1400);
  }

  function handleCloseModal() {
    setShowModal(false);
    setFormSaved(false);
    setForm({ customer: '', density: '1400', lockedPrice: '', bookedQty: '' });
  }

  return (
    <>
      {/* Sales sheet OCR upload — management/finance only */}
      {CAN_UPLOAD_SHEET.includes(activeProfile.id) && <OcrUploadCard kind="sales" />}

      {/* KPIs — live from BUSY */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Total Sales MTD', what: 'Gross sales value invoiced this calendar month across all customers and plants. Counts non-cancelled sales vouchers only.', source: 'BUSY DB', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0, current month' }} />
          <StatCard className="h-full" icon={<IndianRupee />} tone="blue"
            label={t('sales.totalSalesLabel')}
            value={salesKPIs ? fmtINR(salesKPIs.totalSalesMTD) : '…'}
            caption={salesKPIs ? t('sales.dispatchesMtd', { count: salesKPIs.dispatchesMTD }) : undefined} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'GST Output MTD', what: 'Total GST collected from customers on sales invoices this month. Net payable = Output GST minus Input ITC. This is what must be remitted to the government.', source: 'BUSY DB', tables: ['VchGSTSumItemWise', 'Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > VchGSTSumItemWise', filter: 'VchType=9, current month' }} />
          <StatCard className="h-full" icon={<Landmark />} tone="purple"
            label={t('sales.gstOutputLabel')}
            value={salesKPIs ? fmtINR(salesKPIs.gstOutputMTD) : '…'}
            caption={salesKPIs ? t('sales.netPayable', { amount: fmtINR(salesKPIs.netGSTPayable) }) : undefined} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Customers with Outstanding', what: 'Count of unique parties in the Sundry Debtors group that have a non-zero Dr balance — i.e., customers who owe money.', source: 'BUSY DB', tables: ['DailySum', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > DailySum\nBusyFY2026 > dbo > Tables > Master1', filter: 'Master1.ParentGrp=116 (Sundry Debtors), MasterType=2' }} />
          <StatCard className="h-full" icon={<Users />} tone="amber"
            label={t('sales.customersOutstandingLabel')}
            value={salesKPIs ? salesKPIs.openContracts : '…'}
            caption={t('sales.partiesSundryDebtors')} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Receipts MTD', what: 'Cash actually received from customers this month via receipt vouchers. Excludes sales invoices not yet paid. Key indicator of real cash inflow.', source: 'BUSY DB', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=16 (Receipt), Cancelled=0, current month' }} />
          <StatCard className="h-full" icon={<Wallet />} tone="green"
            label={t('sales.receiptsLabel')}
            value={salesKPIs ? fmtINR(salesKPIs.receiptsMTD) : '…'}
            caption={t('sales.customerPaymentsReceived')} />
        </div>
      </div>

      {/* Analytics KPI row */}
      {analytics && (
        <div className="grid grid-cols-12 gap-4 mb-4">
          {/* Avg Ticket */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Average Invoice Ticket', what: 'Mean value of each sales invoice for the full financial year. Tracks if orders are growing larger or fragmenting into smaller deals.', source: 'Derived', formula: 'Avg Ticket = FY Revenue / FY Invoice Count', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0' }} />
            <StatCard className="h-full" icon={<ReceiptText />}
              label={t('sales.avgInvoiceTicketLabel')}
              value={fmtINR(analytics.avgTicketFY)}
              caption={
                <span className="inline-flex items-center gap-2">
                  <DeltaBadge value={analytics.momInvoiceGrowthPct} />
                  <span>{t('sales.invoiceCountMom')}</span>
                </span>
              } />
          </div>

          {/* Daily Sales Velocity */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Daily Sales Velocity', what: 'Average revenue generated per working day so far this month. Useful to project end-of-month sales and spot early slowdowns.', source: 'Derived', formula: 'Velocity = MTD Sales / Days elapsed in month', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0, current month' }} />
            <StatCard className="h-full" icon={<Gauge />} tone="blue"
              label={t('sales.dailyVelocityLabel')}
              value={fmtINR(analytics.dailyVelocity)}
              caption={t('sales.perWorkingDay')} />
          </div>

          {/* Unique customers FY vs MTD */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Active Customers', what: 'Number of unique customer parties that have received at least one sales invoice this month (MTD) vs. the full year (FY). MTD percentage shows what share of the annual customer base is active now.', source: 'BUSY DB', tables: ['Tran1', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0 · COUNT DISTINCT MasterCode1' }} />
            <StatCard className="h-full" icon={<UserCheck />} tone="green"
              label={t('sales.activeCustomersLabel')}
              value={
                <>
                  {analytics.uniqueCustomersMTD}
                  <span className="text-sm font-semibold text-slate-500"> / {analytics.uniqueCustomersFY} {t('sales.fyLabel')}</span>
                </>
              }
              caption={t('sales.fyBaseActive', { pct: ((analytics.uniqueCustomersMTD / (analytics.uniqueCustomersFY || 1)) * 100).toFixed(0) })} />
          </div>

          {/* Customer Concentration */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Top-5 Customer Revenue Concentration', what: 'Percentage of total FY revenue coming from the 5 highest-spending customers. High concentration (>60%) signals customer dependency risk — losing one party would have significant impact.', source: 'Derived', formula: 'Concentration = Sum(top 5 FY revenue) / Total FY Revenue × 100', tables: ['Tran1', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0 · TOP 5 by SUM(VchAmtBaseCur)' }} />
            <StatCard className="h-full" icon={<PieChart />} tone="amber" valueTone="amber"
              label={t('sales.top5RevenueLabel')}
              value={`${analytics.top5ConcentrationPct}%`}
              caption={t('sales.leadsAt', { name: analytics.top5[0]?.name, pct: analytics.top5[0]?.sharePct })} />
          </div>
        </div>
      )}

      {/* Analytics KPI row 2 — Supplier & Customer Dynamics */}
      {analytics && analytics.activeSuppliersFY !== undefined && (
        <div className="grid grid-cols-12 gap-4 mb-4">

          {/* Active Suppliers */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Active Suppliers FY / MTD', what: 'Number of unique supplier parties that had at least one purchase invoice this financial year (FY) and this month (MTD). The top-5 concentration % shows if spend is dangerously concentrated in a few vendors.', source: 'BUSY DB', tables: ['Tran1', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=14, Cancelled=0 · COUNT DISTINCT MasterCode1' }} />
            <StatCard className="h-full" icon={<Factory />} tone="blue"
              label={t('sales.activeSuppliersLabel')}
              value={analytics.activeSuppliersFY}
              caption={
                <>
                  {t('sales.fyLabel')} · <strong>{analytics.activeSuppliersMTD}</strong> {t('sales.thisMonth')}
                  <div className="mt-1 text-[10px] text-slate-400">
                    {t('sales.top5Share')}: <strong className="text-amber-600">{analytics.top5SupplierConcentrationPct}%</strong>
                  </div>
                </>
              } />
          </div>

          {/* New vs Lapsed Customers */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Customer Flow MTD', what: 'New = customers whose very first-ever invoice was this month. Lapsed = customers active last month who have zero invoices so far this month. Net = New minus Lapsed — an early churn signal.', source: 'BUSY DB', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0 · MIN(Date) per party for New; EXCEPT query for Lapsed', note: 'Lapsed uses an EXCEPT between last-month buyers and this-month buyers.' }} />
            <StatCard className="h-full" icon={<ArrowLeftRight />} tone="green"
              label={t('sales.customerFlowLabel')}
              value={
                <>
                  <span className="text-green-600">{analytics.newCustomersMTD}</span>
                  <span className="text-slate-300 mx-1.5">/</span>
                  <span className="text-red-500">{analytics.lapsedCustomersMTD}</span>
                </>
              }
              caption={
                <span className="inline-flex items-center gap-2 flex-wrap">
                  <span>{t('sales.new')} / {t('sales.lapsed')}</span>
                  <DeltaBadge value={analytics.newCustomersMTD - analytics.lapsedCustomersMTD} unit={` ${t('sales.netUnit', 'net')}`} />
                </span>
              } />
          </div>

          {/* GST Net Position */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'GST Net Position MTD', what: 'GST Output (collected from customers) minus GST Input ITC (paid to suppliers). Positive = amount payable to government. Negative = ITC refund position.', source: 'Derived', formula: 'GST Net = Output MTD − Input ITC MTD', tables: ['VchGSTSumItemWise'], dbPath: 'BusyFY2026 > dbo > Tables > VchGSTSumItemWise', filter: 'Output: VchType=9 · Input: VchType=14, current month' }} />
            <StatCard className="h-full" icon={<Scale />}
              tone={analytics.gstNetMTD > 0 ? 'red' : 'green'}
              valueTone={analytics.gstNetMTD > 0 ? 'red' : 'green'}
              label={t('sales.gstNetPositionLabel')}
              value={`${analytics.gstNetMTD > 0 ? '+' : ''}${fmtINR(Math.abs(analytics.gstNetMTD))}`}
              caption={
                <>
                  <div className="text-[10px] text-slate-400">
                    {analytics.gstNetMTD > 0 ? t('sales.payableToGovernment') : t('sales.itcRefundPosition')}
                  </div>
                  <div className="mt-2">
                    <BulletCompare
                      left={analytics.gstOutputMTD || 0}
                      right={analytics.gstInputMTD || 0}
                      leftLabel={t('sales.outputAmt', { defaultValue: 'Output {{amount}}', amount: fmtINR(analytics.gstOutputMTD || 0) })}
                      rightLabel={t('sales.itcAmt', { defaultValue: 'ITC {{amount}}', amount: fmtINR(analytics.gstInputMTD || 0) })}
                      leftColor="#DC2626"
                      rightColor="#16A34A"
                    />
                  </div>
                </>
              } />
          </div>

          {/* Invoice Frequency */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Invoice Frequency', what: 'Average number of invoices raised per customer over the full financial year. >3× = sticky repeat buyers. 2-3× = moderate repeat. <2× = largely transactional, one-off purchases.', source: 'Derived', formula: 'Frequency = FY Invoice Count / Unique Customers FY', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0' }} />
            <StatCard className="h-full" icon={<Repeat />} tone="blue"
              label={t('sales.invoiceFrequencyLabel')}
              value={`${analytics.invoiceFrequency}×`}
              caption={
                <>
                  {t('sales.avgInvoicesPerCustomer')}
                  <div className="mt-1.5">
                    <StatusPill
                      tone={analytics.invoiceFrequency >= 3 ? 'green' : analytics.invoiceFrequency >= 2 ? 'amber' : 'red'}
                      label={analytics.invoiceFrequency >= 3 ? t('sales.stickyBuyers') : analytics.invoiceFrequency >= 2 ? t('sales.moderateRepeat') : t('sales.transactional')}
                    />
                  </div>
                </>
              } />
          </div>
        </div>
      )}

      {/* Info banner */}
      <div className="relative mb-4">
        <KpiInfoButton info={{ title: 'Sales → Ops Pipeline', what: 'Explains the auto-cascade: when a sale is logged in BUSY, it triggers stock deduction, contract balance update, labour cost posting, and syncs back to this dashboard — all without manual re-entry. This card is an informational note, not a data tile.', source: 'Mock data', note: 'Static explainer banner. No data source.' }} />
        <InfoBanner tone="amber">
          <div className="font-semibold text-slate-800">{t('sales.feedsTitle')}</div>
          <div className="text-[12px] text-slate-600 mt-1">{t('sales.feedsBody')}</div>
        </InfoBanner>
      </div>

      {/* Contracts filter + table */}
      <FilterBar
        className="mb-4"
        search={salesSearch}
        onSearch={setSalesSearch}
        searchPlaceholder={t('sales.searchPh', 'Search customer…')}
        onReset={() => setSalesSearch('')}
      />

      <div className="relative">
        <KpiInfoButton info={{ title: 'Sales Contracts Table', what: 'All customer contracts with locked-in price and density spread. Shows FY sales, MTD sales, invoice count, and outstanding balance per customer. Status (On Track / Overdue / Cleared) is derived from BUSY outstanding balance. Live data from BUSY DB.', source: 'BUSY DB', tables: ['Tran1', 'Master1', 'DailySum'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1\nBusyFY2026 > dbo > Tables > Master1', filter: 'VchType=9, Cancelled=0 · outstanding from DailySum/Master1 ParentGrp=116' }} />
        <SectionCard
          flush
          title={t('sales.contractsTitle')}
          subtitle={t('sales.contractsSub')}
          actions={
            <>
              <ButtonV2 variant="outline" icon={<Download />} onClick={handleExport}>
                {t('sales.export')}
              </ButtonV2>
              <ButtonV2 variant="accent" icon={<Plus />} onClick={() => setShowModal(true)}>
                {t('sales.newContract')}
              </ButtonV2>
            </>
          }
        >
          {filteredContracts.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState title={salesSearch ? t('sales.noMatches', 'No customers match your search.') : t('sales.noContracts', 'No contracts — data loads from BUSY')} />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto scroll-x">
                <table className="dt2">
                  <thead>
                    <tr>
                      <Th sortKey="customer" s={salesSort}>{t('sales.colCustomer')}</Th>
                      <Th sortKey="totalSales" s={salesSort} firstDir="desc" className="num">{t('sales.colFySales')}</Th>
                      <Th sortKey="mtdSales" s={salesSort} firstDir="desc" className="num">{t('sales.colMtdSales')}</Th>
                      <Th sortKey="invoiceCount" s={salesSort} firstDir="desc" className="num">{t('sales.colInvoices')}</Th>
                      <Th sortKey="outstanding" s={salesSort} firstDir="desc" className="num">{t('sales.colOutstanding')}</Th>
                      <Th sortKey="status" s={salesSort}>{t('sales.colStatus')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesPg.pageRows.map(c => (
                      <tr key={c.customer} style={{ cursor: 'pointer' }} onClick={() => setDetail(c)} data-testid="sales-row"
                        title={t('sales.openDetail', 'View customer details')}>
                        <td className="font-semibold">{c.customer}</td>
                        <td className="num">{fmtINR(c.totalSales)}</td>
                        <td className="num">{fmtINR(c.mtdSales)}</td>
                        <td className="num">{c.invoiceCount}</td>
                        <td className="num font-semibold" style={{ color: c.outstanding > 0 ? '#F47651' : '#475569' }}>
                          {c.outstanding > 0 ? fmtINR(c.outstanding) : '—'}
                        </td>
                        <td>
                          <StatusPill
                            tone={c.status === 'on track' ? 'green' : c.status === 'cleared' ? 'slate' : 'red'}
                            label={c.status === 'on track' ? t('sales.statusOnTrack') : c.status === 'cleared' ? t('sales.statusCleared') : t('sales.statusOverdue')}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePagination controls={salesPg.controls} />
            </>
          )}
        </SectionCard>
      </div>

      {/* ── Customer detail (row click) ── */}
      <SlidePanel open={!!detail} onClose={() => setDetail(null)} title={detail?.customer || ''} subtitle={t('sales.detailSub', 'Sales · BUSY')}>
        {detail && (
          <div data-testid="sales-detail">
            {([
              [t('sales.colFySales'), fmtINR(detail.totalSales)],
              [t('sales.colMtdSales'), fmtINR(detail.mtdSales)],
              [t('sales.colInvoices'), String(detail.invoiceCount)],
              [t('sales.avgInvoice', 'Avg. invoice (FY)'), detail.invoiceCount ? fmtINR(Math.round(detail.totalSales / detail.invoiceCount)) : '—'],
              [t('sales.colOutstanding'), detail.outstanding > 0 ? fmtINR(detail.outstanding) : '—'],
              [t('sales.colStatus'), detail.status === 'on track' ? t('sales.statusOnTrack') : detail.status === 'cleared' ? t('sales.statusCleared') : t('sales.statusOverdue')],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 12, color: '#94A3B8' }}>{k}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{v}</span>
              </div>
            ))}
            {profileCanAccess(activeProfile, '/dashboard/customers') && <ButtonV2 variant="primary" className="mt-4" onClick={() => navigate(`/dashboard/customers?q=${encodeURIComponent(customerSearchName(detail.customer))}`)}>
              {t('sales.openHistory', 'Open customer history')}
            </ButtonV2>}
          </div>
        )}
      </SlidePanel>

      {/* ── New Contract Modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) handleCloseModal(); }}
        >
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-7 relative">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
              <div>
                <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">{t('sales.modalKicker', 'Sales · Contracts')}</div>
                <div className="text-xl font-bold font-heading">{t('sales.modalTitle', 'New sales contract')}</div>
                <div className="text-xs text-slate-500 mt-1">{t('sales.modalSubtitle', 'Lock in price and booked quantity for a customer')}</div>
              </div>
              <button
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center shrink-0 ml-4 transition-colors"
                onClick={handleCloseModal}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {formSaved ? (
              <div className="text-center py-8">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                    <path d="M20 6 9 17l-5-5"/>
                  </svg>
                </div>
                <div className="font-semibold text-green-700">{t('sales.contractSaved', 'Contract saved')}</div>
                <div className="text-xs text-slate-500 mt-1">{t('sales.syncingToBusy', 'Syncing to Busy…')}</div>
              </div>
            ) : (
              <>
                {/* Form fields */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sales.fldCustomerName', 'Customer name *')}</label>
                    <input
                      type="text"
                      value={form.customer}
                      onChange={e => handleFormChange('customer', e.target.value)}
                      placeholder={t('sales.phCustomer', 'e.g. Samarth Polymers')}
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 focus:border-orange-300 transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sales.fldDensityGrade', 'Density grade')}</label>
                    <div className="flex gap-2 flex-wrap">
                      {DENSITY_OPTIONS.map(d => (
                        <button
                          key={d}
                          onClick={() => handleFormChange('density', d)}
                          className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                            form.density === d
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sales.fldLockedPrice', 'Locked price (₹/drum) *')}</label>
                      <input
                        type="number"
                        value={form.lockedPrice}
                        onChange={e => handleFormChange('lockedPrice', e.target.value)}
                        placeholder={t('sales.phLockedPrice', 'e.g. 85')}
                        className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 focus:border-orange-300 transition"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sales.fldBookedQty', 'Booked quantity (drums) *')}</label>
                      <input
                        type="number"
                        value={form.bookedQty}
                        onChange={e => handleFormChange('bookedQty', e.target.value)}
                        placeholder={t('sales.phBookedQty', 'e.g. 50')}
                        className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 focus:border-orange-300 transition"
                      />
                    </div>
                  </div>

                  {/* Estimated value preview */}
                  {form.lockedPrice && form.bookedQty && (
                    <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3">
                      <div className="text-[11px] text-orange-600 font-semibold uppercase tracking-wider">{t('sales.contractValue', 'Contract value')}</div>
                      <div className="text-xl font-extrabold num mt-0.5">
                        ₹ {(Number(form.lockedPrice) * Number(form.bookedQty)).toLocaleString('en-IN')}
                      </div>
                      <div className="text-xs text-slate-500">{t('sales.contractValueDetail', { defaultValue: '{{qty}} drums × ₹{{price}} · density {{density}}', qty: form.bookedQty, price: form.lockedPrice, density: form.density })}</div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-3 mt-6">
                  <ButtonV2 variant="outline" className="flex-1 py-3" onClick={handleCloseModal}>
                    {t('sales.cancel', 'Cancel')}
                  </ButtonV2>
                  <ButtonV2
                    variant="accent"
                    className="flex-1 py-3"
                    disabled={!form.customer.trim() || !form.lockedPrice || !form.bookedQty}
                    onClick={handleSaveContract}
                  >
                    {t('sales.saveContract', 'Save contract')}
                  </ButtonV2>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
