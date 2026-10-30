import { describe, it, expect } from 'vitest';
import { compactVehicleNo, isValidVehicleNo, vehicleNoForSave } from './vehicleNo';
import { isValidIfsc, normalizeIfsc } from './ifsc';

describe('Indian vehicle numbers', () => {
  it('accepts the state series with spaces / hyphens ignored', () => {
    for (const v of ['UP13ET7451', 'up 13 et 7451', 'DL1CAB1234', 'DL-1C-AB-1234', 'MH12A1234', 'OD02AB1234', 'JH05AAA0001']) {
      expect(isValidVehicleNo(v)).toBe(true);
    }
    expect(compactVehicleNo('up 13-et 7451')).toBe('UP13ET7451');
    expect(isValidVehicleNo('DL 1C AB 1234')).toBe(true);
    expect(compactVehicleNo('DL 1C AB 1234')).toBe('DL1CAB1234');
  });

  it('accepts the Bharat series', () => {
    expect(isValidVehicleNo('22BH1234AB')).toBe(true);
    expect(isValidVehicleNo('22 BH 1234 A')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const v of ['UP13ET745', 'UP13ET74512', '1234', 'TRUCK 5', 'UP1312345', 'U13ET7451', '22BH123AB', 'UP13ETAB7451']) {
      expect(isValidVehicleNo(v)).toBe(false);
    }
  });

  it('save value: empty stays empty, valid is compact, junk is refused', () => {
    expect(vehicleNoForSave('  ')).toBe('');
    expect(vehicleNoForSave('up13 et 7451')).toBe('UP13ET7451');
    expect(vehicleNoForSave('truck')).toBe(null);
  });
});

describe('IFSC', () => {
  it('is 11 characters with 0 in the 5th place', () => {
    expect(isValidIfsc('UTIB0000123')).toBe(true);
    expect(isValidIfsc('sbin 0001234')).toBe(true);
    expect(normalizeIfsc('sbin 0001234')).toBe('SBIN0001234');
    expect(isValidIfsc('UTIB1000123')).toBe(false);
    expect(isValidIfsc('UTIB000123')).toBe(false);
    expect(isValidIfsc('')).toBe(false);
  });
});
