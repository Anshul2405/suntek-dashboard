// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mergeCompanyPayloads, movementTime, sortMovements } from './busyMerge';

describe('mergeCompanyPayloads', () => {
  it('adds sales across companies and keeps a margin as a weighted rate', () => {
    const merged = mergeCompanyPayloads('/api/kpis/overview', [
      { code: '0007', data: { salesMTD: 100, fyRevenue: 100, grossMarginPct: 10 } },
      { code: '0009', data: { salesMTD: 50, fyRevenue: 300, grossMarginPct: 30 } },
    ]) as { salesMTD: number; grossMarginPct: number };

    expect(merged.salesMTD).toBe(150);
    expect(merged.grossMarginPct).toBe(25);
  });

  it('rounds a combined rate so the overview does not print a long decimal', () => {
    const merged = mergeCompanyPayloads('/api/analytics/kpis', [
      { code: '0007', data: { grossMarginPct: 27.1, purchaseToCostPct: 72.9, dso: 49.3, debtorTurnover: 7.41, dpo: 47.3, cashConversionCycle: 2 } },
      { code: '0009', data: { grossMarginPct: 28.3, purchaseToCostPct: 71.7, dso: 60.3, debtorTurnover: 6.05, dpo: 73.1, cashConversionCycle: -12.8 } },
      { code: '0010', data: { grossMarginPct: -12.1, purchaseToCostPct: 112.1, dso: 32.6, debtorTurnover: 11.19, dpo: 3.4, cashConversionCycle: 29.2 } },
      { code: '0012', data: { grossMarginPct: 18.6, purchaseToCostPct: 81.4, dso: 16.2, debtorTurnover: 22.48, dpo: 13, cashConversionCycle: 3.3 } },
    ]) as { grossMarginPct: number; dso: number; debtorTurnover: number; dpo: number; cashConversionCycle: number };

    expect(merged.grossMarginPct).toBe(15.5);
    expect(merged.dso).toBe(39.6);
    expect(merged.debtorTurnover).toBe(11.78);
    expect(merged.dpo).toBe(34.2);
    expect(merged.cashConversionCycle).toBe(5.4);
  });

  it('keeps purchase invoices from every company, newest first', () => {
    const merged = mergeCompanyPayloads('/api/purchases/recent', [
      { code: '0007', data: [{ date: '2026-10-01', invoice: 'A', amount: 10 }] },
      { code: '0012', data: [{ date: '2026-10-12', invoice: 'B', amount: 20 }] },
    ]) as { invoice: string }[];

    expect(merged.map((row) => row.invoice)).toEqual(['B', 'A']);
  });

  it('labels a customer with the company and ranks the combined list', () => {
    const merged = mergeCompanyPayloads('/api/customers/top?limit=2', [
      { code: '0007', data: [{ name: 'A', mtdRevenue: 10 }] },
      { code: '0012', data: [{ name: 'A', mtdRevenue: 40 }, { name: 'B', mtdRevenue: 5 }] },
    ]) as { name: string; mtdRevenue: number }[];

    expect(merged.map((row) => row.name)).toEqual(['A · Madan', 'A · Chlorides']);
  });

  it('adds the same month from each company', () => {
    const merged = mergeCompanyPayloads('/api/kpis/revenue-trend', [
      { code: '0007', data: [{ month: 'Oct', revenue: 10, invoiceCount: 1 }] },
      { code: '0009', data: [{ month: 'Oct', revenue: 4, invoiceCount: 2 }] },
    ]) as { month: string; revenue: number; invoiceCount: number }[];

    expect(merged).toEqual([{ month: 'Oct', revenue: 14, invoiceCount: 3 }]);
  });

  it('merges movements from two companies newest first (26 Oct above 24 Oct)', () => {
    const now = Date.parse('2026-10-27T06:00:00Z');
    const mv = (title: string, when: string) => ({ type: 'sales', title, sub: 'V1', amt: '+₹1', col: '#000', when });
    const merged = mergeCompanyPayloads('/api/movements/recent?days=3', [
      { code: '0007', data: [mv('Sales Invoice · A', '26 Oct'), mv('Sales Invoice · B', '24 Oct')] },
      { code: '0009', data: [mv('Sales Invoice · C', '26 Oct'), mv('Sales Invoice · D', '25 Oct')] },
    ]) as { title: string; when: string }[];
    expect(sortMovements(merged, now).map(m => m.when)).toEqual(['26 Oct', '26 Oct', '25 Oct', '24 Oct']);
    // The plain merge (real clock) keeps the same order.
    expect(merged.map(m => m.when)).toEqual(['26 Oct', '26 Oct', '25 Oct', '24 Oct']);
  });

  it('sorts on the voucher date and entry time when the feed sends them', () => {
    const rows = [
      { when: '24 Oct', date: '2026-10-24', at: '2026-10-26T10:00:00Z' },
      { when: '26 Oct', date: '2026-10-26', at: '2026-10-26T04:00:00Z' },
      { when: '26 Oct', date: '2026-10-26', at: '2026-10-26T09:00:00Z' },
    ];
    expect(sortMovements(rows).map(r => r.at)).toEqual(['2026-10-26T09:00:00Z', '2026-10-26T04:00:00Z', '2026-10-26T10:00:00Z']);
  });

  it('reads a label year-less date as the latest one not in the future', () => {
    const jan = Date.parse('2027-01-03T06:00:00Z');
    const dec = movementTime({ when: '30 Dec' }, jan).day;
    const jan2 = movementTime({ when: '02 Jan' }, jan).day;
    expect(new Date(dec + 5.5 * 3600_000).toISOString().slice(0, 10)).toBe('2026-12-30');
    expect(jan2).toBeGreaterThan(dec);
    expect(movementTime({ when: '35 min ago' }, jan).day).toBeGreaterThanOrEqual(jan2);
  });
});

describe('merged Busy lists keep a real order', () => {
  it('ranks the combined customer list and contracts, not company by company', () => {
    const list = mergeCompanyPayloads('/api/customers/list', [
      { code: '0007', data: [{ name: 'A', fyRevenue: 50 }, { name: 'B', fyRevenue: 10 }] },
      { code: '0009', data: [{ name: 'C', fyRevenue: 30 }] },
    ]) as { fyRevenue: number }[];
    expect(list.map(r => r.fyRevenue)).toEqual([50, 30, 10]);
    const contracts = mergeCompanyPayloads('/api/sales/contracts', [
      { code: '0007', data: [{ customer: 'A', totalSales: 5 }] },
      { code: '0009', data: [{ customer: 'C', totalSales: 9 }] },
    ]) as { totalSales: number }[];
    expect(contracts.map(r => r.totalSales)).toEqual([9, 5]);
  });

  it('keeps months in calendar order when one company lacks a month', () => {
    const trend = mergeCompanyPayloads('/api/kpis/revenue-trend', [
      { code: '0007', data: [{ month: 'Sep 2026', revenue: 1 }, { month: 'Oct 2026', revenue: 1 }] },
      { code: '0009', data: [{ month: 'Aug 2026', revenue: 1 }, { month: 'Sep 2026', revenue: 1 }] },
    ]) as { month: string }[];
    expect(trend.map(r => r.month)).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026']);
  });

  it('orders a merged series by its period', () => {
    const series = mergeCompanyPayloads('/api/anomaly/timeseries', [
      { code: '0007', data: { meta: { unit: 'inr' }, points: [{ period: '2026-10-20', value: 1 }] } },
      { code: '0009', data: { meta: { unit: 'inr' }, points: [{ period: '2026-10-13', value: 2 }, { period: '2026-10-20', value: 3 }] } },
    ]) as { points: { period: string; value: number }[] };
    expect(series.points.map(p => [p.period, p.value])).toEqual([['2026-10-13', 2], ['2026-10-20', 4]]);
  });
});

describe('combined top-5 shares', () => {
  it('shares are of all FY sales, not of the five shown', () => {
    // Company A: FY 1000, top customer 300 (30%). Company B: FY 1000, top 100 (10%).
    const merged = mergeCompanyPayloads('/api/analytics/kpis', [
      { code: '0007', data: { top5ConcentrationPct: 30, top5: [{ name: 'A1', fyRevenue: 300, sharePct: 30 }] } },
      { code: '0009', data: { top5ConcentrationPct: 10, top5: [{ name: 'B1', fyRevenue: 100, sharePct: 10 }] } },
    ]) as { top5: { sharePct: number }[]; top5ConcentrationPct: number };
    expect(merged.top5.map(r => r.sharePct)).toEqual([15, 5]);
    expect(merged.top5ConcentrationPct).toBe(20);
  });
});

describe('combined ratios', () => {
  it('weights a rate by each company’s FY sales when the payload only has top-5', () => {
    const merged = mergeCompanyPayloads('/api/analytics/kpis', [
      { code: '0007', data: { grossMarginPct: 20, top5ConcentrationPct: 10, top5: [{ name: 'A', fyRevenue: 90 }] } },  // FY 900
      { code: '0010', data: { grossMarginPct: -10, top5ConcentrationPct: 50, top5: [{ name: 'B', fyRevenue: 50 }] } }, // FY 100
    ]) as { grossMarginPct: number };
    expect(merged.grossMarginPct).toBe(17); // (20×900 − 10×100) / 1000, not the plain average 5
  });
});

describe('merged anomaly feeds', () => {
  it('ranks findings across companies by level then score', () => {
    const scan = mergeCompanyPayloads('/api/anomaly/scan', [
      { code: '0007', data: { findings: [{ id: 'a', title: 'A', level: 'mild', score: 0.9 }] } },
      { code: '0009', data: { findings: [{ id: 'b', title: 'B', level: 'extreme', score: 0.5 }, { id: 'c', title: 'C', level: 'extreme', score: 0.8 }] } },
    ]) as { findings: { id: string }[] };
    expect(scan.findings.map(f => f.id)).toEqual(['0009:c', '0009:b', '0007:a']);
  });

  it('adds every company’s weekly anomaly timeline', () => {
    const a = mergeCompanyPayloads('/api/anomaly/analytics', [
      { code: '0007', data: { timeline: [{ key: '2026-10-19', label: '19 Oct', mild: 1, moderate: 0, heavy: 0, extreme: 0, total: 1 }] } },
      { code: '0009', data: { timeline: [{ key: '2026-10-12', label: '12 Oct', mild: 0, moderate: 2, heavy: 0, extreme: 0, total: 2 }, { key: '2026-10-19', label: '19 Oct', mild: 1, moderate: 0, heavy: 0, extreme: 1, total: 2 }] } },
    ]) as { timeline: { key: string; total: number }[] };
    expect(a.timeline.map(t => [t.key, t.total])).toEqual([['2026-10-12', 2], ['2026-10-19', 3]]);
  });
});
