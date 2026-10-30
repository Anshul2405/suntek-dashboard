/** Collapse spelling variants so "Disel Generator" matches "Diesel Generator". */
export function canonEquipName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/disel/g, 'diesel')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The same name as typed, with the "Disel" misspelling shown as "Diesel". */
export function displayEquipName(name: string | null | undefined): string {
  return (name || '').replace(/\bdisel/gi, m => (m[0] === 'D' ? 'Diesel' : 'diesel'));
}

/** Lower-case text for search, with spelling variants folded (disel → diesel). */
export function searchFold(text: string | null | undefined): string {
  return (text || '').toLowerCase().replace(/disel/g, 'diesel');
}
