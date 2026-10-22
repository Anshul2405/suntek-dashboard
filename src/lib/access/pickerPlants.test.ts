// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { plantsForPicker } from './pickerPlants';

describe('plantsForPicker', () => {
  it('shows nothing until scope is ready, so six plants do not flash', () => {
    expect(plantsForPicker([{ id: 'a' }, { id: 'b' }], false)).toEqual([]);
  });
  it('uses the granted list once ready, including an empty list', () => {
    expect(plantsForPicker([{ id: 'madan' }], true)).toEqual([{ id: 'madan' }]);
    expect(plantsForPicker([], true)).toEqual([]);
  });
});
