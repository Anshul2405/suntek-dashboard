/**
 * Feature engineering + statistical anomaly detection over the BUSY transaction book.
 *
 * Pipeline:
 *   1. getDailyBase()  — one SQL pass → per-day sales/purchase/receipts/payments/counts
 *   2. aggregate()     — roll up to the requested grain (daily | weekly | monthly) and
 *                        derive metrics (gross margin %, avg invoice value, …)
 *   3. engineer()      — per-point rolling features: mean, std, EWMA, median, MAD,
 *                        z-score, robust-z (MAD-based), IQR fences, severity tier.
 *
 * Detection is deterministic and statistical (no LLM in the loop here). Severity tiers:
 *   mild ≥ 2σ · moderate ≥ 2.5σ · heavy ≥ 3.5σ · extreme ≥ 5σ
 * using max(|z-score|, |robust-z|) so a single wild day can't hide behind the mean.
 */

import { getPool, sql } from '../db.js';

// ── Metric catalog (drives the UI selector) ───────────────────────────────────
export const METRICS = {
  sales:      { label: 'Sales',              unit: 'inr', direction: 'down_bad', desc: 'Daily sales invoice value (VchType 9)' },
  purchase:   { label: 'Purchase Cost',      unit: 'inr', direction: 'up_bad',   desc: 'Daily purchase value (VchType 2)' },
  margin_pct: { label: 'Gross Margin %',     unit: 'pct', direction: 'down_bad', desc: '(Sales − Purchase) / Sales per period' },
  receipts:   { label: 'Receipts',           unit: 'inr', direction: 'down_bad', desc: 'Cash received from customers (VchType 14)' },
  payments:   { label: 'Payments',           unit: 'inr', direction: 'up_bad',   desc: 'Cash paid to vendors (VchType 19)' },
  avg_ticket: { label: 'Avg Invoice Value',  unit: 'inr', direction: 'down_bad', desc: 'Sales ÷ invoice count per period' },
  inv_count:  { label: 'Invoice Count',      unit: 'num', direction: 'down_bad', desc: 'Number of sales invoices per period' },
  net_cash:   { label: 'Net Cash Flow',      unit: 'inr', direction: 'down_bad', desc: 'Receipts − Payments per period' },
};

export const GRAINS = ['daily', 'weekly', 'monthly'];

// Rolling window + minimum history before a point can be flagged, per grain
const GRAIN_CFG = {
  daily:   { window: 14, minHist: 7,  ewmaAlpha: 0.3 },
  weekly:  { window: 6,  minHist: 3,  ewmaAlpha: 0.4 },
  monthly: { window: 4,  minHist: 2,  ewmaAlpha: 0.5 },
};

// ── 1. Daily base series (single SQL pass) ────────────────────────────────────
export async function getDailyBase(anchor) {
  const pool = await getPool();
  const res = await pool.request()
    .input('anchor', sql.DateTime, anchor)
    .query(`
      SELECT CAST([Date] AS date) AS d,
        SUM(CASE WHEN VchType=9  THEN VchAmtBaseCur ELSE 0 END) AS sales,
        SUM(CASE WHEN VchType=2  THEN VchAmtBaseCur ELSE 0 END) AS purchase,
        SUM(CASE WHEN VchType=14 THEN VchAmtBaseCur ELSE 0 END) AS receipts,
        SUM(CASE WHEN VchType=19 THEN VchAmtBaseCur ELSE 0 END) AS payments,
        SUM(CASE WHEN VchType=9  THEN 1 ELSE 0 END)             AS inv_count
      FROM Tran1
      WHERE Cancelled = 0 AND VchType IN (9,2,14,19)
        AND [Date] >= DATEADD(MONTH,-13,@anchor) AND [Date] <= @anchor
      GROUP BY CAST([Date] AS date)
      ORDER BY d
    `);
  return res.recordset.map(r => ({
    date: new Date(r.d),
    sales: r.sales || 0,
    purchase: r.purchase || 0,
    receipts: r.receipts || 0,
    payments: r.payments || 0,
    inv_count: r.inv_count || 0,
  }));
}

// ── 2. Aggregate to grain + derive metrics ────────────────────────────────────
function periodKey(date, grain) {
  const y = date.getFullYear();
  if (grain === 'monthly') return { key: `${y}-${String(date.getMonth() + 1).padStart(2, '0')}`, label: date.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }), sort: y * 12 + date.getMonth() };
  if (grain === 'weekly') {
    // ISO-ish week: Monday start
    const d = new Date(date);
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return { key: d.toISOString().slice(0, 10), label: `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`, sort: d.getTime() };
  }
  return { key: date.toISOString().slice(0, 10), label: date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), sort: date.getTime() };
}

export function aggregate(daily, grain) {
  const buckets = new Map();
  for (const row of daily) {
    const { key, label, sort } = periodKey(row.date, grain);
    if (!buckets.has(key)) buckets.set(key, { key, label, sort, sales: 0, purchase: 0, receipts: 0, payments: 0, inv_count: 0 });
    const b = buckets.get(key);
    b.sales += row.sales; b.purchase += row.purchase; b.receipts += row.receipts; b.payments += row.payments; b.inv_count += row.inv_count;
  }
  return [...buckets.values()].sort((a, b) => a.sort - b.sort).map(b => ({
    ...b,
    margin_pct: b.sales > 0 ? (b.sales - b.purchase) / b.sales : 0,
    avg_ticket: b.inv_count > 0 ? b.sales / b.inv_count : 0,
    net_cash: b.receipts - b.payments,
  }));
}

// ── stats helpers ─────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const std = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1));
function median(a) { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; }
function mad(a, med) { return median(a.map(v => Math.abs(v - med))); }
function quantile(a, q) { const s = [...a].sort((x, y) => x - y); const pos = (s.length - 1) * q; const b = Math.floor(pos); return s[b] + (s[b + 1] !== undefined ? (s[b + 1] - s[b]) * (pos - b) : 0); }

export function severityFromScore(score) {
  const s = Math.abs(score);
  if (s >= 5) return 'extreme';
  if (s >= 3.5) return 'heavy';
  if (s >= 2.5) return 'moderate';
  if (s >= 2) return 'mild';
  return 'normal';
}

// ── 3. Engineer rolling features + flag anomalies ─────────────────────────────
export function engineer(series, metricKey, grain) {
  const cfg = GRAIN_CFG[grain] || GRAIN_CFG.daily;
  const vals = series.map(p => p[metricKey] ?? 0);
  let ewma = vals.length ? vals[0] : 0;

  return series.map((p, i) => {
    const x = vals[i];
    // EWMA updates with every point (trend tracker)
    ewma = i === 0 ? x : cfg.ewmaAlpha * x + (1 - cfg.ewmaAlpha) * ewma;

    const hist = vals.slice(Math.max(0, i - cfg.window), i); // trailing, excludes current
    if (hist.length < cfg.minHist) {
      return { ...point(p, metricKey, x), baseline: null, upper: null, lower: null, ewma, z: 0, robustZ: 0, score: 0, severity: 'normal', isAnomaly: false, warming: true };
    }
    const m = mean(hist);
    const sd = std(hist, m);
    const med = median(hist);
    const md = mad(hist, med) * 1.4826; // scaled MAD ≈ σ for normal data
    const q1 = quantile(hist, 0.25), q3 = quantile(hist, 0.75), iqr = q3 - q1;

    const z = sd > 0 ? (x - m) / sd : 0;
    const robustZ = md > 0 ? (x - med) / md : 0;
    const score = Math.abs(z) >= Math.abs(robustZ) ? z : robustZ; // signed, larger magnitude
    const severity = severityFromScore(score);

    return {
      ...point(p, metricKey, x),
      baseline: m,
      ewma,
      upper: m + 2 * sd,
      lower: m - 2 * sd,
      iqrUpper: q3 + 1.5 * iqr,
      iqrLower: q1 - 1.5 * iqr,
      z: +z.toFixed(2),
      robustZ: +robustZ.toFixed(2),
      score: +score.toFixed(2),
      severity,
      isAnomaly: severity !== 'normal',
      warming: false,
    };
  });
}

function point(p, metricKey, x) {
  return { period: p.key, label: p.label, value: x, sales: p.sales, purchase: p.purchase };
}

/** Full engineered series for one metric+grain (used by /timeseries and CSV export). */
export async function metricSeries(metric, grain, anchor) {
  const daily = await getDailyBase(anchor);
  const agg = aggregate(daily, grain);
  const points = engineer(agg, metric, grain);
  const anomalies = points.filter(p => p.isAnomaly);
  return {
    metric, grain,
    meta: METRICS[metric],
    summary: {
      points: points.length,
      anomalies: anomalies.length,
      byLevel: countLevels(anomalies),
      latest: points[points.length - 1] || null,
    },
    points,
  };
}

/** Monday-anchored week key/label for a date (used to bucket the anomaly timeline). */
export function weekKeyOf(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) };
}

export function countLevels(items) {
  const out = { mild: 0, moderate: 0, heavy: 0, extreme: 0 };
  for (const it of items) if (out[it.severity] !== undefined) out[it.severity]++;
  return out;
}
