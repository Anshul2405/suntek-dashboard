/**
 * Packed FAR heads store several plant tags on one register row, e.g.
 * "HCL Circulation Pump- ALFA (HCP-04, HCP-05, HCP-06)".
 * Split them in the picker / equipment list so a technician can choose HCP-04.
 * Same FAR id — no extra database rows.
 */

export interface PackedAssetLite {
  id: string;
  name: string;
  identification_mark: string | null;
}

export function normMark(s: string | null | undefined): string {
  return (s ?? '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const UNIT_MARK_RE = /^[A-Za-z]{1,12}[\s\-/]*\d{1,4}[A-Za-z]{0,3}$/;

export function isUnitMark(s: string): boolean {
  return UNIT_MARK_RE.test(s.trim());
}

function splitMarkList(blob: string): string[] {
  const parts = blob.split(/\s*[,;]\s*|\s+\/\s+|\s+&\s+|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2 || !parts.every(isUnitMark)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = normMark(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.length >= 2 ? out : [];
}

export function packedUnitMarks(asset: { name?: string | null; identification_mark?: string | null }): string[] {
  const fromMark = splitMarkList(asset.identification_mark || '');
  if (fromMark.length) return fromMark;
  const paren = (asset.name || '').match(/\(([^)]+)\)\s*$/);
  return paren ? splitMarkList(paren[1]) : [];
}

export function farHeadName(name: string, units: string[]): string {
  const raw = (name || '').trim();
  if (!units.length) return raw;
  const stripped = raw.replace(/\s*\(([^)]+)\)\s*$/, (_, inner) => (splitMarkList(inner).length ? '' : ` (${inner})`)).trim();
  return stripped || raw;
}

export function expandFarUnits<T extends PackedAssetLite>(assets: T[]): T[] {
  const out: T[] = [];
  for (const a of assets) {
    const units = packedUnitMarks(a);
    if (units.length < 2) {
      out.push(a);
      continue;
    }
    const head = farHeadName(a.name, units);
    for (const mark of units) out.push({ ...a, name: head, identification_mark: mark });
  }
  return out;
}
