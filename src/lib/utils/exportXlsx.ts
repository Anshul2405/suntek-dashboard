/**
 * Role-based Excel export utility.
 *
 * Directors (admin) and Unit Heads receive fully editable .xlsx files.
 * All other roles receive sheet-protected .xlsx files (cells locked, password required to edit).
 *
 * Spec §3.2: "All Other Roles will receive read-only / password-protected .xlsx files
 * where the cell contents cannot be altered."
 */

import * as XLSX from 'xlsx';
import { isAdminProfile, type MockProfile } from '../profiles';
import { formatDateTime } from './formatting';

const PROTECTION_PASSWORD = 'suntek2024';

/** Roles that receive fully editable exports (no sheet protection). */
function isEditableRole(profile: MockProfile): boolean {
  return isAdminProfile(profile) || profile.id === 'unit_head' || profile.baseRoleId === 'unit_head';
}

export interface ExportColumn {
  header: string;
  key: string;
}

/**
 * Export an array of row objects to a .xlsx file download.
 *
 * @param rows      Array of plain objects (one per table row)
 * @param columns   Column definitions — { header, key } — controls order and labels
 * @param filename  Filename without extension (e.g. 'sales-contracts')
 * @param profile   Active user profile — drives sheet protection decision
 * @param sheetName Optional worksheet name (default: 'Data')
 */
export function exportToXlsx(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename: string,
  profile: MockProfile,
  sheetName = 'Data',
): void {
  // Build array-of-arrays: header row + data rows
  const header = columns.map((c) => c.header);
  const data = rows.map((row) => columns.map((c) => row[c.key] ?? ''));

  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);

  // Style header row bold (SheetJS CE supports basic cell styles via `!cols`)
  const colWidths = columns.map((c) => ({
    wch: Math.max(c.header.length + 2, 12),
  }));
  ws['!cols'] = colWidths;

  // Apply sheet protection for non-admin/non-unit-head roles
  if (!isEditableRole(profile)) {
    (ws as any)['!protect'] = {
      password: PROTECTION_PASSWORD,
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatCells: false,
      formatColumns: false,
      formatRows: false,
      insertColumns: false,
      insertRows: false,
      deleteColumns: false,
      deleteRows: false,
      sort: false,
      autoFilter: false,
    };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // Add a metadata sheet noting the protection status
  const metaWs = XLSX.utils.aoa_to_sheet([
    ['Exported by', profile.name],
    ['Role', profile.roleLabel],
    ['Plant', profile.plant ?? 'All'],
    ['Protected', isEditableRole(profile) ? 'No' : 'Yes'],
    ['Exported at', formatDateTime(new Date())],
  ]);
  XLSX.utils.book_append_sheet(wb, metaWs, 'Export Info');

  XLSX.writeFile(wb, `${filename}.xlsx`);
}
