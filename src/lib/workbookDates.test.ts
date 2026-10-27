import { describe, it, expect } from 'vitest';
import { isBogusWorkbookDate, sortWorkbookRows, workbookDateLabel, workbookMaxYear } from './workbookDates';

const TODAY = '2026-10-27';

describe('workbook dates', () => {
  it('the believable range is 2020 to the current FY + 1', () => {
    expect(workbookMaxYear(TODAY)).toBe(2027);
    expect(workbookMaxYear('2027-02-10')).toBe(2027); // still FY 2026-27
    expect(isBogusWorkbookDate('15.01.2027', TODAY)).toBe(false);
    expect(isBogusWorkbookDate('24.04.2036', TODAY)).toBe(true);
    expect(isBogusWorkbookDate('29.08.2029', TODAY)).toBe(true);
    expect(isBogusWorkbookDate('01.04.2019', TODAY)).toBe(true);
    expect(isBogusWorkbookDate('25.09', TODAY)).toBe(false);
    expect(isBogusWorkbookDate('', TODAY)).toBe(false);
    expect(isBogusWorkbookDate('16.054.2026', TODAY)).toBe(true);
    expect(isBogusWorkbookDate('15.09.206', TODAY)).toBe(true);
    expect(isBogusWorkbookDate('31.13.2026', TODAY)).toBe(true);
    expect(isBogusWorkbookDate('Pipe Lines', TODAY)).toBe(false);
  });

  it('sorts valid dates newest first and typos to the bottom, ties in sheet order', () => {
    const rows = [
      { id: 'sep', date: '12.09.2026' },
      { id: 'y2036', date: '24.04.2036' },
      { id: 'oct', date: '22.10.2026' },
      { id: 'none', date: '' },
      { id: 'y2029', date: '29.08.2029' },
      { id: 'oct-b', date: '22.10.2026' },
    ];
    expect(sortWorkbookRows(rows, 'date', TODAY).map(r => r.id)).toEqual(['oct', 'oct-b', 'sep', 'none', 'y2036', 'y2029']);
  });

  it('still shows the typed date so the typo is visible', () => {
    expect(workbookDateLabel('24.04.2036')).toBe('24/04/2036');
    expect(workbookDateLabel('22.10.2026')).toBe('22/10/2026');
    expect(workbookDateLabel('25.09')).toBe('25.09');
  });
});
