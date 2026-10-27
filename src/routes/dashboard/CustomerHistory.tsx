import React, { useState } from 'react';
import { EmptyState } from '../../components/ui/states';
import { usePagination } from '../../components/ui/usePagination';
import { useSortable } from '../../components/ui/useSortable';
import {
  StatCard, SectionCard, FilterBar, StatusPill,
  TablePaginationV2 as TablePagination, ThV2 as Th,
} from '../../components/v2';
import { Users, Trophy, Wallet, ReceiptText, IndianRupee, RefreshCw, Repeat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOverviewKPIs, useTopCustomers, useCustomerList, useAnalyticsKPIs, fmtINR } from '../../hooks/useBusyData';
import { ConcentrationBar, MiniBarChart } from '../../components/charts/AnalyticsViz';
import { KpiInfoButton } from '../../components/KpiInfoButton';

export function CustomerHistory() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { data: kpis } = useOverviewKPIs();
  const { data: topCustomers } = useTopCustomers(1);
  const { data: customerList } = useCustomerList();
  const { data: analytics } = useAnalyticsKPIs();

  const topCustomer = topCustomers?.[0];

  const filteredList = (customerList || []).filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase())
  );
  const custSort = useSortable(filteredList, {
    name: c => c.name,
    mtdRevenue: c => c.mtdRevenue,
    fyRevenue: c => c.fyRevenue,
    fyInvoices: c => c.fyInvoices,
    outstanding: c => c.outstanding,
  });
  const custPg = usePagination(custSort.sorted, { resetKey: `${search}|${custSort.sort.key}|${custSort.sort.dir}` });

  return (
    <>
      {/* KPIs — live from BUSY */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Customers with Outstanding', what: 'Count of unique debtor parties in BUSY Sundry Debtors that have a non-zero positive (Dr) balance outstanding.', source: 'BUSY DB', tables: ['DailySum', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > DailySum\nBusyFY2026 > dbo > Tables > Master1', filter: 'Master1.ParentGrp=116, MasterType=2 (Sundry Debtors)' }} />
          <StatCard className="h-full" icon={<Users />} tone="blue"
            label={t('customers.customersWithOutstanding')}
            value={kpis ? kpis.debtorCount : '…'}
            caption={t('customers.fromBusySundryDebtors')} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Top Customer MTD', what: 'Customer with the highest sales revenue in the current calendar month, including invoice count.', source: 'BUSY DB', tables: ['Tran1', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1\nBusyFY2026 > dbo > Tables > Master1', filter: 'VchType=9, Cancelled=0, current month · TOP 1 by SUM(VchAmtBaseCur)' }} />
          <StatCard className="h-full" icon={<Trophy />} tone="amber"
            label={t('customers.topCustomerMtdBusy')}
            value={topCustomer ? <span className="text-[17px] leading-tight">{topCustomer.name}</span> : '…'}
            caption={topCustomer ? fmtINR(topCustomer.mtdRevenue) + ' · ' + topCustomer.invoiceCount + ' ' + t('customers.invoices') : undefined} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Total Debtors Outstanding', what: 'Sum of all outstanding Dr balances across every customer in the Sundry Debtors group. This is the total receivables the company is owed.', source: 'BUSY DB', tables: ['DailySum', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > DailySum\nBusyFY2026 > dbo > Tables > Master1', filter: 'Master1.ParentGrp=116, MasterType=2 · SUM(Dr - Cr)' }} />
          <StatCard className="h-full" icon={<Wallet />} tone="red"
            label={t('customers.totalDebtorsOutstanding')}
            value={kpis ? fmtINR(kpis.debtorsOutstanding) : '…'}
            caption={t('customers.drBalanceSundryDebtors')} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'FY Sales Invoices', what: 'Total number of sales invoices raised during the current financial year, and the cumulative revenue they represent.', source: 'BUSY DB', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0, YEAR(Date)=current FY' }} />
          <StatCard className="h-full" icon={<ReceiptText />} tone="green"
            label={t('customers.fySalesInvoices')}
            value={kpis ? kpis.salesInvoiceCount : '…'}
            caption={kpis ? fmtINR(kpis.fyRevenue) + ' ' + t('customers.total') : undefined} />
        </div>
      </div>

      {/* Analytics row */}
      {analytics && (
        <div className="grid grid-cols-12 gap-4 mb-4">
          {/* Revenue per Customer */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Revenue per Customer', what: 'Average revenue generated per unique buying customer over the full financial year. Increasing trend = deeper wallet share. Decreasing = customer base growing faster than revenue.', source: 'Derived', formula: 'Rev/Customer = FY Revenue / Unique Customers FY', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0' }} />
            <StatCard className="h-full" icon={<IndianRupee />}
              label={t('customers.revenuePerCustomerFy')}
              value={fmtINR(analytics.revenuePerCustomer)}
              caption={t('customers.acrossUniqueBuyers', { count: analytics.uniqueCustomersFY })} />
          </div>

          {/* Debtor Turnover */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Debtor Turnover Ratio', what: 'How many times per year the total debtor book is "turned over" (collected and replaced). Higher is better. Directly linked to DSO — Turnover = 365 / DSO.', source: 'Derived', formula: 'Turnover = FY Revenue / Debtors Outstanding\nDSO = 365 / Turnover', tables: ['Tran1', 'DailySum', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1\nBusyFY2026 > dbo > Tables > DailySum' }} />
            <StatCard className="h-full" icon={<RefreshCw />} tone="blue"
              label={t('customers.debtorTurnoverRatio')}
              value={`${analytics.debtorTurnover}×`}
              caption={t('customers.dsoDaysTarget', { count: analytics.dso })} />
          </div>

          {/* Top-5 Concentration — full width bar */}
          <div className="col-span-12 lg:col-span-6 relative">
            <KpiInfoButton info={{ title: 'Top-5 Customer Revenue Concentration', what: 'Visual breakdown of how much of total FY revenue is held by the 5 largest customers. Wider bars = more dependency. "Others" is everything outside the top 5.', source: 'Derived', formula: 'Share% = Customer FY Revenue / Total FY Revenue × 100', tables: ['Tran1', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1\nBusyFY2026 > dbo > Tables > Master1', filter: 'VchType=9, Cancelled=0 · TOP 5 by SUM' }} />
            <SectionCard className="h-full" title={t('customers.top5CustomerRevenueConcentration')}>
              <ConcentrationBar segments={analytics.top5} />
            </SectionCard>
          </div>
        </div>
      )}

      {/* Analytics row 2 — Supplier & Purchase intel */}
      {analytics && analytics.top5Suppliers !== undefined && (
        <div className="grid grid-cols-12 gap-4 mb-4">

          {/* Invoice Frequency */}
          <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
            <KpiInfoButton info={{ title: 'Invoice Frequency', what: 'Average invoices per customer in the financial year. >3× indicates customers order repeatedly (sticky). <2× is transactional — single-use buyers with churn risk.', source: 'Derived', formula: 'Frequency = FY Invoice Count / Unique Customers FY', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=9, Cancelled=0' }} />
            <StatCard className="h-full" icon={<Repeat />} tone="blue"
              label={t('customers.invoiceFrequencyFy')}
              value={`${analytics.invoiceFrequency}×`}
              caption={
                <>
                  {t('customers.avgInvoicesPerCustomer')}
                  <div className="mt-1.5">
                    <StatusPill
                      tone={analytics.invoiceFrequency >= 3 ? 'green' : 'amber'}
                      label={analytics.invoiceFrequency >= 3 ? t('customers.stickyRepeatBuyers') : t('customers.moderateRepeatRate')}
                    />
                  </div>
                </>
              } />
          </div>

          {/* Top-5 Supplier Concentration */}
          <div className="col-span-12 lg:col-span-5 relative">
            <KpiInfoButton info={{ title: 'Top-5 Supplier Spend Concentration', what: 'How much of total FY purchasing spend goes to the 5 largest suppliers. High concentration = supply chain risk — one vendor failing disrupts production.', source: 'Derived', formula: 'Share% = Supplier FY Purchase / Total FY Purchase × 100', tables: ['Tran1', 'Master1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1\nBusyFY2026 > dbo > Tables > Master1', filter: 'VchType=14, Cancelled=0 · TOP 5 by SUM(VchAmtBaseCur)' }} />
            <SectionCard className="h-full" title={t('customers.top5SupplierSpendConcentration')}>
              <ConcentrationBar segments={analytics.top5Suppliers.map(s => ({ name: s.name, sharePct: s.sharePct }))} />
            </SectionCard>
          </div>

          {/* Monthly Purchase Trend */}
          <div className="col-span-12 lg:col-span-4 relative">
            <KpiInfoButton info={{ title: 'Monthly Purchase Trend (6 months)', what: 'Total purchase spend per calendar month for the last 6 months. A rising trend while revenue stays flat = margin compression. Falling purchase costs = positive.', source: 'BUSY DB', tables: ['Tran1'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1', filter: 'VchType=14, Cancelled=0, last 6 months · GROUP BY year/month' }} />
            <SectionCard className="h-full" title={t('customers.monthlyPurchaseTrend6m')}>
              <MiniBarChart
                data={analytics.monthlyPurchase.map(m => m.purchase)}
                labels={analytics.monthlyPurchase.map(m => m.label)}
                color="#2563EB"
                height={48}
              />
            </SectionCard>
          </div>
        </div>
      )}

      {/* Ledger filter + table */}
      <FilterBar
        className="mb-4"
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('customers.searchCustomerPlaceholder')}
        onReset={() => setSearch('')}
      />

      <div className="relative mb-4">
        <KpiInfoButton info={{ title: 'Customer Ledger', what: 'Top 50 customers of each Busy company by FY sales (All companies = those lists combined and re-ranked), with MTD sales, invoice count and outstanding Dr balance. From the last Busy push.', source: 'BUSY DB', tables: ['Tran1', 'Master1', 'DailySum'], dbPath: 'BusyFY2026 > dbo > Tables > Tran1\nBusyFY2026 > dbo > Tables > Master1\nBusyFY2026 > dbo > Tables > DailySum', filter: 'VchType=9, Cancelled=0 · outstanding from DailySum grouped by Master1.Code' }} />
        <SectionCard
          flush
          title={t('customers.customerLedger')}
          subtitle={t('customers.ledgerHint')}
        >
          {filteredList.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState title={search ? t('customers.noMatches', 'No customers match your search.') : t('customers.empty', 'No customers yet.')} />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto scroll-x">
                <table className="dt2">
                  <thead>
                    <tr>
                      <Th sortKey="name" s={custSort}>{t('customers.colCustomerBusy')}</Th>
                      <Th sortKey="mtdRevenue" s={custSort} firstDir="desc" className="num">{t('customers.colMtdSales')}</Th>
                      <Th sortKey="fyRevenue" s={custSort} firstDir="desc" className="num">{t('customers.colFySales')}</Th>
                      <Th sortKey="fyInvoices" s={custSort} firstDir="desc" className="num">{t('customers.colFyInvoices')}</Th>
                      <Th sortKey="outstanding" s={custSort} firstDir="desc" className="num">{t('customers.colOutstanding')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {custPg.pageRows.map(c => (
                      <tr key={c.code}>
                        <td className="font-semibold">{c.name}</td>
                        <td className="num font-bold">{fmtINR(c.mtdRevenue)}</td>
                        <td className="num text-slate-500">{fmtINR(c.fyRevenue)}</td>
                        <td className="num text-slate-500">{c.fyInvoices}</td>
                        <td className={`num font-semibold ${c.outstanding > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                          {c.outstanding > 0 ? fmtINR(c.outstanding) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePagination controls={custPg.controls} />
            </>
          )}
        </SectionCard>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-6 relative">
          <KpiInfoButton info={{ title: 'Dispatch History', what: 'Monthly drums dispatched to the top customer over the last 6 months. Used to spot seasonal patterns and forecast the next order.', source: 'BUSY DB', note: 'No per-month per-customer dispatch series is available yet — shows an empty state instead of sample numbers. Future: pull from Tran1 WHERE MasterCode1 = customer code, grouped by month.' }} />
          <SectionCard
            className="h-full"
            title={`${topCustomer ? topCustomer.name : t('customers.densityPreference')} · ${t('customers.last6Months')}`}
            subtitle={t('customers.drumsDispatchedPerMonth')}
          >
            <div className="py-10 text-center text-sm text-slate-400">
              No dispatch history available yet.
            </div>
          </SectionCard>
        </div>
        <div className="col-span-12 lg:col-span-6 relative">
          <KpiInfoButton info={{ title: 'Density Preference Chart', what: 'Breakdown of the customer\'s order volume by CP density grade (1300, 1400, 1450, 1500). Shows which density grades they predominantly purchase — important for production planning and stock allocation.', source: 'BUSY DB', note: 'No per-customer density breakdown source is available yet — shows an empty state instead of sample numbers. Future: derived from Tran1 joined with item/density metadata.' }} />
          <SectionCard
            className="h-full"
            title={t('customers.densityPreference')}
            subtitle={t('customers.whereVolumeSits')}
          >
            <div className="py-10 text-center text-sm text-slate-400">
              No density breakdown available yet.
            </div>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
