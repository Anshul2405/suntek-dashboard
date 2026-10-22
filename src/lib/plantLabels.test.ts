// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { displayLocationName } from './plantLabels';

describe('displayLocationName', () => {
  it('names the Rehla common store and Sikandrabad the same way everywhere', () => {
    expect(displayLocationName('Rehla Common Store')).toBe('SCPL/SPPL store');
    expect(displayLocationName('Sikandrabad')).toBe('Madan');
    expect(displayLocationName('Sikandrabad Store')).toBe('Madan');
    expect(displayLocationName('Sikandarabad Store')).toBe('Madan');
    expect(displayLocationName('Drum Plant Store')).toBe('Drum Plant');
    expect(displayLocationName('Ganjam Store')).toBe('Ganjam');
  });

  it('keeps the Rehla factories distinct from the shared store', () => {
    expect(displayLocationName('SCPL – Rehla')).toBe('SCPL – Rehla');
    expect(displayLocationName('SPPL – Rehla')).toBe('SPPL – Rehla');
    expect(displayLocationName('SPPL(K) – Rehla')).toBe('SPPL(K) – Rehla');
    expect(displayLocationName('SPPL (K) Rehla')).toBe('SPPL(K) – Rehla');
    expect(displayLocationName('SPPLK – Rehla')).toBe('SPPL(K) – Rehla');
    expect(displayLocationName('Drum Plant')).toBe('Drum Plant');
    expect(displayLocationName('SCPL – Ganjam')).toBe('SCPL – Ganjam');
  });
});
