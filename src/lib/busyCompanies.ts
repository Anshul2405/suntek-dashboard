// Current-year Busy companies. Chlorides already includes Delhi, Ganjam and Rehla.
export const BUSY_COMPANIES = [
  { code: '0007', name: 'Suntek Chlorides', short: 'Chlorides' },
  { code: '0009', name: 'Suntek Plasticizer', short: 'Plasticizer' },
  { code: '0010', name: 'NKG Plastochem', short: 'NKG' },
  { code: '0012', name: 'Madan Chemicals', short: 'Madan' },
] as const;

export type BusyCompanyCode = 'all' | (typeof BUSY_COMPANIES)[number]['code'];

const STORAGE_KEY = 'suntek-busy-company';

export function isBusyCompanyCode(value: string | null): value is BusyCompanyCode {
  return value === 'all' || BUSY_COMPANIES.some((c) => c.code === value);
}

export function readBusyCompany(): BusyCompanyCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isBusyCompanyCode(saved)) return saved;
  } catch {
    /* Private mode. All companies is the default. */
  }
  return 'all';
}

export function writeBusyCompany(code: BusyCompanyCode) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* Ignore a blocked write. The in-memory choice still applies. */
  }
}

export function companyPath(path: string, code: string): string {
  return path.includes('?') ? `${path}&company=${code}` : `${path}?company=${code}`;
}

export function companyShort(code: string): string {
  return BUSY_COMPANIES.find((c) => c.code === code)?.short ?? code;
}
