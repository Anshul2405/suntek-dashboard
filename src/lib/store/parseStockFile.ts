/**
 * parseStockFile — turn a client "Store Keeping" workbook into a per-month,
 * per-item stock model.
 *
 * The workbook holds a `Sales <Month>` and a `Purchase <Month>` sheet for each
 * month (also accepts `Sales_Aug26` / `Purchase_Aug26`). Header sits on ~row 2
 * (a junk title row above it). Columns (Jharkhand store-keeping layout):
 *   Sr No. · Items Name · Unit · Op Stock/Opening · [1…31 day columns] · Closing Stock
 * Drum Plant spare-parts layout uses SPARE + SPECIFICATION instead of Items Name.
 *
 * Per item, per month (both sheets combined):
 *   opening   = Sales "Op Stock"  (cross-checked vs Purchase "Opening")
 *   purchased = Σ Purchase daily   (bought that month)
 *   used      = Σ Sales daily      (issued that month)
 *   closing   = opening + purchased − used   ← becomes next month's headstart
 *
 * Pure + framework-free so it can be unit-tested and reused.
 */
import * as XLSX from 'xlsx';
import { similarity } from '../blacklist/similarity';

export interface MonthItem {
  itemName: string;         // display name (prefers the Sales sheet spelling)
  key: string;              // normalized join key (Sales ↔ Purchase)
  unit: string;
  equipment: string;        // derived from the name prefix
  model: string | null;     // derived from the (…) in the name
  opening: number;          // Sales "Op Stock"
  purchaseOpening: number;
  purchaseClosing: number;  // Purchase "Closing" = opening + receipts = stock AVAILABLE  // Purchase "Opening" (for the intra-month check)
  purchased: number;        // Σ Purchase daily
  used: number;             // Σ Sales daily
  closing: number;          // opening + purchased − used
}

export interface MonthParse {
  periodKey: string;        // 'YYYY-MM'
  periodMonth: string;      // 'YYYY-MM-01' (date for the DB)
  label: string;            // 'Apr 2026'
  items: MonthItem[];
  hasSales: boolean;
  hasPurchase: boolean;
}

export interface StockParseResult {
  months: MonthParse[];     // ascending by period
  latest: MonthParse | null;
  sheetCount: number;
  totalItems: number;       // item count in the latest month
}

export type AnomalyType =
  | 'carry_forward'    // prev month SALES closing  → this month PURCHASE opening
  | 'purchase_carry'   // prev month PURCHASE closing → this month PURCHASE opening
  | 'intra_month'      // this month PURCHASE closing ↔ this month SALES opening
  | 'sheet_self'       // a sheet disagrees with its own arithmetic
  | 'negative' | 'added' | 'removed';

/** Which book a compared figure was read from. */
export type RegisterSide = 'sales' | 'purchase';

export interface Anomaly {
  type: AnomalyType;
  item: string;
  detail: string;
  severity: 'high' | 'medium' | 'info';
  prev?: number;
  curr?: number;
  delta?: number;
  suggestion?: string;      // possible rename target
  /**
   * PROVENANCE — which two figures were actually compared.
   *
   * Every cross-month check reads one number from one month's book and another
   * from a different month's book. Without saying so, "Last month closed at 31,
   * this month's purchase book opens at 7" is unreadable: a reviewer looking at
   * the newest month assumes those are the newest two months, maps the numbers
   * onto the wrong sheets, and concludes the engine compared the wrong periods.
   * That misreading is exactly what this field exists to prevent, so every
   * anomaly carries the period and register behind each side.
   *
   * `prevPeriod` is undefined for the single-month checks (sheet_self, negative,
   * added, removed), which compare a month against itself.
   */
  prevPeriod?: string;      // 'YYYY-MM' the `prev` figure came from
  currPeriod?: string;      // 'YYYY-MM' the `curr` figure came from
  prevRegister?: RegisterSide;
  currRegister?: RegisterSide;
}

/** An anomaly plus the month it is filed under (the later of the pair). */
export interface DatedAnomaly {
  anomaly: Anomaly;
  /** 'YYYY-MM-01' — the month this anomaly is attributed to, for persistence. */
  periodMonth: string;
  periodKey: string;        // 'YYYY-MM'
}

// ── Unit normalization ───────────────────────────────────────────────────────
const UNIT_MAP: Record<string, string> = {
  'pcs': 'Pcs', 'pcs.': 'Pcs', 'pc': 'Pcs', 'nos': 'Pcs', 'no': 'Pcs', 'no.': 'Pcs',
  'ft': 'Ft', 'ft.': 'Ft', 'feet': 'Ft', 'foot': 'Ft',
  'ltr': 'Ltr', 'ltr.': 'Ltr', 'litre': 'Ltr', 'l': 'Ltr',
  'kg': 'Kg', 'kgs': 'Kg', 'pair': 'Pair', 'set': 'Set', 'sets': 'Set',
  'roll': 'Roll', 'role': 'Roll', 'pkt': 'Pkt', 'packet': 'Pkt',
  'mtr': 'Mtr', 'meter': 'Mtr', 'm': 'Mtr', 'can': 'Can', 'bag': 'Bag', 'bottle': 'Bottle',
};
export function normalizeUnit(raw: unknown): string {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return 'Pcs';
  return UNIT_MAP[s.toLowerCase()] ?? s;
}

/** Canonical units offered in pickers — the distinct outputs of UNIT_MAP. */
export const UNIT_OPTIONS: string[] = [
  'Pcs', 'Ft', 'Kg', 'Ltr', 'Mtr', 'Pair', 'Set', 'Roll', 'Pkt', 'Can', 'Bag', 'Bottle',
];

// ── Equipment/model from the item name, e.g. "Acid Pump (NZRP50) Sleeve" ─────
export function deriveEquipment(name: string): { equipment: string; model: string | null } {
  const m = name.match(/^\s*(.*?)\s*\(([^)]*)\)/);
  if (m) return { equipment: (m[1] || name).trim(), model: (m[2] || '').trim() || null };
  // No parens → take the leading words before a dash/number as the "equipment".
  const eq = name.split(/[-–—,]/)[0].trim();
  return { equipment: eq || name.trim(), model: null };
}

// ── Join key: fold spacing/punctuation so the two sheets line up ─────────────
function joinKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/** "2 units" / "24 units short" — a signed count read as English, not "+2". */
function fmtDelta(delta: number): string {
  const n = Math.abs(delta);
  const unit = n === 1 ? 'unit' : 'units';
  if (delta === 0) return `0 ${unit}`;
  return delta > 0 ? `${n} ${unit} more` : `${n} ${unit} short`;
}

/**
 * 'Jun 2026' from a '2026-06-01' period date.
 *
 * The label ALWAYS carries the year, so a December→January comparison reads
 * "Dec 2026 … Jan 2027" and cannot be mistaken for a same-year pair.
 * Used when months are rebuilt from stored snapshots, which carry a date rather
 * than the original sheet name.
 */
export function labelForPeriod(periodMonth: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(periodMonth);
  if (!m) return periodMonth;
  return `${MONTH_LABELS[parseInt(m[2], 10)] ?? m[2]} ${m[1]}`;
}

function num(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }
  return 0;
}

// ── Sheet name → { kind, periodKey } ─────────────────────────────────────────
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
function parseSheetName(name: string): { kind: 'sales' | 'purchase'; key: string; month: number; year: number } | null {
  const s = name.trim().toLowerCase();
  const km = s.match(/^(sales|purchase)/);
  if (!km) return null;
  const kind = km[1] as 'sales' | 'purchase';
  // Remainder after Sales/Purchase: " August 2026", "_Aug26", "-Aug'26", etc.
  const rest = s.slice(km[0].length).replace(/^[\s_\-.]+/, '');
  const mm = rest.match(/^([a-z]+)\.?\s*'?(\d{2,4})/);
  if (!mm) return null;
  const month = MONTHS[mm[1]];
  if (!month) return null;
  let year = parseInt(mm[2], 10);
  if (year < 100) year += 2000;
  return { kind, key: `${year}-${String(month).padStart(2, '0')}`, month, year };
}
const MONTH_LABELS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Parse one sheet (array-of-arrays) into a name→{unit,opening,movement} map ─
interface SheetItem { name: string; unit: string; opening: number; movement: number; closing: number | null; }

/**
 * The month's closing balance for an item.
 *
 * PREFER THE SHEET'S OWN "Closing" COLUMN. Recomputing it as
 * opening + purchased − used double-counts whenever the two sheets describe the
 * same physical stock from different angles — which is normal in this workbook.
 *
 * Real example, 3.5 SUT (7/16") 2" LENGTH, July 2026:
 *   Sales sheet     Op Stock 50, no issues,        Closing 50
 *   Purchase sheet  Opening   0, 50 bought day 7,  Closing 50
 * Both agree the month ends at 50 — the same 50 units. The formula gave
 * 50 + 50 − 0 = 100, and the register showed double the real stock.
 *
 * The Sales sheet is the stock book, so its Closing is authoritative. The
 * computed value is only a fallback for the rare row with no Closing cell
 * (2 of 521 in the client's July sheet).
 */
export function resolveClosing(
  salesClosing: number | null | undefined,
  opening: number, purchased: number, used: number,
): number {
  return typeof salesClosing === 'number' && Number.isFinite(salesClosing)
    ? salesClosing
    : opening + purchased - used;
}
function isStockHeaderCell(c: unknown): boolean {
  if (typeof c !== 'string') return false;
  const t = c.trim();
  return /items?\s*name/i.test(t) || /^spare$/i.test(t);
}

function rowItemName(
  r: unknown[],
  itemIdx: number,
  spareIdx: number,
  specIdx: number,
): string {
  if (itemIdx >= 0) {
    const raw = r[itemIdx];
    return raw == null ? '' : String(raw).trim();
  }
  if (spareIdx < 0) return '';
  const spare = r[spareIdx] == null ? '' : String(r[spareIdx]).trim();
  if (!spare) return '';
  const spec = specIdx >= 0 && r[specIdx] != null ? String(r[specIdx]).trim() : '';
  // "MCCB" + "100 AMP" → distinct SKUs share a spare family name.
  return spec ? `${spare} ${spec}` : spare;
}

function parseSheet(ws: XLSX.WorkSheet): Map<string, SheetItem> {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
  // Header = first row with "Items Name" (store-keeping) or "SPARE" (Drum Plant).
  const hi = rows.findIndex(r => Array.isArray(r) && r.some(isStockHeaderCell));
  if (hi < 0) return new Map();
  const header = (rows[hi] as unknown[]).map(c => (c == null ? '' : String(c).trim()));
  const findCol = (re: RegExp) => header.findIndex(h => re.test(h));
  const itemIdx = findCol(/items?\s*name/i);
  const spareIdx = findCol(/^spare$/i);
  const specIdx = findCol(/^specification/i);
  const unitIdx = findCol(/^unit/i);
  const openIdx = findCol(/op.*stock|opening/i);
  const closeIdx = findCol(/closing/i);
  if ((itemIdx < 0 && spareIdx < 0) || openIdx < 0) return new Map();
  // Day columns live strictly between Opening and Closing (fallback: numeric headers after Opening).
  const dayIdxs: number[] = [];
  for (let j = openIdx + 1; j < header.length; j++) {
    if (closeIdx >= 0 && j >= closeIdx) break;
    if (closeIdx < 0 && !/^\d{1,2}$/.test(header[j])) continue;
    dayIdxs.push(j);
  }

  const out = new Map<string, SheetItem>();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    if (!Array.isArray(r)) continue;
    const name = rowItemName(r, itemIdx, spareIdx, specIdx);
    if (!name) continue;
    const key = joinKey(name);
    if (!key) continue;
    const movement = dayIdxs.reduce((s, j) => s + num(r[j]), 0);
    const rawClose = closeIdx >= 0 ? r[closeIdx] : null;
    const item: SheetItem = {
      name,
      unit: unitIdx >= 0 ? String(r[unitIdx] ?? '').trim() : '',
      opening: num(r[openIdx]),
      movement,
      // The sheet's own stated closing — authoritative when present.
      closing: typeof rawClose === 'number' ? rawClose
             : (typeof rawClose === 'string' && rawClose.trim() !== '' ? num(rawClose) : null),
    };
    // First occurrence wins (guards against duplicate rows in the sheet).
    if (!out.has(key)) out.set(key, item);
  }
  return out;
}

/** Parse a Store Keeping workbook into the per-month, per-item model. */
export async function parseStockFile(file: File): Promise<StockParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  // Group sheets into { periodKey → { sales?, purchase? } }.
  type Pair = { month: number; year: number; sales?: Map<string, SheetItem>; purchase?: Map<string, SheetItem> };
  const byPeriod = new Map<string, Pair>();
  let sheetCount = 0;
  for (const sheetName of wb.SheetNames) {
    const meta = parseSheetName(sheetName);
    if (!meta) continue;
    sheetCount++;
    const parsed = parseSheet(wb.Sheets[sheetName]);
    if (!parsed.size) continue;
    const p = byPeriod.get(meta.key) ?? { month: meta.month, year: meta.year };
    p[meta.kind] = parsed;
    byPeriod.set(meta.key, p);
  }

  const months: MonthParse[] = [...byPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, p]) => {
      const sales = p.sales ?? new Map<string, SheetItem>();
      const purchase = p.purchase ?? new Map<string, SheetItem>();
      const keys = new Set<string>([...sales.keys(), ...purchase.keys()]);
      const items: MonthItem[] = [];
      for (const k of keys) {
        const s = sales.get(k);
        const pu = purchase.get(k);
        const name = (s?.name || pu?.name || '').trim();
        if (!name) continue;
        const opening = s ? s.opening : (pu ? pu.opening : 0);
        const purchaseOpening = pu ? pu.opening : 0;
        // The Purchase sheet's own stated closing (= opening + receipts). This is
        // the figure the store team carries across into the Sales "Op Stock",
        // which is what makes the two comparable.
        const purchaseClosing = pu
          ? (typeof pu.closing === 'number' ? pu.closing : pu.opening + pu.movement)
          : 0;
        const purchased = pu ? pu.movement : 0;
        const used = s ? s.movement : 0;
        const { equipment, model } = deriveEquipment(name);
        items.push({
          itemName: name, key: k,
          unit: normalizeUnit(s?.unit || pu?.unit),
          equipment, model,
          opening, purchaseOpening, purchaseClosing, purchased, used,
          // Never opening + purchased − used when the sheet states a closing:
          // that sums the same stock twice (see resolveClosing).
          closing: resolveClosing(s?.closing, opening, purchased, used),
        });
      }
      items.sort((a, b) => a.itemName.localeCompare(b.itemName));
      return {
        periodKey: key,
        periodMonth: `${key}-01`,
        label: `${MONTH_LABELS[p.month]} ${p.year}`,
        items,
        hasSales: !!p.sales,
        hasPurchase: !!p.purchase,
      };
    });

  const latest = months.length ? months[months.length - 1] : null;
  return { months, latest, sheetCount, totalItems: latest ? latest.items.length : 0 };
}

/**
 * Compare two consecutive months and surface anomalies:
 * Three hand-offs, three checks. Together they close the loop:
 *
 *     Sales Closing (n-1) ──[carry_forward]──► Purchase Opening (n)
 *                                                    + receipts
 *                                              Purchase Closing (n)
 *                                                    │
 *                                              [intra_month]
 *                                                    │
 *                                              Sales Op Stock (n)
 *                                                    − issues
 *                                              Sales Closing (n)  → the register
 *
 *  - intra_month:   Sales "Op Stock" ≠ Purchase "Closing", same month. The
 *      store team copies one into the other by hand, so they must agree.
 *      Client-confirmed. Measured: Apr 413/421, May 415/418, Jun 367/427,
 *      Jul 515/515.
 *  - carry_forward: Sales "Closing" (n-1) ≠ Purchase "Opening" (n). Stock that
 *      appeared or vanished between months. Measured: 412/418, 400/408,
 *      211/403 — the last is a real July stock-take, not noise.
 *  - sheet_self:    a sheet disagrees with its OWN arithmetic. This is the only
 *      check that catches a hand-typed closing: if someone overwrites the cell,
 *      BOTH books agree on the wrong number and the two checks above stay
 *      silent. Found exactly that on "Acid Pump (NZRP50200TBGV1J) Impeller O
 *      Ring" — 15 + 0 received, but the sheet states 20, in two months running.
 *  - negative:      a stated closing below zero.
 *  - added/removed: the item list changed vs the previous month.
 */
export function reconcile(prev: MonthParse | null, curr: MonthParse): Anomaly[] {
  const out: Anomaly[] = [];
  const prevByKey = new Map((prev?.items ?? []).map(i => [i.key, i]));
  const currByKey = new Map(curr.items.map(i => [i.key, i]));

  for (const it of curr.items) {
    // Hand-off across the month boundary: last month's true closing must be
    // what the new Purchase book opens with. Compared against the PURCHASE
    // opening, not the Sales opening — the Sales opening already includes this
    // month's receipts, which is why the old version of this check fired on
    // every item that had been bought.
    // `prev` is null when the workbook contains only ONE month — there is no
    // previous closing to hand over from, so this check is simply skipped
    // rather than compared against zero. Same when an item is new: it has no
    // row in the previous month.
    if (prev) {
      const p = prevByKey.get(it.key);
      if (p && p.closing !== it.purchaseOpening) {
        const delta = it.purchaseOpening - p.closing;
        out.push({
          type: 'carry_forward', item: it.itemName,
          severity: Math.abs(delta) > 5 ? 'high' : 'medium',
          prev: p.closing, curr: it.purchaseOpening, delta,
          prevPeriod: prev.periodKey, currPeriod: curr.periodKey,
          prevRegister: 'sales', currRegister: 'purchase',
          detail: `${prev.label} Sales Register closed at ${p.closing}, but ${curr.label} Purchase Register opened at ${it.purchaseOpening}. Difference: ${fmtDelta(delta)}.`,
        });
      }

      // CHECK 3 — the same hand-off measured on the PURCHASE side.
      //
      // Distinct from carry_forward above, which carries the SALES closing
      // forward. Each answers a different question:
      //   carry_forward  — did the stock we ISSUED FROM carry over?
      //   purchase_carry — did the stock we BOUGHT INTO carry over?
      //
      // Only emitted when the previous month's two books DISAGREE
      // (`p.closing !== p.purchaseClosing`). When they agree, the two checks
      // are the same subtraction against the same number and would report one
      // discrepancy twice — which reads as double-counting and is what makes a
      // reviewer stop trusting the totals. Where they diverge the extra row
      // earns its place: it names which book is out of step, and it is the only
      // check that catches a purchase closing that never carried forward.
      if (p && p.closing !== p.purchaseClosing && p.purchaseClosing !== it.purchaseOpening) {
        const delta = it.purchaseOpening - p.purchaseClosing;
        out.push({
          type: 'purchase_carry', item: it.itemName,
          severity: Math.abs(delta) > 5 ? 'high' : 'medium',
          prev: p.purchaseClosing, curr: it.purchaseOpening, delta,
          prevPeriod: prev.periodKey, currPeriod: curr.periodKey,
          prevRegister: 'purchase', currRegister: 'purchase',
          detail: `${prev.label} Purchase Register closed at ${p.purchaseClosing}, but ${curr.label} Purchase Register opened at ${it.purchaseOpening}. Difference: ${fmtDelta(delta)}.`,
        });
      }
    }

    // Hand-off within the month: the two sheets must agree on the stock that
    // was available. Client-confirmed.
    if (it.opening !== it.purchaseClosing) {
      const delta = it.opening - it.purchaseClosing;
      out.push({
        type: 'intra_month', item: it.itemName,
        severity: Math.abs(delta) > 5 ? 'high' : 'medium',
        prev: it.purchaseClosing, curr: it.opening, delta,
        prevPeriod: curr.periodKey, currPeriod: curr.periodKey,
        prevRegister: 'purchase', currRegister: 'sales',
        detail: `${curr.label} Purchase Register closed at ${it.purchaseClosing}, but ${curr.label} Sales Register opened at ${it.opening}. Difference: ${fmtDelta(delta)}.`,
      });
    }
    // Each sheet must agree with its own arithmetic. Catches an overwritten
    // closing cell — the one error the two cross-checks cannot see, because a
    // bad number copied forward makes both books agree.
    const salesExpected = it.opening - it.used;
    if (it.closing !== salesExpected) {
      out.push({
        type: 'sheet_self', item: it.itemName, severity: 'high',
        prev: salesExpected, curr: it.closing, delta: it.closing - salesExpected,
        prevPeriod: curr.periodKey, currPeriod: curr.periodKey,
        prevRegister: 'sales', currRegister: 'sales',
        detail: `${curr.label} Sales Register: ${it.opening} available − ${it.used} issued = ${salesExpected}, but the sheet states ${it.closing}.`,
      });
    }
    const purchExpected = it.purchaseOpening + it.purchased;
    if (it.purchaseClosing !== purchExpected) {
      out.push({
        type: 'sheet_self', item: it.itemName, severity: 'high',
        prev: purchExpected, curr: it.purchaseClosing, delta: it.purchaseClosing - purchExpected,
        prevPeriod: curr.periodKey, currPeriod: curr.periodKey,
        prevRegister: 'purchase', currRegister: 'purchase',
        detail: `${curr.label} Purchase Register: ${it.purchaseOpening} opening + ${it.purchased} received = ${purchExpected}, but the sheet states ${it.purchaseClosing}.`,
      });
    }

    // A stated closing below zero — more issued than was ever received.
    if (it.closing < 0) {
      out.push({
        type: 'negative', item: it.itemName, severity: 'high', curr: it.closing,
        currPeriod: curr.periodKey, currRegister: 'sales',
        detail: `${curr.label} Sales Register closing ${it.closing}: ${it.used} issued from ${it.opening} available.`,
      });
    }
  }

  if (prev) {
    const removed = prev.items.filter(i => !currByKey.has(i.key));
    const added = curr.items.filter(i => !prevByKey.has(i.key));
    for (const a of added) {
      // Fuzzy: was this a rename of something that disappeared?
      let best: { name: string; score: number } | null = null;
      for (const r of removed) {
        const sc = similarity(a.itemName, r.itemName);
        if (sc > 0.8 && (!best || sc > best.score)) best = { name: r.itemName, score: sc };
      }
      out.push({
        type: 'added', item: a.itemName, severity: 'info',
        currPeriod: curr.periodKey,
        detail: best
          ? `New in ${curr.label} — possibly renamed from "${best.name}".`
          : `New item in ${curr.label}.`,
        suggestion: best?.name,
      });
    }
    for (const r of removed) {
      const wasRenamed = added.some(a => similarity(a.itemName, r.itemName) > 0.8);
      if (wasRenamed) continue; // already surfaced as a rename on the "added" side
      out.push({
        type: 'removed', item: r.itemName, severity: 'info',
        prevPeriod: prev.periodKey, currPeriod: curr.periodKey,
        detail: `Present in ${prev.label} but dropped from ${curr.label}.`,
      });
    }
  }

  return out;
}

/**
 * Reconcile EVERY consecutive month pair in the workbook, not just the newest.
 *
 * Why this exists: both callers used to reconcile only `months[n-2] → months[n-1]`.
 * That makes a discrepancy disappear the moment a newer month is uploaded — a
 * real mismatch inside June stops being reported as soon as July lands, even
 * though nobody ever looked at it or resolved it. Anomalies are not transient
 * observations about the newest sheet; they are defects in the register that
 * stay true until someone fixes them.
 *
 * Each anomaly is filed under the LATER month of its pair, so a June→July
 * carry-forward is a July anomaly and the persisted review key stays stable no
 * matter how many further months are uploaded afterwards.
 *
 * Months are sorted by period, so re-uploading the same workbook with its sheets
 * in a different order produces identical results (acceptance criterion 11).
 */
export function reconcileAll(months: MonthParse[]): DatedAnomaly[] {
  const sorted = [...months].sort((a, b) => a.periodMonth.localeCompare(b.periodMonth));
  const out: DatedAnomaly[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    for (const anomaly of reconcile(prev, curr)) {
      out.push({ anomaly, periodMonth: curr.periodMonth, periodKey: curr.periodKey });
    }
  }
  return out;
}
