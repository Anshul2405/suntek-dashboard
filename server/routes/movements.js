import { Router } from 'express';
import { getPool } from '../db.js';
import { withFallback } from '../lib/fallback.js';

const router = Router();

const VCH_TYPE_LABELS = {
  9:  { type: 'sales',    label: 'Sales Invoice' },
  14: { type: 'purchase', label: 'Purchase Invoice' },
  2:  { type: 'journal',  label: 'Journal Entry' },
  19: { type: 'purchase', label: 'Payment Voucher' },
  16: { type: 'sales',    label: 'Receipt Voucher' },
  6:  { type: 'stock',    label: 'Stock Transfer' },
  3:  { type: 'purchase', label: 'Purchase Order' },
  5:  { type: 'batch',    label: 'Manufacturing' },
  12: { type: 'sales',    label: 'Debit Note' },
  13: { type: 'sales',    label: 'Sales Return' },
};

/** yyyy-mm-dd of a SQL date without shifting the calendar day through toISOString. */
function sqlCalendarDay(d) {
  if (!d) return null;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatAmt(amt) {
  return amt >= 10000000
    ? `₹${(amt / 10000000).toFixed(2)} Cr`
    : amt >= 100000
      ? `₹${(amt / 100000).toFixed(1)} L`
      : `₹${Math.round(amt).toLocaleString('en-IN')}`;
}

function toMovement(r, useRelativeTime = false) {
  const meta = VCH_TYPE_LABELS[r.VchType] || { type: 'journal', label: 'Voucher' };
  const fmtAmt = formatAmt(r.VchAmtBaseCur);
  const when = useRelativeTime && r.CreationTime
    ? (() => {
        const mins = Math.floor((Date.now() - new Date(r.CreationTime)) / 60000);
        return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} hr ago`;
      })()
    : new Date(r.Date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  return {
    type: meta.type,
    // Calendar day from the SQL date (do not use toISOString — that can shift the day).
    date: sqlCalendarDay(r.Date),
    at: r.CreationTime ? new Date(r.CreationTime).toISOString() : null,
    title: `${meta.label} · ${r.partyName || 'Unknown'}`,
    sub: `${r.VchNo}${r.GrNo ? ' · GR ' + r.GrNo : ''}`,
    amt: meta.type === 'sales' || meta.type === 'batch' ? `+${fmtAmt}` : `-${fmtAmt}`,
    col: meta.type === 'sales' ? '#16A34A' : meta.type === 'purchase' ? '#DC2626' : '#475569',
    when,
  };
}

// KPI #14 Today's transaction feed
router.get('/today', withFallback('movements-today', async () => {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT TOP 20
        t.VchType, t.VchNo, t.[Date], t.VchAmtBaseCur, t.CreationTime,
        m.Name AS partyName, o.Transport, o.GrNo
      FROM Tran1 t
      LEFT JOIN Master1 m ON t.MasterCode1 = m.Code
      LEFT JOIN VchOtherInfo o ON t.VchCode = o.VchCode
      WHERE CAST(t.[Date] AS DATE) = CAST(GETDATE() AS DATE)
        AND t.Cancelled = 0
      ORDER BY t.CreationTime DESC
    `);

    return result.recordset.map(r => toMovement(r, true));
}));

// Recent transactions (last N days) for movements feed
router.get('/recent', withFallback('movements-recent', async (req) => {
    const pool = await getPool();
    const days = Math.min(parseInt(req.query.days) || 1, 7);

    const result = await pool.request().query(`
      SELECT TOP 30
        t.VchType, t.VchNo, t.[Date], t.VchAmtBaseCur, t.CreationTime,
        m.Name AS partyName, o.GrNo
      FROM Tran1 t
      LEFT JOIN Master1 m ON t.MasterCode1 = m.Code
      LEFT JOIN VchOtherInfo o ON t.VchCode = o.VchCode
      WHERE t.[Date] >= DATEADD(DAY, -${days}, CAST(GETDATE() AS DATE))
        AND t.Cancelled = 0
      ORDER BY t.[Date] DESC, t.CreationTime DESC
    `);

    return result.recordset.map(r => toMovement(r, false));
}));

export default router;
