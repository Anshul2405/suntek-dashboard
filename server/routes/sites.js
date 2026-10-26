import { Router } from 'express';
import { getPool } from '../db.js';
import { withFallback } from '../lib/fallback.js';
import { SITE_CASE, THIS_MONTH } from '../lib/busySql.js';
import { canonicalSupplier } from '../lib/supplierAlias.js';

const router = Router();

// Kolkata and SHD are party-name desks in Busy, not separate company files.
router.get('/sites', withFallback('sales-sites', async () => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      site.desk AS site,
      ISNULL(SUM(CASE WHEN ${THIS_MONTH} THEN t.VchAmtBaseCur ELSE 0 END), 0) AS salesMTD,
      SUM(CASE WHEN ${THIS_MONTH} THEN 1 ELSE 0 END) AS invoiceCount
    FROM Tran1 t
    JOIN Master1 m ON m.Code = t.MasterCode1
    CROSS APPLY (SELECT ${SITE_CASE} AS desk) site
    WHERE t.VchType = 9 AND t.Cancelled = 0 AND site.desk IS NOT NULL
    GROUP BY site.desk
  `);

  const top = await pool.request().query(`
    SELECT TOP 20
      site.desk AS site,
      m.Name AS name,
      SUM(t.VchAmtBaseCur) AS salesMTD
    FROM Tran1 t
    JOIN Master1 m ON m.Code = t.MasterCode1
    CROSS APPLY (SELECT ${SITE_CASE} AS desk) site
    WHERE t.VchType = 9 AND t.Cancelled = 0
      AND ${THIS_MONTH}
      AND site.desk IS NOT NULL
    GROUP BY site.desk, m.Name
    ORDER BY SUM(t.VchAmtBaseCur) DESC
  `);

  const bySite = { shd: empty('shd'), kolkata: empty('kolkata') };
  for (const row of result.recordset) {
    if (bySite[row.site]) {
      bySite[row.site].salesMTD = Number(row.salesMTD) || 0;
      bySite[row.site].invoiceCount = Number(row.invoiceCount) || 0;
    }
  }
  for (const row of top.recordset) {
    if (bySite[row.site] && bySite[row.site].top.length < 5) {
      bySite[row.site].top.push({ name: canonicalSupplier(row.name), salesMTD: Number(row.salesMTD) || 0 });
    }
  }
  return { shd: bySite.shd, kolkata: bySite.kolkata };
}));

function empty(site) {
  return { site, salesMTD: 0, invoiceCount: 0, top: [] };
}

export default router;
