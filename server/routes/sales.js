import { Router } from 'express';
import { getPool } from '../db.js';
import { withFallback } from '../lib/fallback.js';
import { canonicalSupplier } from '../lib/supplierAlias.js';

const router = Router();

// KPI #8 CP Sales MTD, #9 Open contracts, #11 GST output, #12 GST input, #13 Receipts MTD
router.get('/mtd', withFallback('sales-mtd', async () => {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        (SELECT ISNULL(SUM(VchAmtBaseCur), 0) FROM Tran1
         WHERE VchType = 9 AND Cancelled = 0
           AND MONTH([Date]) = MONTH(GETDATE()) AND YEAR([Date]) = YEAR(GETDATE())
           AND [Date] <= CAST(GETDATE() AS DATE)
        ) AS totalSalesMTD,

        (SELECT ISNULL(SUM(VchAmtBaseCur), 0) FROM Tran1
         WHERE VchType = 14 AND Cancelled = 0
           AND MONTH([Date]) = MONTH(GETDATE()) AND YEAR([Date]) = YEAR(GETDATE())
           AND [Date] <= CAST(GETDATE() AS DATE)
        ) AS receiptsMTD,

        (SELECT COUNT(*) FROM (
          SELECT MasterCode1 FROM DailySum
          WHERE MasterCode1 IN (SELECT Code FROM Master1 WHERE MasterType=2 AND ParentGrp=116)
          GROUP BY MasterCode1
          HAVING SUM(ISNULL(Dr1,0)-ISNULL(Cr1,0)) > 0
        ) x) AS openContracts,

        (SELECT ISNULL(SUM(TaxAmt + ISNULL(TaxAmt1, 0)), 0) FROM VchGSTSumItemWise
         WHERE VchType = 9
           AND MONTH(VchDate) = MONTH(GETDATE()) AND YEAR(VchDate) = YEAR(GETDATE())
        ) AS gstOutputMTD,

        (SELECT ISNULL(SUM(TaxAmt + ISNULL(TaxAmt1, 0)), 0) FROM VchGSTSumItemWise
         WHERE VchType = 2
           AND MONTH(VchDate) = MONTH(GETDATE()) AND YEAR(VchDate) = YEAR(GETDATE())
        ) AS gstInputMTD,

        (SELECT ISNULL(SUM(CASE WHEN VchType=9 THEN TaxAmt + ISNULL(TaxAmt1,0)
                               ELSE -(TaxAmt + ISNULL(TaxAmt1,0)) END), 0)
         FROM VchGSTSumItemWise
         WHERE VchType IN (9, 2)
           AND MONTH(VchDate) = MONTH(GETDATE()) AND YEAR(VchDate) = YEAR(GETDATE())
        ) AS netGSTPayable,

        (SELECT COUNT(*) FROM Tran1
         WHERE VchType = 6 AND Cancelled = 0
           AND MONTH([Date]) = MONTH(GETDATE()) AND YEAR([Date]) = YEAR(GETDATE())
        ) AS dispatchesMTD
    `);

    return result.recordset[0];
}));

// Contracts / customer-wise outstanding for Sales page table
router.get('/contracts', withFallback('sales-contracts', async () => {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT TOP 20
        m.Name AS customer,
        SUM(t.VchAmtBaseCur) AS totalSales,
        SUM(CASE WHEN MONTH(t.[Date]) = MONTH(GETDATE()) AND YEAR(t.[Date]) = YEAR(GETDATE())
                 THEN t.VchAmtBaseCur ELSE 0 END) AS mtdSales,
        COUNT(*) AS invoiceCount,
        ISNULL(
          (SELECT SUM(Balance1) FROM Tran3 t3
           WHERE t3.MasterCode1 = t.MasterCode1
             AND t3.RecType = 5 AND t3.[Status] = 1),
          0
        ) AS outstanding
      FROM Tran1 t
      JOIN Master1 m ON t.MasterCode1 = m.Code
      WHERE t.VchType = 9 AND t.Cancelled = 0
      GROUP BY t.MasterCode1, m.Name
      ORDER BY SUM(t.VchAmtBaseCur) DESC
    `);

    return result.recordset.map(c => ({
      customer: canonicalSupplier(c.customer),
      totalSales: c.totalSales,
      mtdSales: c.mtdSales,
      invoiceCount: c.invoiceCount,
      outstanding: c.outstanding,
      status: c.outstanding > 0
        ? (c.outstanding > 500000 ? 'overdue' : 'on track')
        : 'cleared',
    }));
}));

export default router;
