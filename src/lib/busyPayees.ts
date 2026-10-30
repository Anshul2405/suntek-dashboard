import { useQuery } from '@tanstack/react-query';
import { fetchBusy, type BusyPurchase, type Movement } from '../hooks/useBusyData';
import { BUSY_COMPANIES } from './busyCompanies';

/**
 * Payees for one Busy company, read-only from what the Busy PC already pushes
 * to busy_feed. There is no supplier master and no bank details in the feed, so
 * the list is the union of: purchase-invoice suppliers (/api/purchases/recent),
 * top vendors (/api/anomaly/analytics) and payment-voucher parties
 * (/api/movements/recent?days=3). Nothing is written to Busy.
 */
export type BusyCompany = (typeof BUSY_COMPANIES)[number]['code'];

export interface BusyPayee {
  name: string;
  /** Which feeds named this party. */
  sources: ('purchases' | 'vendors' | 'payments' | 'master')[];
  code?: string | null;
  accountNo?: string | null;
  ifsc?: string | null;
  bank?: string | null;
}

const PAYMENT_TITLE = /^Payment Voucher\s*·\s*(.+)$/i;

/** Busy appends " · Chlorides" etc. on All-companies reads; keep the party name only. */
function cleanName(name: string): string {
  const shorts = BUSY_COMPANIES.map(c => c.short);
  let n = name.trim();
  for (const s of shorts) if (n.endsWith(` · ${s}`)) n = n.slice(0, -(s.length + 3)).trim();
  return n;
}

export function payeesFromFeeds(
  purchases: Pick<BusyPurchase, 'supplier'>[] | null | undefined,
  vendors: { name: string }[] | null | undefined,
  movements: Pick<Movement, 'type' | 'title'>[] | null | undefined,
): BusyPayee[] {
  const map = new Map<string, BusyPayee>();
  const add = (raw: string | null | undefined, src: BusyPayee['sources'][number]) => {
    const name = cleanName(raw || '');
    if (!name || /^unknown$/i.test(name)) return;
    const k = name.toLowerCase().replace(/\s+/g, ' ');
    const cur = map.get(k) ?? { name, sources: [] };
    if (!cur.sources.includes(src)) cur.sources.push(src);
    map.set(k, cur);
  };
  for (const p of purchases ?? []) add(p.supplier, 'purchases');
  for (const v of vendors ?? []) add(v.name, 'vendors');
  for (const m of movements ?? []) {
    if (m.type !== 'purchase') continue;
    const party = PAYMENT_TITLE.exec(m.title || '')?.[1];
    if (party) add(party, 'payments');
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

/** Payees of one company (empty until a company is picked or the feed has nothing). */
export function useBusyPayees(company: BusyCompany | '') {
  return useQuery<BusyPayee[]>({
    queryKey: ['busy-payees', company],
    enabled: !!company,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!company) return [];
      const [master, purchases, analytics, movements] = await Promise.all([
        safe(fetchBusy<BusyPayee[]>('/api/payees', company)),
        safe(fetchBusy<BusyPurchase[]>('/api/purchases/recent', company)),
        safe(fetchBusy<{ vendors?: { name: string }[] }>('/api/anomaly/analytics', company)),
        safe(fetchBusy<Movement[]>('/api/movements/recent?days=90', company)),
      ]);
      if (Array.isArray(master) && master.length) {
        const extra = payeesFromFeeds(purchases, analytics?.vendors, movements);
        const by = new Map(master.map(p => [p.name.trim().toLowerCase(), { ...p, sources: p.sources?.length ? p.sources : ['master' as const] }]));
        for (const p of extra) {
          const k = p.name.trim().toLowerCase();
          const cur = by.get(k);
          if (!cur) by.set(k, p);
          else {
            for (const s of p.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
          }
        }
        return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
      }
      return payeesFromFeeds(purchases, analytics?.vendors, movements);
    },
  });
}

/** Recent Busy movements per company (read-only), for "Updated in Busy" matching. */
export function useBusyMovementsByCompany(enabled: boolean) {
  return useQuery<Record<string, Movement[]>>({
    queryKey: ['busy-movements-by-company'],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const out: Record<string, Movement[]> = {};
      await Promise.all(BUSY_COMPANIES.map(async c => {
        out[c.code] = (await safe(fetchBusy<Movement[]>('/api/movements/recent?days=90', c.code))) ?? [];
      }));
      return out;
    },
  });
}
