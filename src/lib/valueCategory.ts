/**
 * Purchase lines are graded by their own bill amount. Thresholds are set by
 * admin / management / unit head. A gap between bands is allowed: an amount
 * that matches no band has no category and keeps the normal unit-head path.
 */

export interface ValueBand {
  code: string;
  /** Inclusive lower bound, rupees. */
  min: number;
  /** Exclusive upper bound. Null means no ceiling. */
  max: number | null;
}

export interface ValueCategorySettings {
  /** Plants where the category changes the ticket workflow. Others stay normal. */
  enabledPlantIds: string[];
  bands: ValueBand[];
}

/** The example from the plant: under ₹1,000 is C, ₹1,000–₹3,000 is B, ₹5,000 and above is A. */
export const DEFAULT_VALUE_BANDS: ValueBand[] = [
  { code: 'C', min: 0, max: 1000 },
  { code: 'B', min: 1000, max: 3000 },
  { code: 'A', min: 5000, max: null },
];

export const DEFAULT_VALUE_CATEGORIES: ValueCategorySettings = {
  enabledPlantIds: [],
  bands: DEFAULT_VALUE_BANDS,
};

export function categoryForAmount(amount: number | null | undefined, bands: ValueBand[]): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  const hit = bands.find((b) => amount >= b.min && (b.max == null || amount < b.max));
  return hit?.code || null;
}

export function categorySkipsUnitHead(category: string | null | undefined): boolean {
  return (category || '').toUpperCase() === 'C';
}

export function plantUsesCategories(plantId: string | null | undefined, settings: ValueCategorySettings): boolean {
  if (!plantId) return false;
  return settings.enabledPlantIds.includes(plantId);
}
