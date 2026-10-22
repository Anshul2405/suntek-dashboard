import { describe, it, expect } from 'vitest';
import {
  isDateLikeActivity,
  isDateOnlyChecklist,
  equipmentMatchKey,
  pickReplacementChecklist,
} from './parseMaintenanceFile';

describe('isDateLikeActivity', () => {
  it('accepts the Ganjam Daily log dates', () => {
    expect(isDateLikeActivity('13.06.2026')).toBe(true);
    expect(isDateLikeActivity('24.06.2026')).toBe(true);
    expect(isDateLikeActivity('13/06/2026')).toBe(true);
    expect(isDateLikeActivity('45886')).toBe(true);
    expect(isDateLikeActivity(new Date('2026-06-13'))).toBe(true);
  });

  it('leaves real activities alone', () => {
    expect(isDateLikeActivity('OK/Leaking')).toBe(false);
    expect(isDateLikeActivity('To Be calculated')).toBe(false);
    expect(isDateLikeActivity('Working status / visual check')).toBe(false);
  });
});

describe('equipmentMatchKey', () => {
  it('treats Reactor - 01 and Reactor No.-01 as the same asset', () => {
    expect(equipmentMatchKey('Reactor - 01')).toBe(equipmentMatchKey('Reactor No.-01'));
    expect(equipmentMatchKey('Reactor - 01')).toBe('reactor1');
  });
});

describe('pickReplacementChecklist', () => {
  const monthly = [
    { component: 'Delta T', activity: 'To Be calculated' },
    { component: 'Gasket', activity: 'OK/Needs to change' },
  ];
  const dated = [
    { component: 'Reactor - 01', activity: '13.06.2026' },
    { component: 'Reactor - 01', activity: '14.06.2026' },
  ];

  it('swaps a date-only daily list for the monthly reactor checklist', () => {
    const picked = pickReplacementChecklist(
      { equipment: 'Reactor - 01', plant_id: 'g', checklist: dated },
      [
        { equipment: 'Reactor No.-01', plant_id: 'g', frequency: 'monthly', checklist: monthly },
        { equipment: 'Reactor - 01', plant_id: 'g', frequency: 'daily', checklist: dated },
      ],
    );
    expect(picked).toEqual(monthly);
  });

  it('does not rewrite a real checklist', () => {
    expect(pickReplacementChecklist(
      { equipment: 'Reactor No.-01', plant_id: 'g', checklist: monthly },
      [],
    )).toBeNull();
  });
});

describe('isDateOnlyChecklist', () => {
  it('is true when every activity is a calendar date', () => {
    expect(isDateOnlyChecklist([
      { activity: '13.06.2026' },
      { activity: '14.06.2026' },
    ])).toBe(true);
    expect(isDateOnlyChecklist([
      { activity: 'OK/Leaking' },
      { activity: '13.06.2026' },
    ])).toBe(false);
  });
});
