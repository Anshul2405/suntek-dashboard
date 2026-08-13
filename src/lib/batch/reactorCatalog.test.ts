import { describe, it, expect } from 'vitest';
import {
  isBatchSheetPlant,
  reactorRangeForPlant,
  catalogReactorsForPlant,
  preferCatalogIfDbStale,
  formatReactorBatchNo,
  parseReactorBatchSeq,
  isProductionSheetBatchNo,
} from './reactorCatalog';

describe('reactorCatalog', () => {
  it('excludes Drum Plant', () => {
    expect(isBatchSheetPlant({ id: '1', factory_code: 'DRUM_REHLA', name: 'Drum Plant – SCPL Rehla' })).toBe(false);
    expect(isBatchSheetPlant({ id: '1', name: 'Drum Plant – SCPL Rehla' })).toBe(false);
  });

  it('maps factory codes to P ranges', () => {
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SCPL_REHLA' })).toEqual({ from: 1, to: 12 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SPPL_REHLA' })).toEqual({ from: 13, to: 27 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SPPLK_REHLA' })).toEqual({ from: 28, to: 32 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'MADAN_SIKANDRABAD' })).toEqual({ from: 33, to: 43 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SCPL_GANJAM' })).toEqual({ from: 44, to: 49 });
  });

  it('builds P1–P12 for SCPL Rehla', () => {
    const rows = catalogReactorsForPlant({ id: 'pid', factory_code: 'SCPL_REHLA' });
    expect(rows).toHaveLength(12);
    expect(rows[0].code).toBe('P1');
    expect(rows[11].code).toBe('P12');
  });

  it('replaces stale R-1…R-6 DB rows with the catalogue', () => {
    const { rows, usingCatalog } = preferCatalogIfDbStale(
      { id: 'pid', factory_code: 'SPPLK_REHLA' },
      [{ id: 'x', code: 'R-1', name: 'Reactor 1', sort_order: 1 }],
    );
    expect(usingCatalog).toBe(true);
    expect(rows.map((r) => r.code)).toEqual(['P28', 'P29', 'P30', 'P31', 'P32']);
  });

  it('formats and parses reactor batch numbers (P12-13)', () => {
    expect(formatReactorBatchNo('P12', 13)).toBe('P12-13');
    expect(formatReactorBatchNo('P34', 103)).toBe('P34-103');
    expect(parseReactorBatchSeq('P12-13', 'P12')).toBe(13);
    expect(parseReactorBatchSeq('P34-103')).toBe(103);
    expect(isProductionSheetBatchNo('P12-13')).toBe(true);
    expect(isProductionSheetBatchNo('PBS-12345678')).toBe(true);
  });
});
