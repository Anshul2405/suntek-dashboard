import aliases from './supplierAliases.json';

const TYPOS: Array<[string, string]> = [
  ['indudtries', 'industries'],
  ['industrirs', 'industries'],
  ['indusries', 'industries'],
  ['grassim', 'grasim'],
  ['industris', 'industries'],
];

/** Same key the purchase-book builder uses, so Busy spellings land on one name. */
export function supplierFingerprint(name: string): string {
  let s = name.toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  for (const [src, dst] of TYPOS) {
    s = s.replace(new RegExp(`\\b${src}\\b`, 'g'), dst);
  }
  s = s.replace(/\b(private|pvt|limited|ltd)\b/g, ' ');
  s = s.replace(/\bind\b/g, 'industries');
  return s.replace(/\s+/g, ' ').trim();
}

const MAP = aliases as Record<string, string>;

export function canonicalSupplier(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  if (!cleaned) return '';
  return MAP[supplierFingerprint(cleaned)] ?? cleaned;
}
