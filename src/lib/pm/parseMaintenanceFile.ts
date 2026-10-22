/**
 * parseMaintenanceFile — turn the client's Preventive Maintenance workbook into
 * schedule templates.
 *
 * One sheet per frequency (Daily, 7 Days, 15 Days, 1/2/3/6 Months, Once a Year).
 * Each is a 3-level checklist:
 *   L1 equipment instance (name carries its FAR mark in parens — "Cooling Tower(CT 1)")
 *   L2 sub-component / checkpoint ("Hot Water Basin", "Valves", "Load Cell")
 *   L3 activity / acceptance criteria ("Cleaning", "OK/Leaking")
 * Layout varies (7 Days puts equipment in col 0; others in col 1 with an S.No), so
 * we locate the Activity column and treat any parenthesised cell as a new equipment.
 *
 * Output: one template per (frequency × equipment instance), sub-components merged.
 */
import * as XLSX from 'xlsx';
import { parseEquipmentLabel } from '../far/assets';

export interface ChecklistItem { component: string; activity: string; }
export interface PMTemplate {
  frequency: string;         // our schedule enum
  sheet: string;             // original sheet name
  equipmentLabel: string;    // "Cooling Tower(CT 1)"
  equipmentType: string;     // "Cooling Tower"
  mark: string | null;       // "CT 1"
  checklist: ChecklistItem[];
}
export interface PMParseResult { templates: PMTemplate[]; sheetCount: number; skipped: string[]; }

/** Map a sheet name to our frequency enum (null = not a schedule sheet). */
export function freqFromSheet(name: string): string | null {
  const s = (name || '').toLowerCase();
  if (/daily/.test(s)) return 'daily';
  if (/15\s*day|fortnight/.test(s)) return 'fortnightly';
  if (/7\s*day|weekly|week/.test(s)) return 'weekly';
  if (/2\s*month|bi.?month/.test(s)) return 'bimonthly';
  if (/3\s*month|quarter/.test(s)) return 'quarterly';
  if (/6\s*month|bi.?annual|half.?year/.test(s)) return 'biannual';
  if (/once a year|yearly|annual|1\s*year/.test(s)) return 'annual';
  if (/month/.test(s)) return 'monthly';
  return null;
}

const hasMark = (s: string) => /\([^)]+\)\s*$/.test((s || '').trim());
const clean = (v: unknown) => (v == null ? '' : String(v).trim());
const isHeaderLabel = (s: string) => /^(activity|equipment name|s\.?no|date|due date|done by|verified by|verfide by|remarks|picture)$/i.test(s.trim());

/** Ganjam Daily sheets are filled-in logs (13.06.2026, …) — not task lists. */
export function isDateLikeActivity(value: unknown): boolean {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  const s = clean(value);
  if (!s) return false;
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(s)) return true;
  if (/^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(s)) return true;
  // Excel serial (XLSX without cellDates) — ~1982–2119.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 30000 && n <= 80000) return true;
  }
  return false;
}

export function isDateOnlyChecklist(items: { activity?: string | null }[] | null | undefined): boolean {
  if (!items?.length) return false;
  const acts = items.map(i => (i.activity || '').trim()).filter(Boolean);
  return acts.length > 0 && acts.every(isDateLikeActivity);
}

/** Collapse "Reactor - 01" / "Reactor No.-01" to the same key. */
export function equipmentMatchKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bno\.?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/0+(\d)/g, '$1');
}

const SIBLING_FREQ = ['monthly', 'weekly', 'fortnightly', 'bimonthly', 'quarterly', 'biannual', 'annual'] as const;

export type ChecklistPair = { component: string; activity: string };

export function pickReplacementChecklist(
  current: { equipment: string; plant_id?: string | null; checklist: ChecklistPair[] | null },
  candidates: { equipment: string; plant_id?: string | null; frequency: string; checklist: ChecklistPair[] | null }[],
): ChecklistPair[] | null {
  if (!isDateOnlyChecklist(current.checklist)) return null;
  const key = equipmentMatchKey(current.equipment);
  if (!key) return null;
  const siblings = candidates.filter(c =>
    c.plant_id === current.plant_id
    && equipmentMatchKey(c.equipment) === key
    && !isDateOnlyChecklist(c.checklist)
    && (c.checklist?.length ?? 0) > 0,
  );
  siblings.sort((a, b) => {
    const ai = SIBLING_FREQ.indexOf(a.frequency as typeof SIBLING_FREQ[number]);
    const bi = SIBLING_FREQ.indexOf(b.frequency as typeof SIBLING_FREQ[number]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return siblings[0]?.checklist ?? null;
}

function parseSheet(ws: XLSX.WorkSheet, frequency: string, sheetName: string): PMTemplate[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', blankrows: false });
  if (!rows.length) return [];

  // Locate the Activity column: the col holding an "Activity" header cell. The
  // equipment/sub-component sits in the column just before it.
  let activityCol = -1;
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const ix = r.findIndex(c => typeof c === 'string' && /^activity$/i.test(c.trim()));
    if (ix > 0) { activityCol = ix; break; }
  }
  const equipCol = activityCol > 0 ? activityCol - 1 : 1;
  if (activityCol < 0) activityCol = equipCol + 1;
  const snoCol = equipCol - 1; // S.No column (a plain integer marks a new equipment row, e.g. flat Daily sheet)
  const isEquipRow = (equip: string, r: unknown[]) => hasMark(equip) || (snoCol >= 0 && /^\d+$/.test(clean(r[snoCol])) && !!equip);

  const groups = new Map<string, PMTemplate>();
  let current: PMTemplate | null = null;
  const addItem = (t: PMTemplate, component: string, activity: string) => {
    const c = component.trim(), a = activity.trim();
    if (!c || isHeaderLabel(c) || isDateLikeActivity(c)) return;
    if (!a || isHeaderLabel(a) || isDateLikeActivity(a)) return;
    if (t.checklist.some(x => x.component.toLowerCase() === c.toLowerCase() && x.activity.toLowerCase() === a.toLowerCase())) return;
    t.checklist.push({ component: c, activity: a });
  };

  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const equip = clean(r[equipCol]);
    const act = clean(r[activityCol]);
    if (!equip || isHeaderLabel(equip)) continue;

    if (isEquipRow(equip, r)) {
      // New equipment instance (dedupe across weekly repetitions → merge checklist).
      const key = equip.toLowerCase().replace(/\s+/g, ' ');
      let t = groups.get(key);
      if (!t) {
        const { name, mark } = parseEquipmentLabel(equip);
        t = { frequency, sheet: sheetName, equipmentLabel: equip, equipmentType: name, mark, checklist: [] };
        groups.set(key, t);
      }
      current = t;
      // The header row itself may carry a top-level activity (e.g. "Cleaning").
      if (act && !isHeaderLabel(act)) addItem(t, t.equipmentType, act);
    } else if (current && act && !isHeaderLabel(act)) {
      // Sub-component checkpoint under the current equipment.
      addItem(current, equip, act);
    }
  }
  return [...groups.values()].filter(t => t.checklist.length > 0 || t.mark);
}

export async function parseMaintenanceFile(file: File): Promise<PMParseResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const templates: PMTemplate[] = [];
  const skipped: string[] = [];
  let sheetCount = 0;
  for (const name of wb.SheetNames) {
    const freq = freqFromSheet(name);
    if (!freq) { skipped.push(name); continue; }
    sheetCount++;
    templates.push(...parseSheet(wb.Sheets[name], freq, name));
  }
  return { templates, sheetCount, skipped };
}
