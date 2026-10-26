// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { coaLetterheadForPlant } from './coaLetterhead';

describe('coaLetterheadForPlant', () => {
  it('keeps the Rehla plasticizer letterhead, and switches the others', () => {
    expect(coaLetterheadForPlant('SPPL – Rehla').lines.join(' ')).toContain('822124');
    expect(coaLetterheadForPlant('SCPL – Ganjam').company).toContain('CHLORIDES');
    expect(coaLetterheadForPlant('SCPL – Ganjam').lines.join(' ')).not.toContain('822124');
    expect(coaLetterheadForPlant('Madan').company).toContain('MADAN');
    expect(coaLetterheadForPlant('Sikandrabad').lines.join(' ')).toContain('Uttar Pradesh');
  });
});
