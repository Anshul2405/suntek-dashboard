import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const aliases = JSON.parse(readFileSync(join(__dirname, '../../src/lib/supplierAliases.json'), 'utf8'));

const TYPOS = [
  ['indudtries', 'industries'],
  ['industrirs', 'industries'],
  ['indusries', 'industries'],
  ['grassim', 'grasim'],
  ['industris', 'industries'],
];

function fingerprint(name) {
  let s = name.toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  for (const [src, dst] of TYPOS) {
    s = s.replace(new RegExp(`\\b${src}\\b`, 'g'), dst);
  }
  s = s.replace(/\b(private|pvt|limited|ltd)\b/g, ' ');
  s = s.replace(/\bind\b/g, 'industries');
  return s.replace(/\s+/g, ' ').trim();
}

/** Fold a Busy ledger spelling onto the name used in the purchase book. */
export function canonicalSupplier(name) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  if (!cleaned) return '';
  return aliases[fingerprint(cleaned)] || cleaned;
}
