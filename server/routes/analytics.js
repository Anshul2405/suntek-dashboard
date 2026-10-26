import { Router } from 'express';
import { purchaseSum, PURCHASE_LINES, purchaseKeptExpr } from '../lib/busySql.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getPool } from '../db.js';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const FALLBACK = join(__dirname, '../fallback/analytics.json');

function loadFallback() {
  try { return JSON.parse(readFileSync(FALLBACK, 'utf8')); }
  catch { return null; }
}

// GET /api/analytics/kpis — all advanced KPIs in one shot
router.get('/kpis', async (req, res) => {
  try {
    const pool = await getPool();

    const [adv, top5, monthly, cred, aging, supplierCounts, top5Suppliers, purchTrend, dynamics] = await Promise.all([
      // ── EXISTING: core aggregates ─────────────────────────────────────────────
      pool.request().query(`
        SELECT
          (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=14 AND Cancelled=0 AND [Date] <= CAST(GETDATE() AS DATE)) AS fyReceipts,
          (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=19 AND Cancelled=0 AND [Date] <= CAST(GETDATE() AS DATE)) AS fyPayments,
          (SELECT COUNT(DISTINCT MasterCode1) FROM Tran1 WHERE VchType=9 AND Cancelled=0) AS uniqueCustomersFY,
          (SELECT COUNT(DISTINCT MasterCode1) FROM Tran1 WHERE VchType=9 AND Cancelled=0
             AND MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE())) AS uniqueCustomersMTD,
          (SELECT ISNULL(SUM(VchAmtBaseCur),0) FROM Tran1 WHERE VchType=9 AND Cancelled=0
             AND MONTH([Date])=MONTH(DATEADD(MONTH,-1,GETDATE()))
             AND YEAR([Date])=YEAR(DATEADD(MONTH,-1,GETDATE()))) AS prevMonthSales,
          ${purchaseSum(`AND MONTH(t.[Date])=MONTH(DATEADD(MONTH,-1,GETDATE())) AND YEAR(t.[Date])=YEAR(DATEADD(MONTH,-1,GETDATE()))`)} AS prevMonthPurchase,
          (SELECT COUNT(*) FROM Tran1 WHERE VchType=9 AND Cancelled=0
             AND MONTH([Date])=MONTH(DATEADD(MONTH,-1,GETDATE()))
             AND YEAR([Date])=YEAR(DATEADD(MONTH,-1,GETDATE()))) AS prevMonthInvoiceCount,
          (SELECT COUNT(DISTINCT MasterCode1) FROM Tran1 WHERE VchType=9 AND Cancelled=0
             AND MONTH([Date])=MONTH(DATEADD(MONTH,-1,GETDATE()))
             AND YEAR([Date])=YEAR(DATEADD(MONTH,-1,GETDATE()))) AS prevMonthUniqueCust,
          DATEDIFF(DAY, DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1), GETDATE()) AS daysSoFar
      `),

      // ── EXISTING: top 5 customers by FY revenue ───────────────────────────────
      pool.request().query(`
        SELECT TOP 5
          m.Name AS name,
          SUM(t.VchAmtBaseCur) AS fyRevenue,
          COUNT(*) AS fyInvoiceCount
        FROM Tran1 t JOIN Master1 m ON t.MasterCode1=m.Code
        WHERE t.VchType=9 AND t.Cancelled=0
        GROUP BY t.MasterCode1, m.Name
        ORDER BY SUM(t.VchAmtBaseCur) DESC
      `),

      // ── EXISTING: monthly revenue trend (last 6 months) ──────────────────────
      pool.request().query(`
        SELECT
          YEAR([Date]) AS yr, MONTH([Date]) AS mo,
          SUM(VchAmtBaseCur) AS revenue,
          COUNT(*) AS invoiceCount,
          COUNT(DISTINCT MasterCode1) AS uniqueCustomers
        FROM Tran1
        WHERE VchType=9 AND Cancelled=0
          AND [Date] >= DATEADD(MONTH,-5,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1))
        GROUP BY YEAR([Date]), MONTH([Date])
        ORDER BY yr, mo
      `),

      // ── EXISTING: creditors outstanding ──────────────────────────────────────
      pool.request().query(`
        SELECT ISNULL(SUM(net),0) AS creditorsOutstanding FROM (
          SELECT SUM(ISNULL(Cr1,0)-ISNULL(Dr1,0)) AS net FROM DailySum
          WHERE MasterCode1 IN (SELECT Code FROM Master1 WHERE MasterType=2 AND ParentGrp=117)
          GROUP BY MasterCode1 HAVING SUM(ISNULL(Cr1,0)-ISNULL(Dr1,0)) > 0
        ) x
      `),

      // ── NEW KPI 4: Overdue aging buckets ─────────────────────────────────────
      pool.request().query(`
        SELECT
          ISNULL(SUM(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) BETWEEN 1 AND 30
            THEN Balance1 ELSE 0 END),0) AS d1_30,
          ISNULL(SUM(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) BETWEEN 31 AND 60
            THEN Balance1 ELSE 0 END),0) AS d31_60,
          ISNULL(SUM(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) BETWEEN 61 AND 90
            THEN Balance1 ELSE 0 END),0) AS d61_90,
          ISNULL(SUM(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) > 90
            THEN Balance1 ELSE 0 END),0) AS d90plus,
          COUNT(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) BETWEEN 1 AND 30 THEN 1 END) AS c1_30,
          COUNT(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) BETWEEN 31 AND 60 THEN 1 END) AS c31_60,
          COUNT(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) BETWEEN 61 AND 90 THEN 1 END) AS c61_90,
          COUNT(CASE WHEN DATEDIFF(DAY, DueDate, GETDATE()) > 90 THEN 1 END) AS c90plus
        FROM Tran3
        WHERE RecType=5 AND Status=1 AND DueDate < CAST(GETDATE() AS DATE)
      `),

      // ── NEW KPI 7: Active supplier counts ────────────────────────────────────
      pool.request().query(`
        SELECT
          COUNT(DISTINCT CASE WHEN YEAR([Date])=YEAR(GETDATE()) THEN MasterCode1 END) AS activeSuppliersFY,
          COUNT(DISTINCT CASE WHEN MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE())
            THEN MasterCode1 END) AS activeSuppliersMTD
        FROM Tran1
        WHERE VchType=2 AND Cancelled=0
      `),

      // ── NEW KPI 8: Top 5 suppliers by FY purchase spend ──────────────────────
      pool.request().query(`
        SELECT TOP 5
          m.Name AS name,
          SUM(ABS(t2.Value1)) AS fyPurchase
        FROM Tran2 t2
        JOIN Tran1 t ON t.VchCode = t2.VchCode AND t.VchType = 2 AND t.Cancelled = 0
          AND YEAR(t.[Date]) = YEAR(GETDATE())
          AND t.[Date] <= CAST(GETDATE() AS DATE)
        JOIN Master1 m ON m.Code = t2.MasterCode1 AND m.MasterType = 2 AND m.ParentGrp = 117
        GROUP BY m.Name
        ORDER BY SUM(ABS(t2.Value1)) DESC
      `),

      // ── NEW KPI 12: Monthly purchase trend (last 6 months) ───────────────────
      pool.request().query(`
        SELECT
          YEAR(t.[Date]) AS yr, MONTH(t.[Date]) AS mo,
          SUM(${purchaseKeptExpr('t')}) AS purchase,
          COUNT(*) AS invoiceCount
        FROM Tran1 t
        ${PURCHASE_LINES}
        WHERE t.VchType=2 AND t.Cancelled=0
          AND t.[Date] >= DATEADD(MONTH,-5,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1))
          AND t.[Date] <= CAST(GETDATE() AS DATE)
        GROUP BY YEAR(t.[Date]), MONTH(t.[Date])
        ORDER BY yr, mo
      `),

      // ── NEW KPIs 3, 9, 10, 13: MTD receipts + GST + customer dynamics ────────
      pool.request().query(`
        SELECT
          ISNULL((SELECT SUM(VchAmtBaseCur) FROM Tran1
            WHERE VchType=14 AND Cancelled=0
            AND MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE())
            AND [Date] <= CAST(GETDATE() AS DATE)),0) AS receiptsMTD,
          ISNULL((SELECT SUM(g.TaxAmt + ISNULL(g.TaxAmt1,0))
            FROM VchGSTSumItemWise g
            WHERE g.VchType=9
              AND EXISTS (SELECT 1 FROM Tran1 t WHERE t.VchNo=g.VchNo AND t.VchType=9
                AND t.Cancelled=0
                AND MONTH(t.[Date])=MONTH(GETDATE()) AND YEAR(t.[Date])=YEAR(GETDATE()))),0) AS gstOutputMTD,
          ISNULL((SELECT SUM(g.TaxAmt + ISNULL(g.TaxAmt1,0))
            FROM VchGSTSumItemWise g
            WHERE g.VchType=2
              AND EXISTS (SELECT 1 FROM Tran1 t WHERE t.VchNo=g.VchNo AND t.VchType=2
                AND t.Cancelled=0
                AND MONTH(t.[Date])=MONTH(GETDATE()) AND YEAR(t.[Date])=YEAR(GETDATE()))),0) AS gstInputMTD,
          (SELECT COUNT(*) FROM (
            SELECT MasterCode1 FROM Tran1 WHERE VchType=9 AND Cancelled=0
            GROUP BY MasterCode1
            HAVING MIN(CAST([Date] AS DATE)) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
          ) x) AS newCustomersMTD,
          (SELECT COUNT(*) FROM (
            SELECT MasterCode1 FROM Tran1 WHERE VchType=9 AND Cancelled=0
              AND MONTH([Date])=MONTH(DATEADD(MONTH,-1,GETDATE()))
              AND YEAR([Date])=YEAR(DATEADD(MONTH,-1,GETDATE()))
            GROUP BY MasterCode1
            EXCEPT
            SELECT MasterCode1 FROM Tran1 WHERE VchType=9 AND Cancelled=0
              AND MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE())
            GROUP BY MasterCode1
          ) x) AS lapsedCustomersMTD
      `),
    ]);

    // ── Pull overview KPIs inline ─────────────────────────────────────────────
    const ov = await pool.request().query(`
      SELECT
        ISNULL((SELECT SUM(VchAmtBaseCur) FROM Tran1 WHERE VchType=9 AND Cancelled=0),0) AS fyRevenue,
        ${purchaseSum('')} AS fyPurchase,
        ISNULL((SELECT SUM(VchAmtBaseCur) FROM Tran1 WHERE VchType=9 AND Cancelled=0
          AND MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE())),0) AS salesMTD,
        (SELECT ISNULL(SUM(net),0) FROM (
          SELECT SUM(ISNULL(Dr1,0)-ISNULL(Cr1,0)) AS net FROM DailySum
          WHERE MasterCode1 IN (SELECT Code FROM Master1 WHERE MasterType=2 AND ParentGrp=116)
          GROUP BY MasterCode1 HAVING SUM(ISNULL(Dr1,0)-ISNULL(Cr1,0)) > 0
        ) x) AS debtorsOutstanding,
        (SELECT COUNT(*) FROM Tran1 WHERE VchType=9 AND Cancelled=0) AS salesInvoiceCount
    `);

    const a  = adv.recordset[0];
    const o  = ov.recordset[0];
    const d  = dynamics.recordset[0];
    const ag = aging.recordset[0];
    const sc = supplierCounts.recordset[0];
    const creditorsOutstanding = cred.recordset[0].creditorsOutstanding;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // ── Existing derived KPIs ─────────────────────────────────────────────────
    const fyRevenue          = o.fyRevenue;
    const fyPurchase         = o.fyPurchase || 1;
    const debtors            = o.debtorsOutstanding;
    const salesMTD           = o.salesMTD || 1;
    const daysSoFar          = a.daysSoFar || 1;

    const grossMarginPct     = ((fyRevenue - fyPurchase) / fyRevenue * 100);
    const dso                = (debtors / fyRevenue * 365);
    const debtorTurnover     = (fyRevenue / (debtors || 1));
    const avgTicketFY        = (fyRevenue / (o.salesInvoiceCount || 1));
    const avgTicketPrevMonth = a.prevMonthSales / (a.prevMonthInvoiceCount || 1);
    const netWorkingCapital  = debtors - creditorsOutstanding;
    const top5Total          = top5.recordset.reduce((s, c) => s + c.fyRevenue, 0);
    const top5ConcentrationPct = (top5Total / fyRevenue * 100);
    const revenuePerCustomer = (fyRevenue / (a.uniqueCustomersFY || 1));

    const completedMonths = monthly.recordset.slice(0, -1);
    const avgMonthlyRevenue = completedMonths.length
      ? completedMonths.reduce((s, m) => s + m.revenue, 0) / completedMonths.length
      : fyRevenue / 2;
    const revenueRunRate = avgMonthlyRevenue * 12;

    const [prevPrev, prev] = completedMonths.slice(-2);
    const momRevGrowthPct = prevPrev && prev
      ? (prev.revenue - prevPrev.revenue) / prevPrev.revenue * 100 : 0;
    const momInvoiceGrowthPct = prevPrev && prev
      ? (prev.invoiceCount - prevPrev.invoiceCount) / prevPrev.invoiceCount * 100 : 0;

    const dailyVelocity = daysSoFar > 0 ? salesMTD / daysSoFar : 0;

    // ── New derived KPIs ──────────────────────────────────────────────────────
    const dpo                      = (creditorsOutstanding / fyPurchase * 365);
    const cashConversionCycle      = dso - dpo;
    const collectionRatioMTD       = (d.receiptsMTD / salesMTD * 100);
    const revenueReceiptsGap       = fyRevenue - a.fyReceipts;
    const paymentCompletionPct     = (a.fyPayments / fyPurchase * 100);
    const gstNetMTD                = d.gstOutputMTD - d.gstInputMTD;
    const invoiceFrequency         = (o.salesInvoiceCount / (a.uniqueCustomersFY || 1));

    const top5SuppliersTotal = top5Suppliers.recordset.reduce((s, r) => s + r.fyPurchase, 0);
    const top5SupplierConcentrationPct = (top5SuppliersTotal / fyPurchase * 100);

    const result = {
      // ── Existing KPIs ───────────────────────────────────────────────────────
      grossMarginPct: +grossMarginPct.toFixed(1),
      purchaseToCostPct: +(100 - grossMarginPct).toFixed(1),
      dso: +dso.toFixed(1),
      debtorTurnover: +debtorTurnover.toFixed(2),
      creditorsOutstanding,
      netWorkingCapital,
      revenueRunRate,
      avgTicketFY,
      avgTicketPrevMonth,
      momRevGrowthPct: +momRevGrowthPct.toFixed(1),
      momInvoiceGrowthPct: +momInvoiceGrowthPct.toFixed(1),
      dailyVelocity,
      uniqueCustomersFY: a.uniqueCustomersFY,
      uniqueCustomersMTD: a.uniqueCustomersMTD,
      prevMonthUniqueCust: a.prevMonthUniqueCust,
      top5ConcentrationPct: +top5ConcentrationPct.toFixed(1),
      revenuePerCustomer,
      fyReceipts: a.fyReceipts,
      fyPayments: a.fyPayments,
      top5: top5.recordset.map(c => ({
        name: c.name.length > 22 ? c.name.slice(0, 22) + '…' : c.name,
        fyRevenue: c.fyRevenue,
        sharePct: +(c.fyRevenue / fyRevenue * 100).toFixed(1),
      })),
      monthly: monthly.recordset.map(m => ({
        label: MONTHS[m.mo - 1],
        revenue: m.revenue,
        invoiceCount: m.invoiceCount,
        uniqueCustomers: m.uniqueCustomers,
      })),

      // ── New KPIs ─────────────────────────────────────────────────────────────
      // KPI 1 & 2: Liquidity cycle
      dpo: +dpo.toFixed(1),
      cashConversionCycle: +cashConversionCycle.toFixed(1),
      // KPI 3: Collection quality
      collectionRatioMTD: +collectionRatioMTD.toFixed(1),
      receiptsMTD: d.receiptsMTD,
      // KPI 4: Overdue aging
      overdueAging: {
        d1_30: ag.d1_30, d31_60: ag.d31_60, d61_90: ag.d61_90, d90plus: ag.d90plus,
        c1_30: ag.c1_30, c31_60: ag.c31_60, c61_90: ag.c61_90, c90plus: ag.c90plus,
      },
      // KPI 5: Revenue vs cash
      revenueReceiptsGap,
      // KPI 6: Payment completion
      paymentCompletionPct: +paymentCompletionPct.toFixed(1),
      // KPI 7 & 8: Supplier intel
      activeSuppliersFY: sc.activeSuppliersFY,
      activeSuppliersMTD: sc.activeSuppliersMTD,
      top5SupplierConcentrationPct: +top5SupplierConcentrationPct.toFixed(1),
      top5Suppliers: top5Suppliers.recordset.map(s => ({
        name: s.name.length > 22 ? s.name.slice(0, 22) + '…' : s.name,
        fyPurchase: s.fyPurchase,
        sharePct: +(s.fyPurchase / fyPurchase * 100).toFixed(1),
      })),
      // KPI 9 & 10: Customer dynamics
      newCustomersMTD: d.newCustomersMTD,
      lapsedCustomersMTD: d.lapsedCustomersMTD,
      // KPI 11: Invoice frequency
      invoiceFrequency: +invoiceFrequency.toFixed(2),
      // KPI 12: Monthly purchase trend
      monthlyPurchase: purchTrend.recordset.map(m => ({
        label: MONTHS[m.mo - 1],
        purchase: m.purchase,
        invoiceCount: m.invoiceCount,
      })),
      // KPI 13: GST net position
      gstOutputMTD: d.gstOutputMTD,
      gstInputMTD: d.gstInputMTD,
      gstNetMTD: +gstNetMTD.toFixed(0),

      // Meta
      snapshotAt: new Date().toISOString(),
    };

    // ── Write fallback snapshot ───────────────────────────────────────────────
    const { writeFileSync } = await import('fs');
    const { join: j } = await import('path');
    try {
      writeFileSync(
        j(dirname(fileURLToPath(import.meta.url)), '../fallback/analytics.json'),
        JSON.stringify(result, null, 2)
      );
    } catch { /* ignore write errors */ }

    res.json(result);
  } catch (err) {
    console.error('[analytics/kpis] DB error, serving fallback:', err.message);
    const fallback = loadFallback();
    if (fallback) return res.json({ ...fallback, _fallback: true });
    res.status(500).json({ error: err.message });
  }
});

export default router;
