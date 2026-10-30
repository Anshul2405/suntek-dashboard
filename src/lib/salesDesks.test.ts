import { describe, it, expect } from 'vitest';
import { buildSalesDesks, deskOfParty, deskOfSale, NKG_COMPANY } from './salesDesks';
import { BUSY_COMPANIES } from './busyCompanies';

const empty = { shd: { salesMTD: 0, invoiceCount: 0, top: [] }, kolkata: { salesMTD: 0, invoiceCount: 0, top: [] } };

describe('NKG · Kolkata is one sales desk (Sidak, 29 Oct 2026)', () => {
  it('still four Busy companies; NKG is 0010, no fifth company', () => {
    expect(BUSY_COMPANIES.map((c) => c.code)).toEqual(['0007', '0009', '0010', '0012']);
    expect(NKG_COMPANY).toBe('0010');
  });

  it('party "NKG Trading" → Kolkata desk, not dropped, not SHD', () => {
    expect(deskOfParty('NKG Trading')).toBe('kolkata');
    expect(deskOfSale('NKG Trading', '0007')).toBe('kolkata');
  });

  it('a "… Kolkata" party in Chlorides is still the Kolkata desk; Calcutta too', () => {
    expect(deskOfSale('Shreeram Chemicals (Kolkata)', '0007')).toBe('kolkata');
    expect(deskOfSale('Shiv Durga Calcutta', '0009')).toBe('kolkata');
  });

  it('company 0010 with a party that names neither Kolkata nor NKG → Kolkata desk', () => {
    expect(deskOfSale('Gupta Polymers', '0010')).toBe('kolkata');
  });

  it('SHD party unchanged; Kolkata in the name beats SHD; SHD is never NKG', () => {
    expect(deskOfSale('V. Plastic (Shd)', '0007')).toBe('shd');
    expect(deskOfSale('Kolkata Polymers (SHD)', '0007')).toBe('kolkata');
    expect(deskOfSale('Plain Party Ltd', '0007')).toBe(null);
  });

  it('picking NKG (0010) alone shows its whole book, not ₹0', () => {
    const d = buildSalesDesks([{ code: '0010', sites: empty, totalSalesMTD: 32245171, customers: [{ name: 'Gupta Polymers', mtdRevenue: 1000 }] }]);
    expect(d.kolkata.salesMTD).toBe(32245171);
    expect(d.kolkata.top[0]).toEqual({ name: 'Gupta Polymers', salesMTD: 1000 });
    expect(d.shd.salesMTD).toBe(0);
  });

  it('All companies: 0010 book + Chlorides Kolkata parties + NKG-named parties all on the desk', () => {
    const d = buildSalesDesks([
      {
        code: '0007',
        sites: {
          shd: { salesMTD: 31948249, invoiceCount: 157, top: [{ name: 'V. Plastic (Shd)', salesMTD: 5423149 }] },
          kolkata: { salesMTD: 296180, invoiceCount: 1, top: [{ name: 'Shreeram Chemicals (Kolkata)', salesMTD: 296180 }] },
        },
        totalSalesMTD: 358439557.91,
        customers: [
          { name: 'NKG Plastochem Pvt Ltd (Howrah)', mtdRevenue: 29363651 },
          { name: 'Shreeram Chemicals (Kolkata)', mtdRevenue: 296180 },
        ],
      },
      { code: '0010', sites: empty, totalSalesMTD: 32245171, customers: [] },
      { code: '0009', sites: empty, totalSalesMTD: 82398377, customers: [] },
    ]);
    // 296,180 (Chlorides Kolkata, from the PC) + 29,363,651 (NKG-named) + 32,245,171 (0010 book)
    expect(d.kolkata.salesMTD).toBe(296180 + 29363651 + 32245171);
    // A Kolkata-named party already counted by the PC is not counted twice.
    expect(d.kolkata.top.filter((r) => r.name.startsWith('Shreeram'))).toHaveLength(1);
    expect(d.kolkata.top.map((r) => r.name)).toContain('NKG Plastochem Pvt Ltd (Howrah) · Chlorides');
    // Part of the figure has no invoice count in the feed → shown as unknown, not wrong.
    expect(d.kolkata.invoiceCount).toBe(null);
    // SHD unchanged.
    expect(d.shd.salesMTD).toBe(31948249);
    expect(d.shd.invoiceCount).toBe(157);
  });

  it('an NKG-named party the PC put on SHD moves to Kolkata (not counted twice)', () => {
    const d = buildSalesDesks([{
      code: '0012',
      sites: { shd: { salesMTD: 500, invoiceCount: 2, top: [{ name: 'NKG Depot SHD', salesMTD: 200 }, { name: 'X (shd)', salesMTD: 300 }] }, kolkata: { salesMTD: 0, invoiceCount: 0, top: [] } },
      totalSalesMTD: 500,
      customers: [{ name: 'NKG Depot SHD', mtdRevenue: 200 }],
    }]);
    expect(d.kolkata.salesMTD).toBe(200);
    expect(d.shd.salesMTD).toBe(300);
    expect(d.shd.top.map((r) => r.name)).toEqual(['X (shd)']);
  });

  it('an empty NKG book does not break the merge', () => {
    const d = buildSalesDesks([{ code: '0010', sites: empty, totalSalesMTD: 0, customers: [] }, { code: '0007', sites: null, totalSalesMTD: null, customers: null }]);
    expect(d.kolkata.salesMTD).toBe(0);
    expect(d.shd.salesMTD).toBe(0);
  });

  it('no feed total for 0010 falls back to the PC split (nothing dropped)', () => {
    const d = buildSalesDesks([{ code: '0010', sites: { shd: { salesMTD: 10, invoiceCount: 1 }, kolkata: { salesMTD: 5, invoiceCount: 1 } }, totalSalesMTD: null }]);
    expect(d.kolkata.salesMTD).toBe(15);
    expect(d.kolkata.invoiceCount).toBe(2);
  });
});
