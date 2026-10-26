import { Router } from 'express';
import { getPool } from '../db.js';
import { withFallback } from '../lib/fallback.js';
import { canonicalSupplier } from '../lib/supplierAlias.js';

const router = Router();

// KPI #5 Top customers by MTD revenue
router.get('/top', withFallback('customers-top', async (req) => {
    const pool = await getPool();
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);

    const result = await pool.request().query(`
      SELECT TOP ${limit}
        t.MasterCode1 AS code,
        m.Name AS name,
        SUM(t.VchAmtBaseCur) AS mtdRevenue,
        COUNT(*) AS invoiceCount
      FROM Tran1 t
      JOIN Master1 m ON t.MasterCode1 = m.Code
      WHERE t.VchType = 9
        AND t.Cancelled = 0
        AND MONTH(t.[Date]) = MONTH(GETDATE())
        AND YEAR(t.[Date]) = YEAR(GETDATE())
      GROUP BY t.MasterCode1, m.Name
      ORDER BY SUM(t.VchAmtBaseCur) DESC
    `);

    return result.recordset.map(row => ({ ...row, name: canonicalSupplier(row.name) }));
}));

// KPI #10 Customer outstanding per party (via DailySum + Folio1 opening)
router.get('/outstanding', withFallback('customers-outstanding', async () => {
    const pool = await getPool();

    const daily = await pool.request().query(`
      SELECT
        d.MasterCode1 AS code,
        m.Name AS name,
        SUM(ISNULL(d.Dr1, 0)) AS totalDr,
        SUM(ISNULL(d.Cr1, 0)) AS totalCr
      FROM DailySum d
      JOIN Master1 m ON d.MasterCode1 = m.Code
      WHERE m.MasterType = 2 AND m.ParentGrp = 116
      GROUP BY d.MasterCode1, m.Name
    `);

    const folio = await pool.request().query(`
      SELECT f.MasterCode AS code, ISNULL(f.D1, 0) AS drOpen, ISNULL(f.D2, 0) AS crOpen
      FROM Folio1 f
      JOIN Master1 m ON f.MasterCode = m.Code
      WHERE m.MasterType = 2 AND m.ParentGrp = 116
    `);

    const folioMap = {};
    folio.recordset.forEach(f => { folioMap[f.code] = { drOpen: f.drOpen, crOpen: f.crOpen }; });

    return daily.recordset.map(d => {
      const fo = folioMap[d.code] || { drOpen: 0, crOpen: 0 };
      const outstanding = (fo.drOpen - fo.crOpen) + (d.totalDr - d.totalCr);
      return { code: d.code, name: canonicalSupplier(d.name), outstanding };
    }).filter(c => c.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding);
}));

// Full customer list with MTD sales + outstanding
router.get('/list', withFallback('customers-list', async () => {
    const pool = await getPool();

    const sales = await pool.request().query(`
      SELECT TOP 50
        t.MasterCode1 AS code,
        m.Name AS name,
        SUM(t.VchAmtBaseCur) AS fyRevenue,
        SUM(CASE WHEN MONTH(t.[Date]) = MONTH(GETDATE()) AND YEAR(t.[Date]) = YEAR(GETDATE())
                 THEN t.VchAmtBaseCur ELSE 0 END) AS mtdRevenue,
        COUNT(*) AS fyInvoices,
        MAX(t.[Date]) AS lastInvoiceDate
      FROM Tran1 t
      JOIN Master1 m ON t.MasterCode1 = m.Code
      WHERE t.VchType = 9 AND t.Cancelled = 0
      GROUP BY t.MasterCode1, m.Name
      ORDER BY fyRevenue DESC
    `);

    const outstanding = await pool.request().query(`
      SELECT
        d.MasterCode1 AS code,
        SUM(ISNULL(d.Dr1,0)) - SUM(ISNULL(d.Cr1,0)) +
        ISNULL((SELECT ISNULL(D1,0)-ISNULL(D2,0) FROM Folio1 WHERE MasterCode=d.MasterCode1), 0)
          AS outstanding
      FROM DailySum d
      WHERE d.MasterCode1 IN (
        SELECT Code FROM Master1 WHERE MasterType=2 AND ParentGrp=116
      )
      GROUP BY d.MasterCode1
    `);

    const outMap = {};
    outstanding.recordset.forEach(o => { outMap[o.code] = Math.max(0, o.outstanding); });

    return sales.recordset.map(c => ({
      code: c.code,
      name: canonicalSupplier(c.name),
      fyRevenue: c.fyRevenue,
      mtdRevenue: c.mtdRevenue,
      fyInvoices: c.fyInvoices,
      lastInvoiceDate: c.lastInvoiceDate,
      outstanding: outMap[c.code] || 0,
    }));
}));

export default router;
