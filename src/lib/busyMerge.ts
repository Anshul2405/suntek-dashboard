import { companyShort } from './busyCompanies';

export interface CompanyPart {
  code: string;
  data: unknown;
}

const RATIOS = new Set([
  'grossMarginPct', 'purchaseToCostPct', 'dso', 'debtorTurnover',
  'momRevGrowthPct', 'momInvoiceGrowthPct', 'top5ConcentrationPct',
  'collectionRatioMTD', 'paymentCompletionPct', 'top5SupplierConcentrationPct',
  'invoiceFrequency', 'dpo', 'cashConversionCycle', 'avgTicketFY', 'avgTicketPrevMonth',
  'revenuePerCustomer', 'fyPct', 'recentPct', 'priorPct', 'sharePct', 'z',
]);

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** FY sales of one company's analytics payload: its top-5 sum ÷ top-5 concentration. */
function impliedRevenue(row: Record<string, unknown>): number {
  const list = Array.isArray(row.top5) ? row.top5 as Record<string, unknown>[] : [];
  const pct = num(row.top5ConcentrationPct);
  const sum = list.reduce((acc, r) => acc + num(r.fyRevenue), 0);
  return sum && pct > 0 ? sum / (pct / 100) : 0;
}

function weightOf(row: Record<string, unknown>): number {
  // The analytics payload carries no revenue field; without impliedRevenue a
  // small company's margin counted as much as the largest one's.
  return num(row.fyRevenue) || num(row.salesMTD) || num(row.totalSalesMTD) || num(row.spend) || impliedRevenue(row) || 1;
}

function weighted(rows: Record<string, unknown>[], key: string): number {
  let wsum = 0;
  let vsum = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const w = weightOf(row);
    wsum += w;
    vsum += value * w;
  }
  return wsum ? vsum / wsum : 0;
}

/** Combined rates are real divisions. Round them so 15.475 does not print as 15.475000000000001. */
function roundRatio(key: string, value: number): number {
  const digits = key === 'debtorTurnover' || key === 'invoiceFrequency' ? 2 : 1;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function tag(name: unknown, code: string): string {
  const text = String(name ?? '').trim();
  const short = companyShort(code);
  if (!text) return short;
  if (text.endsWith(`· ${short}`)) return text;
  return `${text} · ${short}`;
}

function sumBy(rows: Record<string, unknown>[], labelKey: string, fields: string[]) {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const label = String(row[labelKey] ?? '');
    let acc = map.get(label);
    if (!acc) {
      acc = { ...row, [labelKey]: label };
      for (const field of fields) if (typeof acc[field] === 'number') acc[field] = 0;
      map.set(label, acc);
    }
    for (const field of fields) {
      if (typeof row[field] === 'number') acc[field] = num(acc[field]) + num(row[field]);
    }
  }
  return [...map.values()];
}

/** Sum of every company's FY total, recovered from its top-5 list and concentration %. 0 if unknown. */
function companyTotal(rows: Record<string, unknown>[], listKey: string, amountKey: string, concKey: string): number {
  let total = 0;
  for (const row of rows) {
    const list = Array.isArray(row[listKey]) ? row[listKey] as Record<string, unknown>[] : [];
    const pct = num(row[concKey]);
    const sum = list.reduce((acc, r) => acc + num(r[amountKey]), 0);
    if (!sum) continue;
    if (pct <= 0) return 0;
    total += sum / (pct / 100);
  }
  return total;
}

function sumRecord(rows: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const key of keys) {
    const present = rows.filter((row) => row[key] != null);
    if (!present.length) continue;
    const values = present.map((row) => row[key]);
    if (values.every((value) => typeof value === 'number')) {
      out[key] = RATIOS.has(key) ? roundRatio(key, weighted(present, key)) : values.reduce<number>((sum, value) => sum + num(value), 0);
    } else if (key === 'overdueAging' && values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
      out[key] = sumRecord(values as Record<string, unknown>[]);
    } else if ((key === 'monthly' || key === 'monthlyPurchase') && values.every(Array.isArray)) {
      const flat = values.flat() as Record<string, unknown>[];
      // One company may lack a month the other has; keep the months in calendar order.
      out[key] = byLabelAsc(sumBy(flat, 'label', ['revenue', 'invoiceCount', 'uniqueCustomers', 'purchase']), 'label');
    } else if ((key === 'top5' || key === 'top5Suppliers') && values.every(Array.isArray)) {
      out[key] = values.flat();
    } else if (typeof values[0] === 'string' || typeof values[0] === 'boolean') {
      out[key] = values[0];
    }
  }
  for (const key of ['top5', 'top5Suppliers'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    const amountKey = key === 'top5' ? 'fyRevenue' : 'fyPurchase';
    const concKey = key === 'top5' ? 'top5ConcentrationPct' : 'top5SupplierConcentrationPct';
    const ranked = [...list].sort((a, b) => num(b[amountKey]) - num(a[amountKey])).slice(0, 5);
    // Share is "% of all FY sales (purchase)", as the server sends it for one
    // company — not "% of these five", which always adds to 100. Each company's
    // FY total = its own top-5 sum ÷ its top-5 concentration.
    const total = companyTotal(rows, key, amountKey, concKey);
    const topSum = ranked.reduce((sum, row) => sum + num(row[amountKey]), 0);
    out[key] = ranked.map((row) => ({
      ...row,
      sharePct: total ? Math.round((num(row[amountKey]) / total) * 1000) / 10 : 0,
    }));
    if (total) out[concKey] = Math.round((topSum / total) * 1000) / 10;
  }
  return out;
}

// ── Movements: newest first by the real date, never by the "24 Oct" label ──────

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Midnight IST (as epoch ms) of the IST day containing `ms`. */
function istDayStart(ms: number): number {
  return Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
}

/**
 * When a movement happened, as { day, at } epoch ms (0 = unknown).
 *
 * Uses the voucher date (`date`, yyyy-mm-dd) and entry time (`at`, ISO) when
 * the feed carries them. Older pushes only carry the display label — "24 Oct"
 * (no year) or "35 min ago" / "2 hr ago" — so that label is turned into a real
 * date first: the year is the latest one that does not put the day in the
 * future. The label itself is never compared as text.
 */
export function movementTime(row: Record<string, unknown>, now: number = Date.now()): { day: number; at: number } {
  const at = typeof row.at === 'string' ? Date.parse(row.at) || 0 : 0;
  if (typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.date)) {
    const day = Date.parse(`${row.date.slice(0, 10)}T00:00:00+05:30`);
    if (Number.isFinite(day)) return { day, at };
  }
  const label = String(row.when ?? '').trim().toLowerCase();
  const rel = /^(\d+)\s*(min|hr|hour)/.exec(label);
  if (rel) {
    const ms = now - Number(rel[1]) * (rel[2] === 'min' ? 60_000 : 3_600_000);
    return { day: istDayStart(ms), at: at || ms };
  }
  const m = /^(\d{1,2})\s+([a-z]{3})/.exec(label);
  if (m && MONTHS[m[2]] != null) {
    const todayIst = new Date(now + IST_MS);
    let year = todayIst.getUTCFullYear();
    let day = Date.UTC(year, MONTHS[m[2]], Number(m[1])) - IST_MS;
    if (day > istDayStart(now) + DAY_MS) { year -= 1; day = Date.UTC(year, MONTHS[m[2]], Number(m[1])) - IST_MS; }
    return { day, at };
  }
  return { day: 0, at };
}

/**
 * A chart label as a day (epoch ms) so merged series stay in calendar order:
 * "Oct 2026" (revenue trend), "Oct" (analytics months), "24 Oct" (weeks).
 * Year-less labels take the latest year that is not in the future.
 */
export function labelDay(label: unknown, now: number = Date.now()): number {
  const text = String(label ?? '').trim().toLowerCase();
  const monYear = /^([a-z]{3})\s+(\d{2}|\d{4})$/.exec(text);
  if (monYear && MONTHS[monYear[1]] != null) {
    const y = Number(monYear[2]);
    return Date.UTC(y < 100 ? 2000 + y : y, MONTHS[monYear[1]], 1) - IST_MS;
  }
  if (/^[a-z]{3}$/.test(text) && MONTHS[text] != null) return movementTime({ when: `01 ${text}` }, now).day;
  return movementTime({ when: text }, now).day;
}

function byLabelAsc<T extends Record<string, unknown>>(rows: T[], key: string): T[] {
  return rows.map((row, i) => ({ row, i, d: labelDay(row[key]) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(x => x.row);
}

/** Newest first; same day → latest entry first; otherwise the feed's own order. */
export function sortMovements<T extends object>(rows: T[], now: number = Date.now()): T[] {
  return rows
    .map((row, i) => ({ row, i, t: movementTime(row as Record<string, unknown>, now) }))
    .sort((a, b) => b.t.day - a.t.day || b.t.at - a.t.at || a.i - b.i)
    .map(x => x.row);
}

/** The company short a tagged name ends with ("Party · Chlorides" → "Chlorides"). */
function companyOfTagged(name: unknown): string | null {
  const m = / · ([^·]+)$/.exec(String(name ?? ''));
  return m ? m[1].trim() : null;
}

function tagRows(parts: CompanyPart[], nameKey: string): Record<string, unknown>[] {
  return parts.flatMap((part) => {
    if (!Array.isArray(part.data)) return [];
    return (part.data as Record<string, unknown>[]).map((row) => ({
      ...row,
      [nameKey]: tag(row[nameKey], part.code),
    }));
  });
}

// Raw PC split (kolkata / calcutta / shd by party name). NKG · Kolkata as one
// desk — the whole 0010 book plus NKG-named parties — is built in
// lib/salesDesks.ts (useSalesSites), which also needs each company's month total.
function mergeSites(parts: CompanyPart[]) {
  const desks = ['shd', 'kolkata'] as const;
  const out: Record<string, unknown> = {};
  for (const desk of desks) {
    const rows = parts
      .map((part) => {
        const block = (part.data as { shd?: Record<string, unknown>; kolkata?: Record<string, unknown> } | null)?.[desk];
        if (!block) return null;
        const top = Array.isArray(block.top)
          ? (block.top as Record<string, unknown>[]).map((row) => ({ ...row, name: tag(row.name, part.code) }))
          : [];
        return { ...block, top } as Record<string, unknown>;
      })
      .filter((row): row is Record<string, unknown> => row != null);
    const top = rows.flatMap((row) => (Array.isArray(row.top) ? row.top as Record<string, unknown>[] : []));
    top.sort((a, b) => num(b.salesMTD) - num(a.salesMTD));
    out[desk] = {
      site: desk,
      salesMTD: rows.reduce((sum, row) => sum + num(row.salesMTD), 0),
      invoiceCount: rows.reduce((sum, row) => sum + num(row.invoiceCount), 0),
      top: top.slice(0, 5),
    };
  }
  return out;
}

function mergeScan(parts: CompanyPart[]) {
  const scans = parts.filter((part) => part.data && typeof part.data === 'object') as { code: string; data: Record<string, unknown> }[];
  const findings = scans.flatMap((part) => {
    const list = Array.isArray(part.data.findings) ? part.data.findings as Record<string, unknown>[] : [];
    return list.map((finding): Record<string, unknown> => ({
      ...finding,
      id: `${part.code}:${finding.id}`,
      title: tag(finding.title, part.code),
    }));
  });
  const summary = { urgent: 0, warning: 0, info: 0, total: 0, levels: {} as Record<string, number> };
  for (const part of scans) {
    const s = (part.data.summary ?? {}) as Record<string, unknown>;
    summary.urgent += num(s.urgent);
    summary.warning += num(s.warning);
    summary.info += num(s.info);
    summary.total += num(s.total);
    const levels = (s.levels ?? {}) as Record<string, unknown>;
    for (const [level, count] of Object.entries(levels)) summary.levels[level] = num(summary.levels[level]) + num(count);
  }
  const kpiMap = new Map<string, Record<string, unknown>[]>();
  for (const part of scans) {
    const kpis = Array.isArray(part.data.kpis) ? part.data.kpis as Record<string, unknown>[] : [];
    for (const kpi of kpis) {
      const key = String(kpi.key ?? '');
      kpiMap.set(key, [...(kpiMap.get(key) ?? []), kpi]);
    }
  }
  const kpis = [...kpiMap.entries()].map(([, group]) => {
    const first = group[0];
    const raw = first.fmt === 'pct' ? weighted(group, 'raw') : group.reduce((sum, kpi) => sum + num(kpi.raw), 0);
    return { ...first, raw, value: first.fmt === 'pct' ? `${raw.toFixed(1)}%` : String(Math.round(raw)) };
  });
  // Rank like the server does for one company: extreme → mild, then score.
  // Glued per company, one company's mild findings sat above another's extreme.
  const LEVEL_RANK: Record<string, number> = { extreme: 0, heavy: 1, moderate: 2, mild: 3 };
  const rank = (f: Record<string, unknown>) => LEVEL_RANK[String(f.level ?? '')] ?? 4;
  findings.sort((a, b) => rank(a) - rank(b) || num(b.score) - num(a.score));
  return { ...(scans[0]?.data ?? {}), summary, kpis, findings };
}

function mergeAnalytics(parts: CompanyPart[]) {
  const rows = parts.map((part) => part.data).filter((data): data is Record<string, unknown> => !!data && typeof data === 'object');
  const first = rows[0] ?? {};
  const salesPurchase = byLabelAsc(sumBy(rows.flatMap((row) => Array.isArray(row.salesPurchase) ? row.salesPurchase as Record<string, unknown>[] : []), 'label', ['sales', 'purchase']), 'label');
  const cashflow = byLabelAsc(sumBy(rows.flatMap((row) => Array.isArray(row.cashflow) ? row.cashflow as Record<string, unknown>[] : []), 'label', ['receipts', 'payments', 'net']), 'label');
  const vendors: Record<string, unknown>[] = parts.flatMap((part) => {
    const list = (part.data as { vendors?: Record<string, unknown>[] } | null)?.vendors ?? [];
    return list.map((row): Record<string, unknown> => ({ ...row, name: tag(row.name, part.code) }));
  }).sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 8);
  const vendorTotal = vendors.reduce((sum, row) => sum + num(row.spend), 0);
  const debtors: Record<string, unknown>[] = parts.flatMap((part) => {
    const list = (part.data as { debtors?: Record<string, unknown>[] } | null)?.debtors ?? [];
    return list.map((row): Record<string, unknown> => ({ ...row, name: tag(row.name, part.code) }));
  }).sort((a, b) => num(b.outstanding) - num(a.outstanding)).slice(0, 8);
  // Weekly anomaly counts: every company's, added by week key (yyyy-mm-dd), in order.
  const timeline = sumBy(
    rows.flatMap((row) => Array.isArray(row.timeline) ? row.timeline as Record<string, unknown>[] : []),
    'key',
    ['mild', 'moderate', 'heavy', 'extreme', 'total'],
  ).sort((a, b) => String(a.key ?? '').localeCompare(String(b.key ?? '')));
  const margins = rows.map((row) => row.margin).filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  return {
    ...first,
    margin: margins.length ? sumRecord(margins) : first.margin,
    salesPurchase,
    cashflow,
    ...(timeline.length ? { timeline } : {}),
    vendors: vendors.map((row) => ({ ...row, sharePct: vendorTotal ? (num(row.spend) / vendorTotal) * 100 : 0 })),
    debtors,
  };
}

function mergeSeries(parts: CompanyPart[]) {
  const rows = parts.map((part) => part.data).filter((data): data is Record<string, unknown> => !!data && typeof data === 'object');
  const first = rows[0];
  if (!first) return null;
  const unit = (first.meta as { unit?: string } | undefined)?.unit;
  const points = sumBy(
    rows.flatMap((row) => Array.isArray(row.points) ? row.points as Record<string, unknown>[] : []),
    'period',
    unit === 'pct' ? [] : ['value', 'baseline', 'ewma', 'upper', 'lower'],
  );
  if (unit === 'pct') {
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of rows.flatMap((item) => Array.isArray(item.points) ? item.points as Record<string, unknown>[] : [])) {
      const period = String(row.period ?? '');
      grouped.set(period, [...(grouped.get(period) ?? []), row]);
    }
    return {
      ...first,
      points: [...grouped.entries()]
        .map(([period, group]) => ({ ...group[0], period, value: weighted(group, 'value') }))
        .sort((a, b) => a.period.localeCompare(b.period)),
    };
  }
  // period is an ISO key (2026-10-24 / 2026-10), so text order is time order.
  return { ...first, points: points.sort((a, b) => String(a.period ?? '').localeCompare(String(b.period ?? ''))) };
}

export function mergeCompanyPayloads(path: string, parts: CompanyPart[]): unknown {
  const ready = parts.filter((part) => part.data != null);
  if (!ready.length) return null;
  const q = path.indexOf('?');
  const pathname = q === -1 ? path : path.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : path.slice(q + 1));

  if (pathname === '/api/kpis/revenue-trend') {
    const months = sumBy(ready.flatMap((part) => Array.isArray(part.data) ? part.data as Record<string, unknown>[] : []), 'month', ['revenue', 'invoiceCount']);
    return byLabelAsc(months, 'month');
  }
  if (pathname === '/api/customers/top') {
    const limit = Number(params.get('limit') || 5);
    return tagRows(ready, 'name').sort((a, b) => num(b.mtdRevenue) - num(a.mtdRevenue)).slice(0, Number.isFinite(limit) ? limit : 5);
  }
  if (pathname === '/api/customers/outstanding') {
    return tagRows(ready, 'name').sort((a, b) => num(b.outstanding) - num(a.outstanding));
  }
  // Each company's list is ranked on its own; rank the combined list the same way.
  if (pathname === '/api/customers/list') return tagRows(ready, 'name').sort((a, b) => num(b.fyRevenue) - num(a.fyRevenue));
  if (pathname === '/api/sales/contracts') return tagRows(ready, 'customer').sort((a, b) => num(b.totalSales) - num(a.totalSales));
  if (pathname === '/api/sales/sites') return mergeSites(ready);
  if (pathname === '/api/movements/recent' || pathname === '/api/movements/today') {
    // Each company arrives as its own block; glued together they read 26, 24, 26.
    return sortMovements(tagRows(ready, 'title'));
  }
  if (pathname === '/api/purchases/recent') {
    return ready
      .flatMap((part) => Array.isArray(part.data) ? part.data as Record<string, unknown>[] : [])
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
      .slice(0, 80);
  }
  if (pathname === '/api/batches/recent') {
    // Manufacturing vouchers (VchType 5) per company: party tagged with the
    // company like other row merges, plus the company short for its column;
    // newest voucher date first.
    return tagRows(ready, 'party')
      .map((row, i) => ({ row, i, company: companyOfTagged(row.party) }))
      .sort((a, b) => String(b.row.date ?? '').localeCompare(String(a.row.date ?? '')) || a.i - b.i)
      .map(({ row, company }) => ({ ...row, company }));
  }
  if (pathname === '/api/anomaly/scan') return mergeScan(ready);
  if (pathname === '/api/anomaly/analytics') return mergeAnalytics(ready);
  if (pathname === '/api/anomaly/metrics') return ready[0].data;
  if (pathname === '/api/anomaly/timeseries') return mergeSeries(ready);
  if (ready.every((part) => part.data && typeof part.data === 'object' && !Array.isArray(part.data))) {
    return sumRecord(ready.map((part) => part.data as Record<string, unknown>));
  }
  return ready[0].data;
}
