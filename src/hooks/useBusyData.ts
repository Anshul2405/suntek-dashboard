import { useQuery } from '@tanstack/react-query';

// ── Type definitions ──────────────────────────────────────────────────────────

export interface OverviewKPIs {
  salesMTD: number;
  purchaseMTD: number;
  pendingBills: number;
  debtorsOutstanding: number;
  debtorCount: number;
  fyRevenue: number;
  fyPurchase: number;
  salesInvoiceCount: number;
  purchaseInvoiceCount: number;
  paymentsMTD: number;
  receiptsMTD: number;
  /** Live Busy and the backup snapshot both send this. */
  purchaseNote?: string;
}

export interface RevenueTrendPoint {
  month: string;
  revenue: number;
  invoiceCount: number;
}

export interface TopCustomer {
  code: number;
  name: string;
  mtdRevenue: number;
  invoiceCount: number;
}

export interface CustomerOutstanding {
  code: number;
  name: string;
  outstanding: number;
}

export interface CustomerListItem {
  code: number;
  name: string;
  fyRevenue: number;
  mtdRevenue: number;
  fyInvoices: number;
  lastInvoiceDate: string;
  outstanding: number;
}

export interface SalesMTD {
  totalSalesMTD: number;
  receiptsMTD: number;
  openContracts: number;
  gstOutputMTD: number;
  gstInputMTD: number;
  netGSTPayable: number;
  dispatchesMTD: number;
}

export interface SalesContract {
  customer: string;
  totalSales: number;
  mtdSales: number;
  invoiceCount: number;
  outstanding: number;
  status: 'overdue' | 'on track' | 'cleared';
}

export interface Movement {
  type: 'sales' | 'purchase' | 'batch' | 'stock' | 'maint' | 'journal';
  title: string;
  sub: string;
  amt: string;
  col: string;
  /** Display label from the feed: "24 Oct", or "35 min ago" on the today feed. */
  when: string;
  /** Voucher date yyyy-mm-dd and entry time (ISO) — sent by newer Busy pushes; sort on these. */
  date?: string;
  at?: string | null;
}

// ── Helper ────────────────────────────────────────────────────────────────────

const STALE = 5 * 60 * 1000;
// The heartbeat refetches Busy screens after each push. This is only a spare.
const SAFETY_REFETCH = 15 * 60 * 1000;
const FEED_TTL = 60_000;
const BATCH_SIZE = 40;
const LOCAL_TIMEOUT_MS = 4000;

import { supabase } from '../lib/supabase';
import { BUSY_COMPANIES, companyPath, type BusyCompanyCode } from '../lib/busyCompanies';
import { mergeCompanyPayloads } from '../lib/busyMerge';
import { useBusyCompany } from '../contexts/BusyCompanyContext';

// Local reader for `npm run dev`. The live site reads only the busy_feed table.
const BUSY_BASE = (import.meta.env.VITE_BUSY_API_URL ?? '').replace(/\/$/, '');

type FeedRow = { path: string; payload: unknown; updated_at: string };

type FeedSelect = {
  in: (c: string, v: string[]) => Promise<{ data: FeedRow[] | null; error: unknown }>;
  eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: FeedRow | null; error: unknown }> };
};

function feedTable() {
  return (supabase as unknown as {
    from: (t: string) => { select: (c: string) => FeedSelect };
  }).from('busy_feed');
}

const feedCache = new Map<string, { row: FeedRow | null; at: number }>();

/** Drop the short in-memory copy so the next read asks the feed again. */
export function forgetBusyFeedCache() {
  feedCache.clear();
}
const feedPending = new Map<string, Promise<FeedRow | null>>();
let feedQueue: { path: string; resolve: (row: FeedRow | null) => void }[] = [];
let feedTimer: ReturnType<typeof setTimeout> | null = null;

async function flushFeedQueue() {
  const batch = feedQueue;
  feedQueue = [];
  feedTimer = null;
  const paths = [...new Set(batch.map((b) => b.path))];
  const found = new Map<string, FeedRow>();
  let reached = true;
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    try {
      const { data, error } = await feedTable()
        .select('path, payload, updated_at')
        .in('path', paths.slice(i, i + BATCH_SIZE));
      if (error) throw error;
      for (const row of data || []) found.set(row.path, row);
    } catch {
      reached = false;
    }
  }
  const now = Date.now();
  for (const path of paths) {
    if (reached) feedCache.set(path, { row: found.get(path) ?? null, at: now });
    feedPending.delete(path);
  }
  for (const b of batch) b.resolve(found.get(b.path) ?? feedCache.get(b.path)?.row ?? null);
}

/** One feed row. Requests made in the same moment share one small query. */
function feedRow(path: string): Promise<FeedRow | null> {
  const hit = feedCache.get(path);
  if (hit && Date.now() - hit.at < FEED_TTL) return Promise.resolve(hit.row);
  const pending = feedPending.get(path);
  if (pending) return pending;
  const next = new Promise<FeedRow | null>((resolve) => {
    feedQueue.push({ path, resolve });
    if (!feedTimer) feedTimer = setTimeout(flushFeedQueue, 10);
  });
  feedPending.set(path, next);
  return next;
}

function usable(payload: unknown): boolean {
  if (payload == null) return false;
  const p = payload as { error?: unknown; _fallback?: unknown };
  return !p.error && !p._fallback;
}

async function liveOne<T>(path: string): Promise<T | null> {
  const row = await feedRow(path);
  if (row && usable(row.payload)) return row.payload as T;
  if (!BUSY_BASE) return null;
  try {
    const res = await fetch(`${BUSY_BASE}${path}`, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(LOCAL_TIMEOUT_MS)
        : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return usable(data) ? (data as T) : null;
  } catch {
    return null;
  }
}

async function liveCompany<T>(path: string, company: Exclude<BusyCompanyCode, 'all'>): Promise<T | null> {
  const data = await liveOne<T>(companyPath(path, company));
  if (data != null || company !== '0007') return data;
  // Older pushes stored Chlorides on the path with no company.
  return liveOne<T>(path);
}

async function fetchLive<T>(path: string, company: BusyCompanyCode): Promise<T | null> {
  if (company !== 'all') return liveCompany<T>(path, company);
  const parts = await Promise.all(BUSY_COMPANIES.map(async (item) => ({
    code: item.code,
    data: await liveCompany<unknown>(path, item.code),
  })));
  return (mergeCompanyPayloads(path, parts) as T | null) ?? null;
}

// Last good Busy reads, kept in the browser so a reload paints at once.
const SAVED_PREFIX = 'suntek-busy-cache:v1:';
const SAVED_MAX_CHARS = 250_000;

function savedKey(path: string, company: BusyCompanyCode) {
  return `${SAVED_PREFIX}${company}:${path}`;
}

function readSaved<T>(path: string, company: BusyCompanyCode): { at: number; data: T } | undefined {
  try {
    const raw = localStorage.getItem(savedKey(path, company));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at?: number; data?: T };
    if (typeof parsed.at !== 'number' || parsed.data == null) return undefined;
    return { at: parsed.at, data: parsed.data };
  } catch {
    return undefined;
  }
}

function clearSaved() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(SAVED_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* Storage blocked. Nothing to clear. */
  }
}

function writeSaved(path: string, company: BusyCompanyCode, data: unknown) {
  let text: string;
  try {
    text = JSON.stringify({ at: Date.now(), data });
  } catch {
    return;
  }
  if (text.length > SAVED_MAX_CHARS) return;
  try {
    localStorage.setItem(savedKey(path, company), text);
  } catch {
    clearSaved();
    try { localStorage.setItem(savedKey(path, company), text); } catch { /* Full or blocked. */ }
  }
}

export async function fetchBusy<T>(path: string, company: BusyCompanyCode = 'all'): Promise<T> {
  const live = await fetchLive<T>(path, company);
  if (live != null) {
    writeSaved(path, company, live);
    return live;
  }
  // Keep the last good read. A quiet Busy PC must not blank the dashboard.
  const saved = readSaved<T>(path, company);
  if (saved) return saved.data;
  throw new Error('Busy feed is not connected');
}

/** Query options that paint the last saved Busy read before the network answers. */
export function savedBusy<T>(path: string, company: BusyCompanyCode) {
  return {
    initialData: () => readSaved<T>(path, company)?.data,
    initialDataUpdatedAt: () => readSaved<T>(path, company)?.at,
  };
}

function useBusyQuery<T>(
  key: readonly unknown[],
  path: string,
  opts: { stale?: number; retry?: boolean; company?: BusyCompanyCode } = {},
) {
  const { code: picked } = useBusyCompany();
  // A caller with no company picker on screen pins the company so a choice made
  // on another page cannot silently filter it.
  const code = opts.company ?? picked;
  return useQuery<T>({
    queryKey: [...key, code],
    queryFn: () => fetchBusy<T>(path, code),
    ...savedBusy<T>(path, code),
    staleTime: opts.stale ?? STALE,
    refetchInterval: SAFETY_REFETCH,
    ...(opts.retry === undefined ? {} : { retry: opts.retry }),
  });
}

export interface BusyHeartbeat {
  status: 'ok' | 'partial' | 'waiting' | string;
  at: string;
  pushed?: number;
  skipped?: number;
  reader?: string;
  computer?: string;
  note?: string;
}

/** The Busy PC writes this tiny row after every push. */
export function useBusyHeartbeat() {
  return useQuery<BusyHeartbeat | null>({
    queryKey: ['busy-heartbeat'],
    queryFn: async () => {
      const { data, error } = await feedTable()
        .select('path, payload, updated_at')
        .eq('path', '/api/heartbeat')
        .maybeSingle();
      if (error) throw error;
      const beat = data?.payload as BusyHeartbeat | undefined;
      if (!beat) return null;
      return { ...beat, at: beat.at || data!.updated_at };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useOverviewKPIs() {
  return useBusyQuery<OverviewKPIs>(['busy-overview'], '/api/kpis/overview');
}

export function useRevenueTrend() {
  return useBusyQuery<RevenueTrendPoint[]>(['busy-revenue-trend'], '/api/kpis/revenue-trend');
}

export function useTopCustomers(limit = 5) {
  return useBusyQuery<TopCustomer[]>(['busy-top-customers', limit], `/api/customers/top?limit=${limit}`);
}

export function useCustomerOutstanding() {
  return useBusyQuery<CustomerOutstanding[]>(['busy-customer-outstanding'], '/api/customers/outstanding');
}

export function useCustomerList() {
  return useBusyQuery<CustomerListItem[]>(['busy-customer-list'], '/api/customers/list');
}

export function useSalesMTD() {
  return useBusyQuery<SalesMTD>(['busy-sales-mtd'], '/api/sales/mtd');
}

export interface SalesSiteDesk {
  site: 'shd' | 'kolkata';
  salesMTD: number;
  invoiceCount: number;
  top: { name: string; salesMTD: number }[];
}

export function useSalesSites() {
  return useBusyQuery<{ shd: SalesSiteDesk; kolkata: SalesSiteDesk }>(['busy-sales-sites'], '/api/sales/sites', { retry: false });
}

export function useSalesContracts() {
  return useBusyQuery<SalesContract[]>(['busy-sales-contracts'], '/api/sales/contracts');
}

export interface BusyPurchase {
  date: string;
  company: string;
  supplier: string;
  item: string;
  invoice: string;
  amount: number;
}

export function useBusyPurchases() {
  return useBusyQuery<BusyPurchase[]>(['busy-purchases'], '/api/purchases/recent', { retry: false });
}

export function useRecentMovements(days = 3, company?: BusyCompanyCode) {
  return useBusyQuery<Movement[]>(['busy-movements', days], `/api/movements/recent?days=${days}`, { stale: 60 * 1000, company });
}

export interface AnalyticsKPIs {
  // Existing KPIs
  grossMarginPct: number;
  purchaseToCostPct: number;
  dso: number;
  debtorTurnover: number;
  creditorsOutstanding: number;
  netWorkingCapital: number;
  revenueRunRate: number;
  avgTicketFY: number;
  avgTicketPrevMonth: number;
  momRevGrowthPct: number;
  momInvoiceGrowthPct: number;
  dailyVelocity: number;
  uniqueCustomersFY: number;
  uniqueCustomersMTD: number;
  prevMonthUniqueCust: number;
  top5ConcentrationPct: number;
  revenuePerCustomer: number;
  fyReceipts: number;
  fyPayments: number;
  top5: { name: string; fyRevenue: number; sharePct: number }[];
  monthly: { label: string; revenue: number; invoiceCount: number; uniqueCustomers: number }[];
  // New KPIs 1-2: Liquidity cycle
  dpo: number;
  cashConversionCycle: number;
  // New KPI 3: Collection quality
  collectionRatioMTD: number;
  receiptsMTD: number;
  // New KPI 4: Overdue aging
  overdueAging: {
    d1_30: number; d31_60: number; d61_90: number; d90plus: number;
    c1_30: number; c31_60: number; c61_90: number; c90plus: number;
  };
  // New KPI 5: Revenue vs cash gap
  revenueReceiptsGap: number;
  // New KPI 6: Payment completion
  paymentCompletionPct: number;
  // New KPIs 7-8: Supplier intel
  activeSuppliersFY: number;
  activeSuppliersMTD: number;
  top5SupplierConcentrationPct: number;
  top5Suppliers: { name: string; fyPurchase: number; sharePct: number }[];
  // New KPIs 9-10: Customer dynamics
  newCustomersMTD: number;
  lapsedCustomersMTD: number;
  // New KPI 11: Invoice frequency
  invoiceFrequency: number;
  // New KPI 12: Monthly purchase trend
  monthlyPurchase: { label: string; purchase: number; invoiceCount: number }[];
  // New KPI 13: GST net position
  gstOutputMTD: number;
  gstInputMTD: number;
  gstNetMTD: number;
  snapshotAt: string;
  _fallback?: true;
}

export function useAnalyticsKPIs() {
  return useBusyQuery<AnalyticsKPIs>(['busy-analytics-kpis'], '/api/analytics/kpis');
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtINR(n: number): string {
  if (!n || isNaN(n)) return '—';
  if (n >= 10_000_000) return `₹ ${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000)   return `₹ ${(n / 100_000).toFixed(1)} L`;
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
}

export function fmtINRShort(n: number): string {
  if (!n || isNaN(n)) return '—';
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000)   return `${(n / 100_000).toFixed(1)} L`;
  return Math.round(n).toLocaleString('en-IN');
}
