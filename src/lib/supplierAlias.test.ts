import { describe, expect, it } from 'vitest';
import { canonicalSupplier } from './supplierAlias';

describe('canonicalSupplier', () => {
  it('collapses the Grasim spellings from the purchase book', () => {
    const names = [
      'Grasim Industries Limited',
      'Grasim Industries Ltd',
      'Grasim Indudtries Limited',
      'Grassim Industries Limited',
      'Grasim Industrirs Ltd',
      'GRASIM INDUSTRIES LIMITED',
    ];
    const canon = names.map(canonicalSupplier);
    expect(new Set(canon).size).toBe(1);
    expect(canon[0]).toBe('Grasim Industries Ltd');
  });

  it('keeps Grasim Nagda as its own party', () => {
    expect(canonicalSupplier('Grasim Industries Nagda')).toBe('Grasim Industries Nagda');
  });

  it('joins the shortened Shriram name with the full one', () => {
    expect(canonicalSupplier('Shriram Vinyl & Chemical Ind.')).toBe(
      canonicalSupplier('Shriram Vinyl & Chemical Industries'),
    );
  });
});
