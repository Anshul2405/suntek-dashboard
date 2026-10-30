/**
 * Sales desks: NKG · Kolkata and SHD (read only, from the last Busy read).
 *
 * Sidak, 29 Oct 2026: "NKG and kolkata are same — we have our sales branch in
 * kolkata, referred to as NKG". One branch, one desk. It is not a fifth Busy
 * company: the four books stay 0007 Chlorides, 0009 Plasticizer, 0010 NKG
 * Plastochem, 0012 Madan. The internal key stays `kolkata` (rights, ?tab=kolkata).
 *
 * A sale is on the NKG · Kolkata desk if ANY of:
 *   - the party name has kolkata / calcutta / nkg (any case), or
 *   - the Busy company is 0010 — the whole NKG Plastochem book is that branch.
 * SHD = party name has shd, unless it is already Kolkata/NKG (Kolkata wins).
 *
 * The Busy PC reader (server/lib/busySql.js, SITE_CASE — not in this repo)
 * still splits only on kolkata / calcutta / shd and knows nothing of 0010. Until
 * Mukesh updates it to the same rule, this module rebuilds the desk from what the
 * feed already carries: the PC's site figures, the 0010 month total, and
 * NKG-named parties from each company's customer list. Nothing is written to Busy.
 */
import { BUSY_COMPANIES } from './busyCompanies';

export type SalesDesk = 'kolkata' | 'shd';
/** The NKG Plastochem book — every sale in it is the NKG · Kolkata desk. */
export const NKG_COMPANY = '0010';

const KOLKATA_NAME = /kolkata|calcutta|\bnkg/i;
/** What the PC reader already counts as Kolkata (its SITE_CASE). */
const PC_KOLKATA_NAME = /kolkata|calcutta/i;
const SHD_NAME = /shd/i;

/** Desk from the party name alone (Kolkata / Calcutta / NKG beat SHD). */
export function deskOfParty(name: string | null | undefined): SalesDesk | null {
  const n = name || '';
  if (KOLKATA_NAME.test(n)) return 'kolkata';
  if (SHD_NAME.test(n)) return 'shd';
  return null;
}

/** Desk of one sale: the NKG book is all Kolkata; otherwise by party name. */
export function deskOfSale(party: string | null | undefined, company: string | null | undefined): SalesDesk | null {
  if (company === NKG_COMPANY) return 'kolkata';
  return deskOfParty(party);
}

export interface DeskBlock { site?: string; salesMTD?: number; invoiceCount?: number; top?: { name: string; salesMTD: number }[] }
export interface CompanyDeskInput {
  code: string;
  /** /api/sales/sites for this company (the PC's split). */
  sites?: { shd?: DeskBlock; kolkata?: DeskBlock } | null;
  /** /api/sales/mtd totalSalesMTD for this company. */
  totalSalesMTD?: number | null;
  /** /api/customers/list for this company (name + mtdRevenue). */
  customers?: { name: string; mtdRevenue?: number | null }[] | null;
}
export interface DeskSummary {
  site: SalesDesk;
  salesMTD: number;
  /** Null when part of the figure has no invoice count in the feed. */
  invoiceCount: number | null;
  top: { name: string; salesMTD: number }[];
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const short = (code: string) => BUSY_COMPANIES.find((c) => c.code === code)?.short ?? code;

export function buildSalesDesks(parts: CompanyDeskInput[]): Record<SalesDesk, DeskSummary> {
  const many = parts.length > 1;
  const label = (name: string, code: string) => (many ? `${name} · ${short(code)}` : name);
  const desk = (site: SalesDesk): DeskSummary => ({ site, salesMTD: 0, invoiceCount: 0, top: [] });
  const out = { kolkata: desk('kolkata'), shd: desk('shd') };
  const addCount = (d: DeskSummary, c: number | null) => {
    d.invoiceCount = d.invoiceCount == null || c == null ? null : d.invoiceCount + c;
  };

  for (const p of parts) {
    if (p.code === NKG_COMPANY) {
      // The whole NKG Plastochem book: its month total. If the total is missing,
      // fall back to what the PC split (both desks) so nothing drops out.
      const whole = p.totalSalesMTD != null ? n(p.totalSalesMTD)
        : n(p.sites?.kolkata?.salesMTD) + n(p.sites?.shd?.salesMTD);
      out.kolkata.salesMTD += whole;
      addCount(out.kolkata, p.totalSalesMTD != null ? null : n(p.sites?.kolkata?.invoiceCount) + n(p.sites?.shd?.invoiceCount));
      for (const c of p.customers || []) {
        if (n(c.mtdRevenue) > 0) out.kolkata.top.push({ name: label(c.name, p.code), salesMTD: n(c.mtdRevenue) });
      }
      continue;
    }
    // Other books: the PC's Kolkata (kolkata / calcutta) …
    out.kolkata.salesMTD += n(p.sites?.kolkata?.salesMTD);
    addCount(out.kolkata, n(p.sites?.kolkata?.invoiceCount));
    for (const r of p.sites?.kolkata?.top || []) out.kolkata.top.push({ name: label(r.name, p.code), salesMTD: n(r.salesMTD) });
    // … plus NKG-named parties the PC did not count (e.g. "NKG Plastochem Pvt Ltd (Howrah)").
    let movedFromShd = 0;
    for (const c of p.customers || []) {
      if (deskOfParty(c.name) !== 'kolkata' || PC_KOLKATA_NAME.test(c.name)) continue;
      const amt = n(c.mtdRevenue);
      if (amt <= 0) continue;
      out.kolkata.salesMTD += amt;
      addCount(out.kolkata, null);
      out.kolkata.top.push({ name: label(c.name, p.code), salesMTD: amt });
      if (SHD_NAME.test(c.name)) movedFromShd += amt; // the PC had put it on SHD
    }
    // SHD as the PC split it, less any NKG-named party it had there.
    out.shd.salesMTD += Math.max(0, n(p.sites?.shd?.salesMTD) - movedFromShd);
    addCount(out.shd, movedFromShd ? null : n(p.sites?.shd?.invoiceCount));
    for (const r of p.sites?.shd?.top || []) {
      if (deskOfParty(r.name) === 'shd') out.shd.top.push({ name: label(r.name, p.code), salesMTD: n(r.salesMTD) });
    }
  }
  for (const d of [out.kolkata, out.shd]) {
    d.top.sort((a, b) => b.salesMTD - a.salesMTD);
    d.top = d.top.slice(0, 5);
  }
  return out;
}
