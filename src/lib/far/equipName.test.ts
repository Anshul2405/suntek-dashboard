// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canonEquipName } from './equipName';

describe('canonEquipName', () => {
  it('treats Disel and Diesel as the same name', () => {
    expect(canonEquipName('Disel Generator')).toBe(canonEquipName('Diesel Generator'));
  });
});
