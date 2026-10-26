import { Router } from 'express';
import { getPool, sql } from '../db.js';
import { withFallback } from '../lib/fallback.js';
import { buildNarrative } from '../lib/analyst.js';
import { METRICS, GRAINS, metricSeries, getDailyBase, aggregate, engineer, weekKeyOf } from '../lib/features.js';
import { exportAllFeatures } from '../lib/csvExport.js';

const router = Router();

// Voucher types: 9=Sales · 14=Purchase · 16=Receipt · 19=Payment
// Parties: Master1 MasterType=2, ParentGrp 116=customers / 117=vendors
// Analysis anchored to the latest SALES date (the business pulse).

const fmtINR = (n) => {
  if (!n || isNaN(n)) return '₹0';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};
const pct = (n) => `${(n * 100).toFixed(1)}%`;

// 4-tier severity ladder. `level` (mild→extreme) is the data-science tier; `severity`
// (info/warning/urgent) drives the existing colour system.
const LEVELS = ['mild', 'moderate', 'heavy', 'extreme'];
const levelToSeverity = (lvl) => (lvl === 'extreme' || lvl === 'heavy') ? 'urgent' : lvl === 'moderate' ? 'warning' : 'info';
const levelFromScore01 = (s) => (s >= 0.85 ? 'extreme' : s >= 0.68 ? 'heavy' : s >= 0.5 ? 'moderate' : 'mild');

async function getAnchor(pool) {
  const r = await pool.request().query(`SELECT MAX([Date]) AS anchor FROM Tran1 WHERE Cancelled=0 AND VchType=9`);
  return r.recordset[0].anchor || new Date();
}

// ── Entity / compound detectors (curated) ─────────────────────────────────────
async function entityFindings(pool, anchor) {
  const wins = await pool.request().input('anchor', sql.DateTime, anchor).query(`
    DECLARE @a datetime = @anchor;
    SELECT
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=9  AND Cancelled=0 AND [Date] >  DATEADD(DAY,-14,@a))                                  AS recentSales,
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=2 AND Cancelled=0 AND [Date] >  DATEADD(DAY,-14,@a))                                  AS recentPurch,
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=9  AND Cancelled=0 AND [Date] <= DATEADD(DAY,-14,@a) AND [Date] > DATEADD(DAY,-28,@a)) AS priorSales,
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=2 AND Cancelled=0 AND [Date] <= DATEADD(DAY,-14,@a) AND [Date] > DATEADD(DAY,-28,@a)) AS priorPurch,
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=9  AND Cancelled=0) AS fySales,
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=2 AND Cancelled=0) AS fyPurch
  `);
  const w = wins.recordset[0];

  const pace = await pool.request().input('anchor', sql.DateTime, anchor).query(`
    DECLARE @a datetime = @anchor; DECLARE @dom int = DAY(@a);
    SELECT
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=9 AND Cancelled=0 AND YEAR([Date])=YEAR(@a) AND MONTH([Date])=MONTH(@a)) AS mtdSales,
      (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=9 AND Cancelled=0 AND YEAR([Date])=YEAR(DATEADD(MONTH,-1,@a)) AND MONTH([Date])=MONTH(DATEADD(MONTH,-1,@a)) AND DAY([Date])<=@dom) AS prevPaceSales
  `);
  const p = pace.recordset[0];

  // Purchase vendors are the Sundry Creditors (117) lines on purchase vouchers (VchType 2).
  const vendorsRecent = await pool.request().input('anchor', sql.DateTime, anchor).query(`
    DECLARE @a datetime=@anchor;
    SELECT TOP 5 m.Name AS vendor, SUM(ABS(t2.Value1)) AS spend
    FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode=t2.VchCode AND t1.VchType=2 AND t1.Cancelled=0 AND t1.[Date]>DATEADD(DAY,-30,@a)
    JOIN Master1 m ON m.Code=t2.MasterCode1 AND m.MasterType=2 AND m.ParentGrp=117
    GROUP BY m.Name ORDER BY SUM(ABS(t2.Value1)) DESC`);
  const vendorsPrior = await pool.request().input('anchor', sql.DateTime, anchor).query(`
    DECLARE @a datetime=@anchor;
    SELECT TOP 5 m.Name AS vendor, SUM(ABS(t2.Value1)) AS spend
    FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode=t2.VchCode AND t1.VchType=2 AND t1.Cancelled=0 AND t1.[Date]<=DATEADD(DAY,-30,@a) AND t1.[Date]>DATEADD(DAY,-60,@a)
    JOIN Master1 m ON m.Code=t2.MasterCode1 AND m.MasterType=2 AND m.ParentGrp=117
    GROUP BY m.Name ORDER BY SUM(ABS(t2.Value1)) DESC`);

  const customers = await pool.request().input('anchor', sql.DateTime, anchor).query(`
    DECLARE @a datetime=@anchor;
    SELECT TOP 15 t.MasterCode1 AS code, m.Name AS name, SUM(t.VchAmtBaseCur) AS fyRevenue,
      MAX(t.[Date]) AS lastInvoice, DATEDIFF(DAY, MAX(t.[Date]), @a) AS daysSilent, COUNT(*) AS invoices
    FROM Tran1 t JOIN Master1 m ON m.Code=t.MasterCode1
    WHERE t.VchType=9 AND t.Cancelled=0 GROUP BY t.MasterCode1, m.Name ORDER BY SUM(t.VchAmtBaseCur) DESC`);

  const outstanding = await pool.request().query(`
    SELECT d.MasterCode1 AS code, m.Name AS name,
      SUM(ISNULL(d.Dr1,0)) - SUM(ISNULL(d.Cr1,0)) + ISNULL((SELECT ISNULL(D1,0)-ISNULL(D2,0) FROM Folio1 WHERE MasterCode=d.MasterCode1),0) AS outstanding
    FROM DailySum d JOIN Master1 m ON m.Code=d.MasterCode1 WHERE m.MasterType=2 AND m.ParentGrp=116 GROUP BY d.MasterCode1, m.Name`);
  const outMap = {};
  outstanding.recordset.forEach(o => { outMap[o.code] = Math.max(0, o.outstanding || 0); });

  const findings = [];
  const add = (f) => findings.push({ score: 0.6, tier: 1, layer: 'rule', detail: {}, ...f });

  const recentMargin = w.recentSales > 0 ? (w.recentSales - w.recentPurch) / w.recentSales : null;
  const priorMargin  = w.priorSales  > 0 ? (w.priorSales  - w.priorPurch ) / w.priorSales  : null;
  if (recentMargin !== null && priorMargin !== null) {
    const drop = priorMargin - recentMargin;
    if (drop >= 0.05) add({
      anomaly_type: 'MARGIN_COMPRESSION', tier: 2, layer: 'stat', severity: drop >= 0.12 ? 'urgent' : 'warning',
      entity_id: 'kpi:gross_margin', entity_type: 'kpi', kpi_key: 'grossMargin', score: Math.min(1, drop / 0.2),
      metric_value: recentMargin, baseline_value: priorMargin,
      title: `Gross margin fell to ${pct(recentMargin)} (was ${pct(priorMargin)})`,
      body: `In the last 14 days margin compressed by ${pct(drop)} vs the prior 14 days. Purchase cost is rising faster than sales — the business is trending toward loss.`,
      detail: { recentSales: w.recentSales, recentPurch: w.recentPurch, priorSales: w.priorSales, priorPurch: w.priorPurch, recentMarginPct: recentMargin, priorMarginPct: priorMargin, dropPct: drop },
    });
  }

  const vr = vendorsRecent.recordset, vp = vendorsPrior.recordset;
  if (vr.length && vp.length) {
    const topRecent = vr[0], topPrior = vp[0];
    const priorNames = new Set(vp.map(v => v.vendor));
    const newlyDominant = topRecent.vendor !== topPrior.vendor && !priorNames.has(topRecent.vendor);
    const purchUp = w.priorPurch > 0 && w.recentPurch > w.priorPurch * 1.05;
    if (newlyDominant) add({
      anomaly_type: 'A14_vendor_switch', tier: 1, layer: 'rule', severity: purchUp ? 'urgent' : 'warning',
      entity_id: `vendor:${topRecent.vendor}`, entity_type: 'vendor', kpi_key: 'purchaseMTD', score: purchUp ? 0.85 : 0.6,
      metric_value: topRecent.spend, baseline_value: topPrior.spend,
      title: `New top vendor: ${topRecent.vendor}`,
      body: `${topRecent.vendor} became the largest supplier in the last 14 days (${fmtINR(topRecent.spend)}), displacing ${topPrior.vendor}.${purchUp ? ' Total purchase cost is up vs the prior period.' : ''} Review whether this switch was approved and priced correctly.`,
      detail: { newVendor: topRecent.vendor, newVendorSpend: topRecent.spend, priorTopVendor: topPrior.vendor, priorTopSpend: topPrior.spend, recentPurchTotal: w.recentPurch, priorPurchTotal: w.priorPurch, topVendorsRecent: vr, topVendorsPrior: vp },
    });
  }

  if (p.prevPaceSales > 0) {
    const ratio = p.mtdSales / p.prevPaceSales;
    if (ratio < 0.80) add({
      anomaly_type: 'A6_revenue_pace', tier: 2, layer: 'stat', severity: ratio < 0.6 ? 'urgent' : 'warning',
      entity_id: 'kpi:revenue_pace', entity_type: 'kpi', kpi_key: 'salesMTD', score: Math.min(1, 1 - ratio),
      metric_value: p.mtdSales, baseline_value: p.prevPaceSales,
      title: `MTD revenue pace ${pct(1 - ratio)} below last month`,
      body: `By this day of the month, sales are ${fmtINR(p.mtdSales)} vs ${fmtINR(p.prevPaceSales)} at the same point last month. Review the dispatch pipeline.`,
      detail: { mtdSales: p.mtdSales, prevPaceSales: p.prevPaceSales, paceRatio: ratio },
    });
  }

  const cust = customers.recordset;
  cust.filter(c => c.fyRevenue > 1_000_000 && c.daysSilent >= 30).slice(0, 5).forEach(c => add({
    anomaly_type: 'A7_customer_silent', tier: 2, layer: 'stat', severity: 'warning',
    entity_id: `customer:${c.name}`, entity_type: 'customer', kpi_key: 'salesMTD', score: Math.min(1, c.daysSilent / 90),
    metric_value: c.daysSilent, baseline_value: 30,
    title: `${c.name} silent for ${c.daysSilent} days`,
    body: `${c.name} (FY revenue ${fmtINR(c.fyRevenue)}) has placed no order since ${new Date(c.lastInvoice).toLocaleDateString('en-IN')}. Outstanding: ${fmtINR(outMap[c.code] || 0)}. At-risk customer.`,
    detail: { customer: c.name, daysSilent: c.daysSilent, lastInvoice: c.lastInvoice, fyRevenue: c.fyRevenue, outstanding: outMap[c.code] || 0 },
  }));

  cust.filter(c => (outMap[c.code] || 0) >= 500_000 && c.daysSilent <= 30)
    .sort((a, b) => (outMap[b.code] || 0) - (outMap[a.code] || 0)).slice(0, 5).forEach(c => add({
      anomaly_type: 'A8_credit_risk', tier: 2, layer: 'stat', severity: (outMap[c.code] || 0) >= 2_000_000 ? 'urgent' : 'warning',
      entity_id: `customer:${c.name}`, entity_type: 'customer', kpi_key: 'debtorsOutstanding', score: Math.min(1, (outMap[c.code] || 0) / 5_000_000),
      metric_value: outMap[c.code] || 0, baseline_value: 500_000,
      title: `${c.name}: ${fmtINR(outMap[c.code] || 0)} outstanding, still dispatching`,
      body: `${c.name} carries ${fmtINR(outMap[c.code] || 0)} outstanding and was invoiced within the last ${c.daysSilent} days. Credit risk accumulating — consider holding the next dispatch.`,
      detail: { customer: c.name, outstanding: outMap[c.code] || 0, daysSilent: c.daysSilent, fyRevenue: c.fyRevenue },
    }));

  // KPI snapshot for the problem grid
  const flaggedKpis = new Set(findings.map(f => f.kpi_key).filter(Boolean));
  const grossMarginPct = w.fySales > 0 ? (w.fySales - w.fyPurch) / w.fySales : 0;
  const totalOutstanding = Object.values(outMap).reduce((a, b) => a + b, 0);
  const kpis = [
    { key: 'grossMargin', label: 'Gross Margin', value: pct(grossMarginPct), raw: grossMarginPct, trend: recentMargin, baseline: priorMargin, fmt: 'pct' },
    { key: 'salesMTD', label: 'Sales MTD', value: fmtINR(p.mtdSales), raw: p.mtdSales, trend: p.mtdSales, baseline: p.prevPaceSales, fmt: 'inr' },
    { key: 'purchaseMTD', label: 'Purchase (14d)', value: fmtINR(w.recentPurch), raw: w.recentPurch, trend: w.recentPurch, baseline: w.priorPurch, fmt: 'inr' },
    { key: 'debtorsOutstanding', label: 'Debtors Outstanding', value: fmtINR(totalOutstanding), raw: totalOutstanding, trend: totalOutstanding, baseline: totalOutstanding, fmt: 'inr' },
  ].map(k => ({ ...k, problem: flaggedKpis.has(k.key) }));

  return { findings, kpis };
}

// ── Time-series point-anomaly detectors (statistical, feed the charts + the list) ──
async function timeSeriesFindings(anchor) {
  const daily = await getDailyBase(anchor);
  const out = [];
  // Per-metric grain: margin% is noisy daily (lumpy purchases) → detect weekly; flows daily.
  const watch = [
    { metric: 'margin_pct', grain: 'weekly', recent: 4, kpi: 'grossMargin', label: 'Weekly gross margin', dir: 'down' },
    { metric: 'sales', grain: 'daily', recent: 21, kpi: 'salesMTD', label: 'Daily sales', dir: 'down' },
    { metric: 'purchase', grain: 'daily', recent: 21, kpi: 'purchaseMTD', label: 'Daily purchase cost', dir: 'up' },
    { metric: 'net_cash', grain: 'daily', recent: 21, kpi: 'debtorsOutstanding', label: 'Net cash flow', dir: 'down' },
  ];
  const fmt = (metric, v) => metric === 'margin_pct' ? pct(v) : fmtINR(v);

  for (const wch of watch) {
    const series = engineer(aggregate(daily, wch.grain), wch.metric, wch.grain);
    const recent = series.slice(-wch.recent).filter(p => p.isAnomaly && p.severity !== 'mild');
    // most severe up to 2 per metric, prefer the directionally-bad ones
    const ranked = recent
      .filter(p => wch.dir === 'down' ? p.score < 0 : p.score > 0)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 2);
    for (const pt of ranked) {
      out.push({
        anomaly_type: `TS_${wch.metric}`, tier: 2, layer: 'stat', level: pt.severity, severity: levelToSeverity(pt.severity),
        entity_id: `series:${wch.metric}:${pt.period}`, entity_type: 'kpi', kpi_key: wch.kpi,
        score: Math.min(1, Math.abs(pt.score) / 6), metric_value: pt.value, baseline_value: pt.baseline,
        title: `${wch.label} ${pt.score < 0 ? 'dropped' : 'spiked'} on ${pt.label} — ${pt.severity} (${pt.score.toFixed(1)}σ)`,
        body: `${wch.label} on ${pt.label} was ${fmt(wch.metric, pt.value)} vs an expected ${fmt(wch.metric, pt.baseline)} (±${fmt(wch.metric, (pt.upper - pt.baseline) || 0)}). This is a ${Math.abs(pt.score).toFixed(1)}σ deviation — statistically ${pt.severity}.`,
        detail: { metric: wch.metric, grain: wch.grain, period: pt.period, label: pt.label, value: pt.value, baseline: pt.baseline, upper: pt.upper, lower: pt.lower, z: pt.z, robustZ: pt.robustZ, score: pt.score },
      });
    }
  }
  return out;
}

// ── Analytics bundle for the multi-plot grid ──────────────────────────────────
async function buildAnalytics(pool, anchor) {
  const daily = await getDailyBase(anchor);
  const weekly = aggregate(daily, 'weekly');
  const lastWeeks = weekly.slice(-10);

  const fySales = daily.reduce((s, d) => s + d.sales, 0);
  const fyPurch = daily.reduce((s, d) => s + d.purchase, 0);
  const fyMargin = fySales > 0 ? (fySales - fyPurch) / fySales : 0;
  // recent vs prior margin (14d windows) for the gauge delta
  const aMs = anchor.getTime();
  const inWin = (d, lo, hi) => { const t = d.date.getTime(); return t > aMs - hi * 864e5 && t <= aMs - lo * 864e5; };
  const sumWin = (k, lo, hi) => daily.filter(d => inWin(d, lo, hi)).reduce((s, d) => s + d[k], 0);
  const rS = sumWin('sales', 0, 14), rP = sumWin('purchase', 0, 14), pS = sumWin('sales', 14, 28), pP = sumWin('purchase', 14, 28);
  const recentMargin = rS > 0 ? (rS - rP) / rS : fyMargin;
  const priorMargin = pS > 0 ? (pS - pP) / pS : fyMargin;

  // Per-metric latest z-score (risk radar)
  const radarKeys = ['sales', 'purchase', 'margin_pct', 'receipts', 'payments', 'avg_ticket', 'inv_count', 'net_cash'];
  const radar = radarKeys.map(m => {
    const grain = m === 'margin_pct' ? 'weekly' : 'daily';
    const series = engineer(aggregate(daily, grain), m, grain);
    const last = [...series].reverse().find(p => !p.warming) || series[series.length - 1] || {};
    return { key: m, label: METRICS[m].label, unit: METRICS[m].unit, value: last.value ?? 0, z: last.z ?? 0, severity: last.severity ?? 'normal' };
  });

  // Anomaly timeline: bucket daily-metric anomalies by week, stacked by severity
  const tl = new Map();
  for (const m of ['sales', 'purchase', 'margin_pct', 'net_cash']) {
    const grain = m === 'margin_pct' ? 'weekly' : 'daily';
    const series = engineer(aggregate(daily, grain), m, grain);
    for (const p of series) {
      if (!p.isAnomaly) continue;
      const wk = weekKeyOf(p.period);
      if (!tl.has(wk.key)) tl.set(wk.key, { key: wk.key, label: wk.label, mild: 0, moderate: 0, heavy: 0, extreme: 0, total: 0 });
      const b = tl.get(wk.key); b[p.severity]++; b.total++;
    }
  }
  const timeline = [...tl.values()].sort((a, b) => a.key.localeCompare(b.key));

  // Top vendor (raw-material supplier) concentration over the FY. Purchase vendors live
  // in Tran2 creditor lines on purchase vouchers (VchType 2).
  const vRes = await pool.request().query(`
    SELECT TOP 6 m.Name AS name, SUM(ABS(t2.Value1)) AS spend
    FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode=t2.VchCode AND t1.VchType=2 AND t1.Cancelled=0
    JOIN Master1 m ON m.Code=t2.MasterCode1 AND m.MasterType=2 AND m.ParentGrp=117
    GROUP BY m.Name ORDER BY SUM(ABS(t2.Value1)) DESC`);
  const vTotalRes = await pool.request().query(`
    SELECT ISNULL(SUM(ABS(t2.Value1)),0) AS total
    FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode=t2.VchCode AND t1.VchType=2 AND t1.Cancelled=0
    JOIN Master1 m ON m.Code=t2.MasterCode1 AND m.MasterType=2 AND m.ParentGrp=117`);
  const vTotal = vTotalRes.recordset[0].total || 1;
  const vendors = vRes.recordset.map(v => ({ name: v.name, sharePct: +(100 * v.spend / vTotal).toFixed(1), spend: v.spend }));

  // Top debtors by outstanding
  const dRes = await pool.request().query(`
    SELECT d.MasterCode1 AS code, m.Name AS name,
      SUM(ISNULL(d.Dr1,0))-SUM(ISNULL(d.Cr1,0)) + ISNULL((SELECT ISNULL(D1,0)-ISNULL(D2,0) FROM Folio1 WHERE MasterCode=d.MasterCode1),0) AS outstanding
    FROM DailySum d JOIN Master1 m ON m.Code=d.MasterCode1 WHERE m.MasterType=2 AND m.ParentGrp=116 GROUP BY d.MasterCode1, m.Name`);
  const debtors = dRes.recordset.map(r => ({ name: r.name, outstanding: Math.max(0, r.outstanding || 0) }))
    .filter(r => r.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 6);

  return {
    margin: { fyPct: fyMargin, recentPct: recentMargin, priorPct: priorMargin, weekly: lastWeeks.map(w => ({ label: w.label, value: w.margin_pct })) },
    salesPurchase: lastWeeks.map(w => ({ label: w.label, sales: w.sales, purchase: w.purchase })),
    cashflow: lastWeeks.map(w => ({ label: w.label, receipts: w.receipts, payments: w.payments, net: w.net_cash })),
    radar, timeline, vendors, debtors,
  };
}

// ── The scan ──────────────────────────────────────────────────────────────────
async function runScan() {
  const pool = await getPool();
  const anchor = await getAnchor(pool);

  const [{ findings: ent, kpis }, ts] = await Promise.all([
    entityFindings(pool, anchor),
    timeSeriesFindings(anchor),
  ]);

  let findings = [...ent, ...ts];

  // Assign the 4-tier level to every finding (entity findings derive it from score)
  findings = findings.map(f => {
    const level = f.level || levelFromScore01(f.score ?? 0.5);
    return { ...f, level, severity: f.severity || levelToSeverity(level) };
  });

  // Sort: extreme→mild, then score
  const lvlRank = { extreme: 0, heavy: 1, moderate: 2, mild: 3 };
  findings.sort((a, b) => lvlRank[a.level] - lvlRank[b.level] || (b.score ?? 0) - (a.score ?? 0));
  findings.forEach((f, i) => {
    f.id = `${f.anomaly_type}::${f.entity_id || i}`;
    f.route = `/dashboard/anomalies?a=${encodeURIComponent(f.id)}`;
    f.fired_at = new Date().toISOString();
  });

  const levels = { mild: 0, moderate: 0, heavy: 0, extreme: 0 };
  findings.forEach(f => { if (levels[f.level] !== undefined) levels[f.level]++; });
  const summary = {
    urgent: findings.filter(f => f.severity === 'urgent').length,
    warning: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length,
    total: findings.length,
    levels,
  };

  return { generated_at: new Date().toISOString(), anchor_date: anchor, summary, kpis, findings };
}

// ── Routes ────────────────────────────────────────────────────────────────────
router.get('/scan', withFallback('anomaly-scan', runScan));

router.get('/analytics', withFallback('anomaly-analytics', async () => {
  const pool = await getPool();
  const anchor = await getAnchor(pool);
  const data = await buildAnalytics(pool, anchor);
  return { generated_at: new Date().toISOString(), anchor_date: anchor, ...data };
}));

router.get('/metrics', (req, res) => {
  res.json({
    grains: GRAINS,
    metrics: Object.entries(METRICS).map(([key, m]) => ({ key, ...m })),
  });
});

router.get('/timeseries', withFallback('anomaly-timeseries', async (req) => {
  const metric = METRICS[req.query.metric] ? req.query.metric : 'margin_pct';
  const grain = GRAINS.includes(req.query.grain) ? req.query.grain : 'daily';
  const pool = await getPool();
  const anchor = await getAnchor(pool);
  return metricSeries(metric, grain, anchor);
}));

router.get('/export', async (req, res) => {
  try {
    const pool = await getPool();
    const anchor = await getAnchor(pool);
    const result = await exportAllFeatures(anchor);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/narrative', async (req, res) => {
  try {
    const finding = req.body?.finding;
    if (!finding) return res.status(400).json({ error: 'finding required' });
    res.json(await buildNarrative(finding));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
