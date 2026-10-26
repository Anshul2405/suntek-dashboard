// Opens each Busy company with the read-only login and prints one line each.
// Used by the installer and check-busy. Prints no password.
import { COMPANIES, companyContext, databaseFor, getPool } from './db.js';

let failed = 0;
for (const company of COMPANIES) {
  try {
    const row = await companyContext.run(company.code, async () => {
      const pool = await getPool();
      const r = await pool.request().query(`
        SELECT DB_NAME() AS db,
          CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT'), 0)) AS can_insert,
          CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE'), 0)) AS can_update,
          CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE'), 0)) AS can_delete,
          (SELECT COUNT(*) FROM Tran1 WHERE VchType = 2 AND Cancelled = 0) AS purchases,
          (SELECT COUNT(*) FROM Tran1 WHERE VchType = 9 AND Cancelled = 0) AS sales
      `);
      return r.recordset[0];
    });
    const readOnly = !row.can_insert && !row.can_update && !row.can_delete;
    console.log(`OK    ${company.name}  ${row.db}  sales ${row.sales}  purchases ${row.purchases}  ${readOnly ? 'read-only' : 'WARNING: login can write'}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${company.name}  ${databaseFor(company)}  ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
