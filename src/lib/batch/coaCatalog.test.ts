import { describe, it, expect } from 'vitest';
import { coaParamsForGravity, resolveCoaGravity } from './coaCatalog';

describe('resolveCoaGravity', () => {
  it('uses batch density when oil ratio is a free-text label', () => {
    expect(resolveCoaGravity(1300, 'c10(dummy)')).toBe(1300);
  });

  it('prefers numeric oil ratio when present', () => {
    expect(resolveCoaGravity(1200, '1400')).toBe(1400);
  });
});

describe('coaParamsForGravity', () => {
  it('uses A2 / 1.3 standard for density 1300 NP', () => {
    const params = coaParamsForGravity(1300, 'NP');
    const sg = params.find((p) => p.key === 'specific_gravity');
    expect(sg?.standard).toBe('1.3 ± 0.02');
  });

  it('uses A1 / 1.2 standard for density 1200 NP', () => {
    const params = coaParamsForGravity(1200, 'NP');
    const sg = params.find((p) => p.key === 'specific_gravity');
    expect(sg?.standard).toBe('1.2 ± 0.02');
    const visc = params.find((p) => p.key === 'viscosity_35c');
    expect(visc?.standard).toBe('1 - 5');
    const ri = params.find((p) => p.key === 'refractive_index');
    expect(ri?.standard).toBe('>1.49');
  });
});
