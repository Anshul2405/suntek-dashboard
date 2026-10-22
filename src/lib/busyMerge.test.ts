// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mergeCompanyPayloads } from './busyMerge';

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
});
