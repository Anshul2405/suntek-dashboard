// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { categoryForAmount, categorySkipsUnitHead, DEFAULT_VALUE_BANDS, plantUsesCategories } from './valueCategory';

describe('purchase value categories', () => {
  it('grades a line by its own amount, and leaves the gap unclassified', () => {
    expect(categoryForAmount(999, DEFAULT_VALUE_BANDS)).toBe('C');
    expect(categoryForAmount(1000, DEFAULT_VALUE_BANDS)).toBe('B');
    expect(categoryForAmount(2999, DEFAULT_VALUE_BANDS)).toBe('B');
    expect(categoryForAmount(4000, DEFAULT_VALUE_BANDS)).toBeNull();
    expect(categoryForAmount(5000, DEFAULT_VALUE_BANDS)).toBe('A');
  });

  it('lets only category C skip unit head, and only on a plant the admin switched on', () => {
    expect(categorySkipsUnitHead('C')).toBe(true);
    expect(categorySkipsUnitHead('B')).toBe(false);
    expect(categorySkipsUnitHead('A')).toBe(false);
    expect(plantUsesCategories('p1', { enabledPlantIds: ['p1'], bands: DEFAULT_VALUE_BANDS })).toBe(true);
    expect(plantUsesCategories('p2', { enabledPlantIds: ['p1'], bands: DEFAULT_VALUE_BANDS })).toBe(false);
  });
});
