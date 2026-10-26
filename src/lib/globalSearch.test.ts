import { describe, expect, it } from 'vitest';
import { ticketIdMatches } from './globalSearch';

describe('ticketIdMatches', () => {
  const id = '1ede4e33-9abc-4def-8012-3456789abcde';

  it('matches the 8-char ticket # shown on the list', () => {
    expect(ticketIdMatches(id, '1ede')).toBe(true);
    expect(ticketIdMatches(id, '1ede4e33')).toBe(true);
    expect(ticketIdMatches(id, '1EDE4E')).toBe(true);
  });

  it('matches without dashes', () => {
    expect(ticketIdMatches(id, '1ede4e339abc')).toBe(true);
  });

  it('does not match a different ticket', () => {
    expect(ticketIdMatches(id, 'c91b76')).toBe(false);
    expect(ticketIdMatches(id, 'acid')).toBe(false);
  });
});
