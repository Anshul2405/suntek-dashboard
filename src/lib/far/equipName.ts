/** Collapse spelling variants so "Disel Generator" matches "Diesel Generator". */
export function canonEquipName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/disel/g, 'diesel')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
