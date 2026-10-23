// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { expandFarUnits, packedUnitMarks } from './packedMarks';

const alfa = {
  id: 'far-alfa',
  name: 'HCL Circulation Pump- ALFA (HCP-04, HCP-05, HCP-06, HCP-07, HCP-08, HCP-09, HCP-10)',
  identification_mark: null as string | null,
};

describe('packed FAR heads', () => {
  it('splits comma-separated pump tags in the name', () => {
    expect(packedUnitMarks(alfa)).toEqual(['HCP-04', 'HCP-05', 'HCP-06', 'HCP-07', 'HCP-08', 'HCP-09', 'HCP-10']);
    const units = expandFarUnits([alfa]);
    expect(units).toHaveLength(7);
    expect(units[0].id).toBe('far-alfa');
    expect(units[0].name).toBe('HCL Circulation Pump- ALFA');
    expect(units.map(u => u.identification_mark)).toContain('HCP-04');
  });

  it('leaves a single Cooling Tower (CT 1) as one row', () => {
    const ct = { id: '1', name: 'Cooling Tower (CT 1)', identification_mark: 'CT 1' };
    expect(expandFarUnits([ct])).toEqual([ct]);
  });

  it('does not split prose in parentheses', () => {
    const row = { id: '2', name: 'Lighting (150W flood, grease)', identification_mark: null };
    expect(expandFarUnits([row])).toEqual([row]);
  });

  it('splits tags stored on identification_mark', () => {
    const row = { id: '3', name: 'HCL Circulation Pump- ALFA', identification_mark: 'HCP-04, HCP-05' };
    expect(expandFarUnits([row]).map(u => u.identification_mark)).toEqual(['HCP-04', 'HCP-05']);
  });
});
