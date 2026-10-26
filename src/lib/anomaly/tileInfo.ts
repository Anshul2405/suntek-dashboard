import type { KpiMeta } from '../../components/KpiInfoButton';

/**
 * Info-tooltip metadata for every anomaly-dashboard tile/panel. Surfaced via the
 * site-standard KpiInfoButton (the "i" button) so each tile explains: which BUSY
 * table it derives from, what KPI it affects, how it's computed, and how to act on it.
 */
export const TILE_INFO: Record<string, KpiMeta> = {
  // ── Problem-KPI grid ────────────────────────────────────────────────────────
  grossMargin: {
    title: 'Gross Margin', source: 'BUSY DB', tables: ['Tran1'],
    what: 'Share of revenue kept after raw-material cost. The core profitability signal — feeds the Margin Compression anomaly.',
    filter: 'VchType 9 (sales) & 2 (purchase), Cancelled=0',
    formula: '(Σ sales − Σ purchase) / Σ sales',
    note: 'Improve: renegotiate vendor rates or lift selling price. A falling margin is the earliest "trending to loss" warning.',
  },
  salesMTD: {
    title: 'Sales MTD', source: 'BUSY DB', tables: ['Tran1'],
    what: 'Month-to-date sales value. Drives the revenue-pace and customer-silence anomalies.',
    filter: 'VchType=9, current month, Cancelled=0',
    formula: 'Σ VchAmtBaseCur',
    note: 'Improve: chase the dispatch pipeline and open contracts before month-end.',
  },
  purchaseMTD: {
    title: 'Purchase (14d)', source: 'BUSY DB', tables: ['Tran1', 'Tran2', 'Master1'],
    what: 'Raw-material spend over the last 14 days. Rising purchase cost compresses margin and triggers the vendor-switch check.',
    filter: 'VchType=2, last 14 days; vendor = Tran2 line, Master1.ParentGrp=117',
    formula: 'Σ VchAmtBaseCur',
    note: 'Improve: consolidate POs and confirm any vendor switch was approved & priced correctly.',
  },
  debtorsOutstanding: {
    title: 'Debtors Outstanding', source: 'BUSY DB', tables: ['DailySum', 'Folio1', 'Master1'],
    what: 'Total receivables owed by customers. Feeds the credit-risk anomaly (outstanding + still dispatching).',
    filter: 'Master1.MasterType=2, ParentGrp=116 (Sundry Debtors)',
    formula: 'Σ(Dr1 − Cr1) + opening (Folio1 D1 − D2)',
    note: 'Improve: tighten collections; place a credit hold on high-outstanding buyers before the next dispatch.',
  },

  // ── Risk-analytics panels ───────────────────────────────────────────────────
  marginGauge: {
    title: 'Margin health', source: 'BUSY DB', tables: ['Tran1'],
    what: 'Last-14-day gross margin on a speedometer. Red <10%, amber <20%, green ≥20%.',
    filter: 'VchType 9 & 2, last 14d vs prior 14d',
    formula: '(sales − purchase) / sales',
    note: 'The needle dropping into red/amber is the headline loss-risk signal.',
  },
  severityMix: {
    title: 'Severity mix', source: 'Derived', tables: ['Tran1'],
    what: 'How many statistical anomalies were detected across metrics, split by tier (mild→extreme).',
    formula: 'count of points where max(|z|,|robust-z|) ≥ 2σ, bucketed by tier',
    note: 'A heavier extreme/heavy share means more metrics broke their normal range this period.',
  },
  salesVsPurchase: {
    title: 'Sales vs Purchase', source: 'BUSY DB', tables: ['Tran1'],
    what: 'Weekly sales vs purchase lines. The gap between them is gross margin — a narrowing gap is the squeeze.',
    filter: 'VchType 9 vs 2, weekly, last 10 weeks',
    note: 'When the red (purchase) line approaches the green (sales) line, margin is compressing.',
  },
  riskRadar: {
    title: 'Metric risk radar', source: 'Derived', tables: ['Tran1'],
    what: 'Each metric’s latest deviation from its own rolling baseline, in standard deviations (σ).',
    formula: 'z = (latest − rolling mean) / rolling std',
    note: 'Bars far from centre (coloured) are the metrics currently behaving abnormally.',
  },
  anomalyTimeline: {
    title: 'Anomaly timeline', source: 'Derived', tables: ['Tran1'],
    what: 'Anomalies per week across the key metrics, stacked by severity tier.',
    formula: 'weekly count of anomalous daily points (sales, purchase, margin, net cash)',
    note: 'Tall red bars mark the weeks something went wrong — drill those weeks in the explorer.',
  },
  vendorConcentration: {
    title: 'Vendor concentration', source: 'BUSY DB', tables: ['Tran2', 'Tran1', 'Master1'],
    what: 'Share of raw-material spend per supplier (FY). Concentration risk + context for vendor-switch anomalies.',
    filter: 'VchType=2 purchase lines; Master1.ParentGrp=117 (Sundry Creditors)',
    formula: 'vendor spend ÷ total purchase, via Tran2 creditor lines',
    note: 'High single-vendor share = supply risk. A new vendor jumping the ranking triggers the A14 alert.',
  },
  topDebtors: {
    title: 'Top debtors', source: 'BUSY DB', tables: ['DailySum', 'Folio1', 'Master1'],
    what: 'Customers with the largest outstanding receivables right now.',
    filter: 'Master1.ParentGrp=116 (Sundry Debtors), outstanding > 0',
    formula: 'Σ(Dr1 − Cr1) + opening',
    note: 'Red bars (≥₹20 L) are the accounts to prioritise for collection.',
  },
  metricExplorer: {
    title: 'Metric explorer', source: 'Derived', tables: ['Tran1'],
    what: 'Engineered time series for any metric at daily/weekly/monthly granularity, with a ±2σ baseline band, EWMA trend, and anomaly markers.',
    formula: 'rolling mean ± 2σ · EWMA · z-score / robust-MAD per point',
    note: 'Switch granularity to separate a real trend from day-to-day lumpiness (e.g. daily margin is noisy from lumpy purchases).',
  },
};
