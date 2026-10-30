/**
 * Indian vehicle registration numbers — the only formats a plant form accepts.
 * Spaces and hyphens are ignored; the stored value is compact upper-case.
 *
 *   State series  AA 0(0) A(AA) 0000   UP13ET7451 · DL1CAB1234 · MH12A1234
 *   Bharat series 00 BH 0000 A(A)      22BH1234AB
 */
const STATE_SERIES = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/;
const BHARAT_SERIES = /^\d{2}BH\d{4}[A-Z]{1,2}$/;

export function compactVehicleNo(raw: string | null | undefined): string {
  return (raw || '').toUpperCase().replace(/[\s.-]+/g, '');
}

export function isValidVehicleNo(raw: string | null | undefined): boolean {
  const v = compactVehicleNo(raw);
  return STATE_SERIES.test(v) || BHARAT_SERIES.test(v);
}

/**
 * For a save: '' when the box is empty (only where the field is optional),
 * the compact number when valid, or null when something was typed that is not
 * an Indian number.
 */
export function vehicleNoForSave(raw: string | null | undefined): string | null {
  const v = compactVehicleNo(raw);
  if (!v) return '';
  return isValidVehicleNo(v) ? v : null;
}
