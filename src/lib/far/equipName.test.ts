// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canonEquipName, displayEquipName, searchFold } from './equipName';

describe('canonEquipName', () => {
  it('treats Disel and Diesel as the same name', () => {
    expect(canonEquipName('Disel Generator')).toBe(canonEquipName('Diesel Generator'));
  });
  it('shows Disel as Diesel and folds it for search', () => {
    expect(displayEquipName('Disel Generator')).toBe('Diesel Generator');
    expect(displayEquipName('DG Set')).toBe('DG Set');
    expect(searchFold('Disel Generator').includes(searchFold('diesel'))).toBe(true);
  });
});
