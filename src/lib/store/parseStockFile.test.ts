import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  resolveClosing, reconcile, reconcileAll, labelForPeriod, parseStockFile, normalizeUnit,
  type MonthParse, type MonthItem,
} from './parseStockFile';

/**
 * The register was seeding from `opening + purchased − used`, which double-counts
 * whenever the Sales and Purchase sheets describe the SAME physical stock from
 * different angles. Verbatim from the client's workbook, July 2026:
 *
 *   3.5 SUT (7/16") 2" LENGTH
 *     Sales     Op Stock 50, no issues,       Closing 50
 *     Purchase  Opening   0, 50 bought day 7, Closing 50
 *
 * Both sheets agree the month ends at 50 — the same 50 units. The formula said
 * 100, and 44 of 515 items were inflated that way (2,010 units overstated).
 */
describe('resolveClosing — never sums the same stock twice', () => {
  it('uses the sheet\'s stated closing instead of re-deriving it', () => {
    // opening 50, purchased 50, used 0 → the old formula gave 100.
    expect(resolveClosing(50, 50, 50, 0)).toBe(50);
  });

  it('honours a stated closing of ZERO rather than falling back', () => {
    // 0 is a real balance, not "missing". Falling through here would resurrect
    // stock the sheet says is gone.
    expect(resolveClosing(0, 10, 0, 10)).toBe(0);
    expect(resolveClosing(0, 99, 99, 0)).toBe(0);
  });

  it('honours a stated negative closing', () => {
    // The sheet claiming below-zero is a bookkeeping error worth surfacing,
    // not something to silently recompute away.
    expect(resolveClosing(-1, 0, 0, 1)).toBe(-1);
  });

  it('falls back to opening + purchased − used when no closing is stated', () => {
    expect(resolveClosing(null, 10, 5, 3)).toBe(12);
    expect(resolveClosing(undefined, 10, 5, 3)).toBe(12);
  });

  it('falls back when the stated closing is not a finite number', () => {
    expect(resolveClosing(NaN, 7, 2, 1)).toBe(8);
    expect(resolveClosing(Infinity, 7, 2, 1)).toBe(8);
  });

  it('agrees with the formula when the sheets are consistent', () => {
    // Nothing purchased, 3 issued from 10 → both routes give 7.
    expect(resolveClosing(7, 10, 0, 3)).toBe(7);
  });
});

// ── The reconciliation rule, confirmed by the client ─────────────────────────
//   Sales "Op Stock"  ==  Purchase "Closing"   (same month, no offset)
const item = (o: Partial<MonthItem>): MonthItem => ({
  itemName: 'Widget', key: 'widget', unit: 'Pcs', equipment: '', model: null,
  opening: 0, purchaseOpening: 0, purchaseClosing: 0, purchased: 0, used: 0, closing: 0, ...o,
});
/** `periodKey` defaults to July 2026 so the single-month tests read unchanged;
 *  pass one (e.g. '2026-06') when a test needs two DISTINCT months. */
const month = (items: MonthItem[], periodKey = '2026-07'): MonthParse => ({
  periodKey, periodMonth: `${periodKey}-01`, label: labelForPeriod(`${periodKey}-01`),
  items, hasSales: true, hasPurchase: true,
});

describe('reconcile — Sales opening vs Purchase closing, same month', () => {
  it('is silent when the two sheets agree', () => {
    // Purchase: 0 + 50 received = 50 available. Sales carries 50 across.
    const a = reconcile(null, month([item({ opening: 50, purchaseOpening: 0, purchaseClosing: 50, purchased: 50, closing: 50 })]));
    expect(a.filter(x => x.type === 'intra_month')).toHaveLength(0);
  });

  it('flags a genuine disagreement and states both sides', () => {
    const a = reconcile(null, month([item({ opening: 49, purchaseClosing: 50, closing: 49 })]));
    const m = a.find(x => x.type === 'intra_month');
    expect(m).toBeDefined();
    expect(m!.detail).toContain('49');
    expect(m!.detail).toContain('50');
    expect(m!.delta).toBe(-1);
  });

  it('does NOT fire merely because stock was purchased', () => {
    // The old rule compared Sales opening to Purchase OPENING, so every item
    // bought during the month looked like an anomaly. 76+25 false positives.
    const a = reconcile(null, month([item({ opening: 14, purchaseOpening: 2, purchaseClosing: 14, purchased: 12, used: 1, closing: 13 })]));
    expect(a.filter(x => x.type === 'intra_month')).toHaveLength(0);
  });

  it('is independent of the cross-month check', () => {
    // Same-month reconciliation passes even when the month boundary does not:
    // the two are separate hand-offs and must be reported separately.
    const prev = month([item({ closing: 999 })]);
    const a = reconcile(prev, month([item({ opening: 5, purchaseOpening: 5, purchaseClosing: 5, closing: 5 })]));
    expect(a.some(x => x.type === 'intra_month')).toBe(false);   // sheets agree
    expect(a.some(x => x.type === 'carry_forward')).toBe(true);  // boundary does not
  });

  it('still reports an impossible closing', () => {
    const a = reconcile(null, month([item({ opening: 0, purchaseClosing: 0, used: 1, closing: -1 })]));
    expect(a.find(x => x.type === 'negative')).toBeDefined();
  });
});

describe('carry_forward — only when a previous month exists', () => {
  it('is SKIPPED when the workbook holds a single month', () => {
    // A file with only the latest month has nothing to hand over from. The
    // check must be skipped, not compared against zero — otherwise every item
    // in a one-month upload looks like stock appeared from nowhere.
    const a = reconcile(null, month([item({ opening: 20, purchaseOpening: 20, purchaseClosing: 20, closing: 20 })]));
    expect(a.some(x => x.type === 'carry_forward')).toBe(false);
    expect(a).toHaveLength(0);
  });

  it('is skipped for an item that is new this month', () => {
    const prev = month([item({ itemName: 'Old', key: 'old', closing: 5 })]);
    const a = reconcile(prev, month([item({ itemName: 'New', key: 'new', opening: 7, purchaseOpening: 7, purchaseClosing: 7, closing: 7 })]));
    expect(a.some(x => x.type === 'carry_forward')).toBe(false);
  });

  it('compares last month closing to this month PURCHASE opening', () => {
    const prev = month([item({ closing: 24 })]);
    const a = reconcile(prev, month([item({ opening: 151, purchaseOpening: 151, purchaseClosing: 151, closing: 151 })]));
    const cf = a.find(x => x.type === 'carry_forward');
    expect(cf).toBeDefined();
    expect(cf!.delta).toBe(127);          // Coupling 100: closed 24, reopened 151
    expect(cf!.severity).toBe('high');
  });

  it('does not fire when stock carries across cleanly', () => {
    // A genuinely clean previous month has BOTH books closing at 30. Leaving
    // purchaseClosing at its default 0 would make the prior month internally
    // inconsistent, which is a different scenario (and correctly raises a
    // purchase_carry of its own — see the purchase_carry suite below).
    const prev = month([item({ opening: 30, purchaseOpening: 30, purchaseClosing: 30, closing: 30 })], '2026-06');
    // 30 carried in, 5 received -> 35 available, 35 copied to sales opening.
    const a = reconcile(prev, month([item({ opening: 35, purchaseOpening: 30, purchased: 5, purchaseClosing: 35, used: 0, closing: 35 })]));
    expect(a).toHaveLength(0);
  });
});

describe('sheet_self — a sheet contradicting its own arithmetic', () => {
  it('catches a hand-typed closing that BOTH books then agree on', () => {
    // Real row: Acid Pump (NZRP50200TBGV1J) Impeller O Ring.
    // 14 opening + 0 received = 14, but the purchase sheet states 20 — and the
    // sales sheet was copied from it, so intra_month stays silent.
    const a = reconcile(null, month([item({
      opening: 20, purchaseOpening: 14, purchased: 0, purchaseClosing: 20, used: 0, closing: 20,
    })]));
    expect(a.some(x => x.type === 'intra_month')).toBe(false);   // the books agree…
    const self = a.find(x => x.type === 'sheet_self');           // …but the maths does not
    expect(self).toBeDefined();
    expect(self!.detail).toContain('14');
    expect(self!.detail).toContain('20');
  });

  it('is silent when both sheets add up', () => {
    // 30 opening + 5 received = 35 available; 35 − 2 issued = 33 closing.
    const a = reconcile(null, month([item({
      opening: 35, purchaseOpening: 30, purchased: 5, purchaseClosing: 35, used: 2, closing: 33,
    })]));
    expect(a).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The client's reported case, verbatim from "Store Keeping 26-27 Jharkhand.xlsx"
// ═══════════════════════════════════════════════════════════════════════════
// Item: Acid Pump ( EXP 50CT)  Bello
//   May  — Sales 31 → 31        Purchase 31 → 31
//   June — Sales 29 → 29        Purchase  7 +24 → 31
//   July — Sales 29 → 27        Purchase 29 → 29
//
// The bug report claimed the engine compared June's purchase opening (7) against
// July. It did not: 31 vs 7 was the MAY→JUNE pair, correct for the months it
// actually compared but unreadable because the message named neither month.
const BELLO = 'Acid Pump ( EXP 50CT)  Bello';
const bello = (o: Partial<MonthItem>) => item({ itemName: BELLO, key: 'acid pump  exp 50ct bello', ...o });
const MAY  = month([bello({ opening: 31, purchaseOpening: 31, purchaseClosing: 31, purchased: 0, used: 0, closing: 31 })], '2026-05');
const JUNE = month([bello({ opening: 29, purchaseOpening: 7,  purchaseClosing: 31, purchased: 24, used: 0, closing: 29 })], '2026-06');
const JULY = month([bello({ opening: 29, purchaseOpening: 29, purchaseClosing: 29, purchased: 0, used: 2, closing: 27 })], '2026-07');

describe("client case — Acid Pump ( EXP 50CT)  Bello", () => {
  it('never uses June\'s opening (7) as July\'s opening', () => {
    for (const a of reconcile(JUNE, JULY)) {
      expect(a.curr).not.toBe(7);
      expect(a.detail).not.toContain('opened at 7');
    }
  });

  it('reports June→July as a 2-unit purchase carry, not 24', () => {
    const a = reconcile(JUNE, JULY).filter(x => x.type === 'purchase_carry');
    expect(a).toHaveLength(1);
    expect(a[0].prev).toBe(31);
    expect(a[0].curr).toBe(29);
    expect(a[0].delta).toBe(-2);
    // The client asked for this wording specifically.
    expect(a[0].detail).toBe(
      'Jun 2026 Purchase Register closed at 31, but Jul 2026 Purchase Register opened at 29. Difference: 2 units short.',
    );
  });

  it('passes check 1 — June Sales closing 29 matches July Purchase opening 29', () => {
    expect(reconcile(JUNE, JULY).filter(x => x.type === 'carry_forward')).toHaveLength(0);
  });

  it('passes check 2 — July Purchase closing 29 matches July Sales opening 29', () => {
    expect(reconcile(JUNE, JULY).filter(x => x.type === 'intra_month')).toHaveLength(0);
  });

  it('attributes the 24-unit gap to MAY→JUNE and names both months', () => {
    const a = reconcile(MAY, JUNE).filter(x => x.type === 'carry_forward');
    expect(a).toHaveLength(1);
    expect(a[0].delta).toBe(-24);
    expect(a[0].prevPeriod).toBe('2026-05');
    expect(a[0].currPeriod).toBe('2026-06');
    expect(a[0].detail).toContain('May 2026');
    expect(a[0].detail).toContain('Jun 2026');
  });

  it('still reports June\'s own 2-unit internal disagreement', () => {
    const a = reconcile(MAY, JUNE).filter(x => x.type === 'intra_month');
    expect(a).toHaveLength(1);
    expect(a[0].delta).toBe(-2);
  });

  it('keeps June\'s discrepancies visible once July is uploaded', () => {
    // The substantive bug: reconcile() only ever saw the newest pair, so
    // uploading July silently erased June's findings.
    const all = reconcileAll([MAY, JUNE, JULY]);
    const june = all.filter(d => d.periodKey === '2026-06').map(d => d.anomaly.type);
    expect(june).toContain('carry_forward');   // the 24
    expect(june).toContain('intra_month');     // the 2
    const july = all.filter(d => d.periodKey === '2026-07').map(d => d.anomaly.type);
    expect(july).toContain('purchase_carry');  // the client's check 3
  });
});

describe('reconcileAll — nothing is dropped, order does not matter', () => {
  it('files each anomaly under the LATER month of its pair', () => {
    for (const d of reconcileAll([MAY, JUNE, JULY])) {
      if (d.anomaly.currPeriod) expect(d.periodKey).toBe(d.anomaly.currPeriod);
    }
  });

  it('is identical whatever order the months arrive in', () => {
    const norm = (ms: MonthParse[]) => reconcileAll(ms)
      .map(d => `${d.periodKey}|${d.anomaly.type}|${d.anomaly.item}|${d.anomaly.delta}`).sort();
    expect(norm([JULY, MAY, JUNE])).toEqual(norm([MAY, JUNE, JULY]));
    expect(norm([JUNE, JULY, MAY])).toEqual(norm([MAY, JUNE, JULY]));
  });

  it('reconciles a single month without a previous one', () => {
    expect(() => reconcileAll([JULY])).not.toThrow();
    expect(reconcileAll([JULY]).every(d => d.periodKey === '2026-07')).toBe(true);
  });

  it('handles an empty workbook', () => {
    expect(reconcileAll([])).toEqual([]);
  });
});

describe('year rollover — December to January', () => {
  const DEC = month([item({ opening: 10, purchaseOpening: 10, purchaseClosing: 10, closing: 10 })], '2026-12');
  const JAN = month([item({ opening: 4, purchaseOpening: 4, purchaseClosing: 4, closing: 4 })], '2027-01');

  it('compares Dec 2026 against Jan 2027, not Jan 2026', () => {
    const a = reconcile(DEC, JAN).filter(x => x.type === 'carry_forward');
    expect(a).toHaveLength(1);
    expect(a[0].prevPeriod).toBe('2026-12');
    expect(a[0].currPeriod).toBe('2027-01');
    // Both years are stated, so the pair cannot be misread as same-year.
    expect(a[0].detail).toContain('Dec 2026');
    expect(a[0].detail).toContain('Jan 2027');
  });

  it('orders across the year boundary correctly', () => {
    const all = reconcileAll([JAN, DEC]);
    expect(all.filter(d => d.anomaly.type === 'carry_forward')[0].periodKey).toBe('2027-01');
  });

  it('labels every month with its year', () => {
    expect(labelForPeriod('2026-12-01')).toBe('Dec 2026');
    expect(labelForPeriod('2027-01-01')).toBe('Jan 2027');
  });
});

describe('purchase_carry — only when it says something new', () => {
  it('fires when the previous month\'s two books disagree', () => {
    const a = reconcile(JUNE, JULY).filter(x => x.type === 'purchase_carry');
    expect(a).toHaveLength(1);
  });

  it('stays silent when both books agree, so nothing is double-counted', () => {
    // Prev closes at 30 on BOTH books; next opens at 25. carry_forward reports
    // the 5 — purchase_carry would report the identical 5 against the identical
    // number, which reads as two separate discrepancies.
    const prev = month([item({ opening: 30, purchaseOpening: 30, purchaseClosing: 30, closing: 30 })], '2026-06');
    const next = month([item({ opening: 25, purchaseOpening: 25, purchaseClosing: 25, closing: 25 })], '2026-07');
    const a = reconcile(prev, next);
    expect(a.filter(x => x.type === 'carry_forward')).toHaveLength(1);
    expect(a.filter(x => x.type === 'purchase_carry')).toHaveLength(0);
  });

  it('names the purchase register on both sides', () => {
    const a = reconcile(JUNE, JULY).filter(x => x.type === 'purchase_carry')[0];
    expect(a.prevRegister).toBe('purchase');
    expect(a.currRegister).toBe('purchase');
  });
});

describe('provenance — every anomaly says where its numbers came from', () => {
  it('tags the register side on both figures of a cross-month check', () => {
    const a = reconcile(MAY, JUNE).filter(x => x.type === 'carry_forward')[0];
    expect(a.prevRegister).toBe('sales');
    expect(a.currRegister).toBe('purchase');
  });

  it('tags a same-month check with the same period on both sides', () => {
    const a = reconcile(MAY, JUNE).filter(x => x.type === 'intra_month')[0];
    expect(a.prevPeriod).toBe('2026-06');
    expect(a.currPeriod).toBe('2026-06');
  });

  it('never leaves a cross-month anomaly without both periods', () => {
    for (const d of reconcileAll([MAY, JUNE, JULY])) {
      if (d.anomaly.type === 'carry_forward' || d.anomaly.type === 'purchase_carry') {
        expect(d.anomaly.prevPeriod).toBeTruthy();
        expect(d.anomaly.currPeriod).toBeTruthy();
        expect(d.anomaly.prevPeriod).not.toBe(d.anomaly.currPeriod);
      }
    }
  });
});

/** Drum Plant spare-parts workbook: Sales_Aug26 + SPARE/SPECIFICATION columns. */
function drumPlantWorkbookFile(): File {
  const wb = XLSX.utils.book_new();
  const sales = [
    ['S.NO', 'SPARE', 'SPECIFICATION', 'Op Stock', 1, 2, 3, 'Closing STOCKS'],
    [1, 'MCCB', '100 AMP', 1, null, null, null, 1],
    [2, 'MCB', '63 AMP', 4, 1, null, null, 3],
  ];
  const purchase = [
    ['S.NO', 'SPARE', 'SPECIFICATION', 'Opening Stock', 1, 2, 3, 'Closing STOCKS'],
    [1, 'MCCB', '100 AMP', 0, 1, null, null, 1],
    [2, 'MCB', '63 AMP', 4, null, null, null, 4],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sales), 'Sales_Aug26');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(purchase), 'Purchase_Aug26');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'SPARE PARS STOCK DRUM PLANT.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('parseStockFile — Drum Plant SPARE layout', () => {
  it('accepts Sales_Aug26 sheets and SPARE + SPECIFICATION columns', async () => {
    const res = await parseStockFile(drumPlantWorkbookFile());
    expect(res.months).toHaveLength(1);
    expect(res.latest?.periodKey).toBe('2026-08');
    expect(res.latest?.items.map(i => i.itemName).sort()).toEqual([
      'MCCB 100 AMP',
      'MCB 63 AMP',
    ].sort());
    const mcb = res.latest!.items.find(i => i.itemName === 'MCB 63 AMP')!;
    expect(mcb.opening).toBe(4);
    expect(mcb.used).toBe(1);
    expect(mcb.closing).toBe(3);
    expect(mcb.purchased).toBe(0);
    const mccb = res.latest!.items.find(i => i.itemName === 'MCCB 100 AMP')!;
    expect(mccb.purchased).toBe(1);
    expect(mccb.opening).toBe(1);
  });
});

describe('normalizeUnit', () => {
  it('keeps Pcs and Feet as sibling options', () => {
    expect(normalizeUnit('pcs')).toBe('Pcs');
    expect(normalizeUnit('nos')).toBe('Pcs');
    expect(normalizeUnit('feet')).toBe('Ft');
    expect(normalizeUnit('ft')).toBe('Ft');
    expect(normalizeUnit('Foot')).toBe('Ft');
  });
});
