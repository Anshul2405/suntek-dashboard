import { describe, it, expect } from 'vitest';
import { DEFAULT_BUYERS, isListedBuyer, personMatches } from './procurementPeople';

describe('purchaser list', () => {
  it('defaults to the agreed purchasers', () => {
    const names = DEFAULT_BUYERS.map(b => b.name);
    expect(names).toEqual(expect.arrayContaining(['Sagar sir', 'Sunil sir', 'Tiwari ji']));
  });

  it('matches a list name to a login, ignoring sir / ji', () => {
    expect(personMatches('Tiwari ji', 'Rakesh Tiwari')).toBe(true);
    expect(personMatches('Sagar sir', 'Sagar')).toBe(true);
    expect(personMatches('Sunil Kumar', 'Sunil')).toBe(false);
    expect(personMatches('Sagar sir', 'Ravi Shankar')).toBe(false);
    expect(personMatches('ji', 'Anyone')).toBe(false);
    expect(personMatches('', 'Anyone')).toBe(false);
  });

  it('a login is a purchaser when any list name matches', () => {
    expect(isListedBuyer(DEFAULT_BUYERS, 'Gandhi Mandal')).toBe(true);
    expect(isListedBuyer(DEFAULT_BUYERS, 'Vijay Kumar')).toBe(false);
  });
});
