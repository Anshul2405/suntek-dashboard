/** IFSC: 11 characters — 4 letters (bank), 0, 6 letters/digits (branch). Stored upper-case. */
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function normalizeIfsc(raw: string | null | undefined): string {
  return (raw || '').toUpperCase().replace(/\s+/g, '');
}

export function isValidIfsc(raw: string | null | undefined): boolean {
  return IFSC.test(normalizeIfsc(raw));
}
