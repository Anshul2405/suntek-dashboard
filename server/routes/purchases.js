import { Router } from 'express';
import { COMPANIES, companyContext, getPool } from '../db.js';
import { NOT_FUTURE } from '../lib/busySql.js';
import { canonicalSupplier } from '../lib/supplierAlias.js';

const router = Router();

// Read-only purchase invoices (Busy VchType 2). Busy is never updated from here.
// The supplier is the party on the invoice header. If the header has none,
// it is the largest Sundry Creditors line (group 117) on the voucher.
router.get('/recent', async (_req, res) => {
  try {
    const code = companyContext.getStore() || '0007';
    const company = COMPANIES.find((item) => item.code === code);
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT TOP 80
        CONVERT(varchar(10), t.[Date], 23) AS date,
        t.VchNo AS invoice,
        t.VchAmtBaseCur AS amount,
        COALESCE(hdr.Name, party.Name) AS supplier,
        item.Name AS item
      FROM Tran1 t
      LEFT JOIN Master1 hdr ON hdr.Code = t.MasterCode1 AND hdr.MasterType = 2
      OUTER APPLY (
        SELECT TOP 1 m.Name
        FROM Tran2 t2
        JOIN Master1 m ON m.Code = t2.MasterCode1 AND m.MasterType = 2
        WHERE t2.VchCode = t.VchCode
        ORDER BY CASE WHEN m.ParentGrp = 117 THEN 0 ELSE 1 END, ABS(t2.Value1) DESC
      ) party
      OUTER APPLY (
        SELECT TOP 1 m.Name
        FROM Tran2 t2
        JOIN Master1 m ON m.Code = t2.MasterCode1 AND m.MasterType = 6
        WHERE t2.VchCode = t.VchCode
        ORDER BY ABS(t2.Value1) DESC
      ) item
      WHERE t.VchType = 2
        AND t.Cancelled = 0
        AND ${NOT_FUTURE}
      ORDER BY t.[Date] DESC, t.VchCode DESC
    `);
    res.json(result.recordset.map((row) => ({
      date: row.date,
      company: company?.name || code,
      supplier: canonicalSupplier(row.supplier || ''),
      item: row.item || '',
      invoice: String(row.invoice || '').trim(),
      amount: Number(row.amount) || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
