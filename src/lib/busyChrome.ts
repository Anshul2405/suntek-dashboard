/**
 * Where the TopBar's Busy controls belong.
 *
 * The "All companies" picker only changes numbers read from the Busy feed
 * (every Busy hook keys on useBusyCompany()). On FAR, Maintenance, Store Req,
 * Batch, the workbook sheets etc. it filters nothing, so showing it there reads
 * like a plant/page filter that does not work. The "Busy · 2h ago" stamp is the
 * feed heartbeat, kept on the same Busy pages only.
 *
 * Busy pages (checked by grep for Busy hooks / useBusyCompany):
 *   /dashboard                 Overview KPIs + Busy movements
 *   /dashboard/owner           OwnerLayer (overview + analytics KPIs)
 *   /dashboard/working-capital WorkingCapital (overview + analytics KPIs)
 *   /dashboard/sales           Sales (sales MTD / contracts / analytics)
 *   /dashboard/customers       Customer History (top customers / list / KPIs)
 *   /dashboard/anomalies       Anomaly dashboard (scan / analytics / metrics by company)
 *   /dashboard/purchase/purchase?ctx=ops   Operations → Purchase (Busy invoices)
 *   /dashboard/purchase/book   stamp on every tab; picker only on Purchases,
 *                              the one tab with Busy tiles + BusyPurchasesCard —
 *                              Kolkata / SHD / workbook sheets are not filtered by it.
 */
export interface BusyChrome {
  company: boolean;
  stamp: boolean;
}

const BUSY_PAGES = new Set([
  '/dashboard',
  '/dashboard/owner',
  '/dashboard/working-capital',
  '/dashboard/sales',
  '/dashboard/customers',
  '/dashboard/anomalies',
]);

const OFF: BusyChrome = { company: false, stamp: false };
const ON: BusyChrome = { company: true, stamp: true };

export function busyChromeOn(pathname: string, search = ''): BusyChrome {
  const path = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  if (BUSY_PAGES.has(path)) return ON;
  if (path === '/dashboard/purchase/purchase') return params.get('ctx') === 'ops' ? ON : OFF;
  if (path === '/dashboard/purchase/book') {
    const tab = params.get('tab') || 'purchases';
    // An unknown tab falls back to Purchases on the page, so treat it the same.
    const purchases = tab === 'purchases' || !['payments', 'paraffin', 'requirements', 'dispatch', 'kolkata', 'shd'].includes(tab);
    return { company: purchases, stamp: true };
  }
  return OFF;
}
