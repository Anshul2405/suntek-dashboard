import { AsyncLocalStorage } from 'node:async_hooks';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sql from 'mssql';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env.server'), quiet: true });

// Current-year Busy files only. Older years stay closed.
// Chlorides (0007) already includes Delhi, Ganjam, Rehla and the other plants.
// `database` is this year's default. On 1 April the reader moves to the new
// year's file by itself once Busy has created it (see databaseFor).
export const COMPANIES = [
  { code: '0007', name: 'Suntek Chlorides', database: 'BusyComp0007_db12026' },
  { code: '0009', name: 'Suntek Plasticizer', database: 'BusyComp0009_db12026' },
  { code: '0010', name: 'NKG Plastochem', database: 'BusyComp0010_db12026' },
  { code: '0012', name: 'Madan Chemicals', database: 'BusyComp0012_db12026' },
];

export const companyContext = new AsyncLocalStorage();

const pools = new Map();
const picked = new Map();
let pickedAt = 0;

function poolConfig(database) {
  return {
    server: process.env.MSSQL_HOST || 'localhost',
    port: parseInt(process.env.MSSQL_PORT || '1433', 10),
    user: process.env.MSSQL_USER || 'sa',
    password: process.env.MSSQL_PASSWORD,
    database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 90000,
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

/** Indian financial year that today falls in: April 2026 to March 2027 is 2026. */
function financialYear(now = new Date()) {
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

// Busy names a year file BusyComp<code>_db1<year>. Pick this financial year's
// file if the reader can open it, otherwise the newest earlier one. Checked
// hourly, so the year change needs nobody on the PC.
async function refreshDatabases() {
  if (picked.size && Date.now() - pickedAt < 60 * 60 * 1000) return;
  let master;
  try {
    master = new sql.ConnectionPool(poolConfig('master'));
    master.on('error', () => {});
    await master.connect();
    const result = await master.request().query(`
      SELECT name FROM sys.databases
      WHERE name LIKE 'BusyComp[0-9][0-9][0-9][0-9][_]db1[0-9][0-9][0-9][0-9]'
        AND state = 0
        AND HAS_DBACCESS(name) = 1
    `);
    const fy = financialYear();
    for (const company of COMPANIES) {
      const years = result.recordset
        .map((row) => /^BusyComp(\d{4})_db1(\d{4})$/i.exec(row.name))
        .filter((m) => m && m[1] === company.code)
        .map((m) => Number(m[2]));
      const usable = years.filter((y) => y <= fy);
      const year = usable.length ? Math.max(...usable) : null;
      if (year) picked.set(company.code, `BusyComp${company.code}_db1${year}`);
    }
    pickedAt = Date.now();
  } catch {
    // master is not readable. Keep the defaults and try again next time.
    pickedAt = Date.now() - 50 * 60 * 1000;
  } finally {
    try { await master?.close(); } catch { /* already closed */ }
  }
}

export function companyByCode(code) {
  return COMPANIES.find((c) => c.code === code) || null;
}

export function databaseFor(company) {
  return picked.get(company.code) || company.database;
}

export async function getPool() {
  const code = companyContext.getStore() || '0007';
  const company = companyByCode(code);
  if (!company) throw new Error('unknown company');

  await refreshDatabases();
  const database = databaseFor(company);

  const existing = pools.get(database);
  if (existing && existing.connected) return existing;
  if (existing) {
    pools.delete(database);
    try { await existing.close(); } catch { /* already closed */ }
  }

  const pool = new sql.ConnectionPool(poolConfig(database));
  pool.on('error', () => { pools.delete(database); });
  await pool.connect();
  pools.set(database, pool);
  console.log('[db] Connected to', database, 'on', poolConfig(database).server);
  return pool;
}

export { sql };
