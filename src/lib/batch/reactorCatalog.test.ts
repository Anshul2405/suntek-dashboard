// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isBatchSheetPlant,
  reactorRangeForPlant,
  catalogReactorsForPlant,
  preferCatalogIfDbStale,
  formatReactorBatchNo,
  parseReactorBatchSeq,
  isProductionSheetBatchNo,
  isValidReactorBatchNo,
  reactorBatchPrefix,
  missingReactorBatches,
  describeMissingSheets,
  describeMissingRanges,
} from './reactorCatalog';

describe('reactorCatalog', () => {
  it('excludes Drum Plant', () => {
    expect(isBatchSheetPlant({ id: '1', factory_code: 'DRUM_REHLA', name: 'Drum Plant – SCPL Rehla' })).toBe(false);
    expect(isBatchSheetPlant({ id: '1', name: 'Drum Plant – SCPL Rehla' })).toBe(false);
  });

  it('maps factory codes to P ranges', () => {
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SCPL_REHLA' })).toEqual({ from: 1, to: 12 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SPPL_REHLA' })).toEqual({ from: 13, to: 28 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SPPLK_REHLA' })).toEqual({ from: 29, to: 32 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'MADAN_SIKANDRABAD' })).toEqual({ from: 33, to: 43 });
    expect(reactorRangeForPlant({ id: 'a', factory_code: 'SCPL_GANJAM' })).toEqual({ from: 44, to: 49 });
  });

  it('builds P1–P12 for SCPL Rehla', () => {
    const rows = catalogReactorsForPlant({ id: 'pid', factory_code: 'SCPL_REHLA' });
    expect(rows).toHaveLength(12);
    expect(rows[0].code).toBe('P1');
    expect(rows[0].name).toBe('Reactor 1(P1)');
    expect(rows[11].code).toBe('P12');
    expect(rows[11].name).toBe('Reactor 12(P12)');
  });

  it('names Madan reactors as Reactor 1(P33) … Reactor 11(P43)', () => {
    const rows = catalogReactorsForPlant({ id: 'pid', factory_code: 'MADAN_SIKANDRABAD' });
    expect(rows).toHaveLength(11);
    expect(rows[0]).toMatchObject({ code: 'P33', name: 'Reactor 1(P33)' });
    expect(rows[10]).toMatchObject({ code: 'P43', name: 'Reactor 11(P43)' });
  });

  it('names Ganjam reactors as Reactor 1(P44) … Reactor 6(P49)', () => {
    const rows = catalogReactorsForPlant({ id: 'pid', factory_code: 'SCPL_GANJAM' });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ code: 'P44', name: 'Reactor 1(P44)' });
    expect(rows[5]).toMatchObject({ code: 'P49', name: 'Reactor 6(P49)' });
  });

  it('relabels official DB rows to plant-local names', () => {
    const { rows, usingCatalog } = preferCatalogIfDbStale(
      { id: 'pid', factory_code: 'MADAN_SIKANDRABAD' },
      [{ id: 'x', code: 'P33', name: 'Reactor P33', sort_order: 33 }],
    );
    expect(usingCatalog).toBe(false);
    expect(rows[0].name).toBe('Reactor 1(P33)');
  });

  it('replaces stale R-1…R-6 DB rows with the catalogue', () => {
    const { rows, usingCatalog } = preferCatalogIfDbStale(
      { id: 'pid', factory_code: 'SPPLK_REHLA' },
      [{ id: 'x', code: 'R-1', name: 'Reactor 1', sort_order: 1 }],
    );
    expect(usingCatalog).toBe(true);
    expect(rows.map((r) => r.code)).toEqual(['P29', 'P30', 'P31', 'P32']);
    expect(rows[0].name).toBe('Reactor 1(P29)');
  });

  it('names SPPL Rehla as Reactor 1(P13) … Reactor 16(P28)', () => {
    const rows = catalogReactorsForPlant({ id: 'pid', factory_code: 'SPPL_REHLA' });
    expect(rows).toHaveLength(16);
    expect(rows[0]).toMatchObject({ code: 'P13', name: 'Reactor 1(P13)' });
    expect(rows[15]).toMatchObject({ code: 'P28', name: 'Reactor 16(P28)' });
  });

  it('formats and parses reactor batch numbers (P12-13)', () => {
    expect(formatReactorBatchNo('P12', 13)).toBe('P12-13');
    expect(formatReactorBatchNo('P34', 103)).toBe('P34-103');
    expect(parseReactorBatchSeq('P12-13', 'P12')).toBe(13);
    expect(parseReactorBatchSeq('P34-103')).toBe(103);
    expect(isProductionSheetBatchNo('P12-13')).toBe(true);
    expect(isProductionSheetBatchNo('PBS-12345678')).toBe(true);
  });

  it('flags the batch numbers skipped between the first and the latest sheet', () => {
    const gaps = missingReactorBatches(['P12-01', 'P12-09', 'P13-1', 'P13-2']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].code).toBe('P12');
    expect(gaps[0].missing).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(describeMissingSheets(gaps[0])).toBe('P12-02 to P12-08');
    expect(describeMissingRanges(gaps[0])).toBe('02–08');
  });

  it('validates reactor batch number format', () => {
    expect(reactorBatchPrefix('P33')).toBe('P33-');
    expect(isValidReactorBatchNo('P33-04', 'P33')).toBe(true);
    expect(isValidReactorBatchNo('P12-13', 'P12')).toBe(true);
    expect(isValidReactorBatchNo('P33-', 'P33')).toBe(false);
    expect(isValidReactorBatchNo('P33-04', 'P34')).toBe(false);
    expect(isValidReactorBatchNo('P1106', 'P33')).toBe(false);
    expect(isValidReactorBatchNo('P33-04A', 'P33')).toBe(false);
  });
});
