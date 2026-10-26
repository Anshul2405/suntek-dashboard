/**
 * FAR asset helpers — shared by the FAR importer and Preventive Maintenance.
 *
 * The join between a PM schedule and a FAR asset is the identification mark, which
 * the two sheets format slightly differently ("GLC 1" vs "GLC1", "HPT1" vs "HPT 1").
 * normMark() collapses those so they compare equal.
 */
import { similarity } from '../blacklist/similarity';
import { jobNoFar, isPlaceholderMark } from '../jobNo';

export interface AssetLite {
  id: string;
  name: string;
  identification_mark: string | null;
  job_no?: string | null;
}

/** Uppercase alphanumeric only — "GLC 1" → "GLC1", "HPT 1" → "HPT1", "CT-1" → "CT1". */
export function normMark(s: string | null | undefined): string {
  return (s ?? '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Split a PM equipment label into its type + instance mark.
 *  "Cooling Tower(CT 1)" → { name: "Cooling Tower", mark: "CT 1" } */
export function parseEquipmentLabel(label: string): { name: string; mark: string | null } {
  const m = (label || '').match(/^\s*(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) return { name: m[1].trim(), mark: (m[2] || '').trim() || null };
  return { name: (label || '').trim(), mark: null };
}

export interface AssetMatch<T extends AssetLite = AssetLite> { asset: T; score: number; via: 'mark' | 'name'; }

/** Best FAR asset for a PM equipment label: exact (normalised) mark first, else fuzzy name. */
export function matchAsset<T extends AssetLite>(label: string, assets: T[]): AssetMatch<T> | null {
  const { name, mark } = parseEquipmentLabel(label);
  if (mark && !isPlaceholderMark(mark)) {
    const nm = normMark(mark);
    if (nm) {
      const hit = assets.find(a => normMark(a.identification_mark) === nm || jobNoFar(a.id, a.identification_mark, a.job_no).toUpperCase().replace(/[^A-Z0-9]/g, '') === nm);
      if (hit) return { asset: hit, score: 1, via: 'mark' };
    }
  }
  let best: AssetMatch<T> | null = null;
  for (const a of assets) {
    const sc = similarity(name, a.name);
    if (sc > 0.6 && (!best || sc > best.score)) best = { asset: a, score: sc, via: 'name' };
  }
  return best;
}

/** Ranked FAR suggestions for a type-ahead (mark hit ranks top, then fuzzy name/mark). */
export function suggestAssets<T extends AssetLite>(query: string, assets: T[], topN = 12): AssetMatch<T>[] {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const { name, mark } = parseEquipmentLabel(q);
  const nm = mark ? normMark(mark) : normMark(q);
  return assets
    .map(a => {
      const am = normMark(a.identification_mark);
      const job = jobNoFar(a.id, a.identification_mark, a.job_no).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const qNorm = normMark(q);
      const markHit = nm.length >= 2 && (am === nm || job === nm || job === qNorm);
      const markPartial = nm.length >= 2 && (
        (am && (am.includes(nm) || nm.includes(am)))
        || (job && (job.includes(nm) || job.includes(qNorm) || qNorm.includes(job.slice(-8))))
      ) ? 0.8 : 0;
      const score = markHit ? 1 : Math.max(similarity(name, a.name), markPartial);
      return { asset: a, score, via: (markHit || markPartial ? 'mark' : 'name') as 'mark' | 'name' };
    })
    .filter(x => x.score > 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN) as AssetMatch<T>[];
}

export interface AssetTypeGroup<T extends AssetLite = AssetLite> { type: string; count: number; assets: T[]; }

/** Group the flat FAR into type groups with counts — the "Equipment List" derived view. */
export function groupAssetsByType<T extends AssetLite>(assets: T[]): AssetTypeGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const a of assets) {
    const key = (a.name || 'Unnamed').trim();
    const arr = map.get(key);
    if (arr) arr.push(a); else map.set(key, [a]);
  }
  return [...map.entries()]
    .map(([type, list]) => ({
      type, count: list.length,
      assets: [...list].sort((x, y) => normMark(x.identification_mark).localeCompare(normMark(y.identification_mark))),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
