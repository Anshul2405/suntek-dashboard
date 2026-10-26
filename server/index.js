import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env.server'), quiet: true });
// Also load .env.local (non-overriding) so the NVIDIA key for the AI analyst is available
loadEnv({ path: join(__dirname, '..', '.env.local'), quiet: true });

import express from 'express';
import cors from 'cors';

import kpisRouter from './routes/kpis.js';
import salesRouter from './routes/sales.js';
import customersRouter from './routes/customers.js';
import movementsRouter from './routes/movements.js';
import analyticsRouter from './routes/analytics.js';
import anomalyRouter from './routes/anomaly.js';
import sitesRouter from './routes/sites.js';
import purchasesRouter from './routes/purchases.js';
import { COMPANIES, companyContext, databaseFor, getPool } from './db.js';

// The push script restarts any older reader that does not report this.
export const READER_VERSION = 'suntek-busy-2026-10-16d';

// A bad query or a dropped SQL connection must not end the reader.
process.on('unhandledRejection', (err) => console.error('[reader] unhandled', err?.message || err));
process.on('uncaughtException', (err) => console.error('[reader] uncaught', err?.message || err));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ?company=0009 reads that Busy file. No query keeps Suntek Chlorides,
// so the live dashboard stays on Chlorides until a company view is deployed.
app.use((req, res, next) => {
  const raw = req.query.company;
  const code = raw == null || raw === '' ? '0007' : String(raw);
  if (!COMPANIES.some((c) => c.code === code)) {
    res.status(400).json({ error: 'unknown company' });
    return;
  }
  companyContext.run(code, () => next());
});

async function readCompany(company) {
  return companyContext.run(company.code, async () => {
    const pool = await getPool();
    const perm = await pool.request().query(`
      SELECT
        CONVERT(int, ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0)) AS sysadmin,
        CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT'), 0)) AS can_select,
        CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT'), 0)) AS can_insert,
        CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE'), 0)) AS can_update,
        CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE'), 0)) AS can_delete
    `);
    const p = perm.recordset[0] || {};
    const readOnly = p.sysadmin !== 1 && p.can_insert !== 1 && p.can_update !== 1 && p.can_delete !== 1 && p.can_select === 1;
    const scan = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM Tran1 WHERE VchType = 9 AND Cancelled = 0) AS salesInvoices,
        (SELECT ISNULL(SUM(VchAmtBaseCur), 0) FROM Tran1
          WHERE VchType = 9 AND Cancelled = 0
            AND MONTH([Date]) = MONTH(GETDATE()) AND YEAR([Date]) = YEAR(GETDATE())
        ) AS salesMTD
    `);
    const row = scan.recordset[0] || {};
    return {
      code: company.code,
      name: company.name,
      database: databaseFor(company),
      readOnly,
      salesInvoices: row.salesInvoices ?? 0,
      salesMTD: row.salesMTD ?? 0,
    };
  });
}

// Answers even when their Busy PC is off, so we can see what is left.
app.get('/api/health', async (_req, res) => {
  const active = COMPANIES.find((c) => c.code === (companyContext.getStore() || '0007'));
  const ready = {
    reader: READER_VERSION,
    database: databaseFor(active),
    reads: [
      'Overview, sales, customers, movements, analytics, purchase invoices',
      'Purchase leaves out liquid chlorine',
      'SHD and Kolkata sales come from the party name',
      'Movements stop at today',
    ],
    stillOutsideBusy: [
      'Payment colour, marine cover, requirements, dispatch, Kolkata and SHD are on the Purchase book page from the workbook',
      'Busy SQL does not store the payment colour or the marine running balance',
    ],
  };
  try {
    const pool = await getPool();
    const ping = await pool.request().query('SELECT DB_NAME() AS db, GETDATE() AS serverTime');
    const companies = [];
    for (const company of COMPANIES) {
      try {
        companies.push(await readCompany(company));
      } catch {
        companies.push({ code: company.code, name: company.name, database: databaseFor(company), error: 'unavailable' });
      }
    }
    const mine = companies.find((c) => c.code === active.code) || {};
    res.json({
      status: 'connected',
      mode: mine.readOnly ? 'read-only' : 'check-permissions',
      readOnly: mine.readOnly === true,
      scan: { salesInvoices: mine.salesInvoices ?? 0, salesMTD: mine.salesMTD ?? 0 },
      companies,
      ...ready,
      db: ping.recordset[0].db,
      serverTime: ping.recordset[0].serverTime,
    });
  } catch {
    res.status(503).json({
      status: 'waiting',
      ...ready,
      next: 'On their Busy PC, open AnyDesk, then set MSSQL_HOST, MSSQL_USER and MSSQL_PASSWORD in server/.env.server and restart this API.',
    });
  }
});

app.use('/api/kpis', kpisRouter);
app.use('/api/sales', salesRouter);
app.use('/api/sales', sitesRouter);
app.use('/api/customers', customersRouter);
app.use('/api/movements', movementsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/anomaly', anomalyRouter);
app.use('/api/purchases', purchasesRouter);

// Only this PC can reach the reader. The push goes out; nothing comes in.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[server] BUSY API running on http://${HOST}:${PORT}`);
});
