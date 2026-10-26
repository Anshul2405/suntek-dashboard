/**
 * One display name for a plant or store, on every screen.
 * Stock used "Sikandrabad" and "Rehla Common Store" while the rest of the
 * dashboard used the factory names. The common Rehla store is SCPL/SPPL store.
 * Sikandrabad is Madan. Factory names stay distinct from that shared store.
 */
export function displayLocationName(name: string | null | undefined): string {
  const raw = (name || '').trim();
  if (!raw) return '';
  const n = raw.toLowerCase().replace(/\s+/g, ' ');
  if (/sikand/.test(n) || n === 'madan' || /^madan\b/.test(n)) return 'Madan';
  if (/drum/.test(n)) return 'Drum Plant';
  if (/ganjam/.test(n)) return /scpl|chloride/.test(n) ? 'SCPL – Ganjam' : 'Ganjam';
  if (/delhi/.test(n)) return /scpl|chloride/.test(n) ? 'SCPL – Delhi' : 'Delhi';
  if ((/store|common|shared/.test(n) && /rehla/.test(n)) || n === 'rehla' || n === 'rehla store') {
    return 'SCPL/SPPL store';
  }
  if (/scpl|chloride/.test(n) && /rehla/.test(n)) return 'SCPL – Rehla';
  // SPPL(K) contains "sppl", so it has to be named before the plain SPPL rule.
  if (/sppl\s*\(\s*k\s*\)|spplk|\bsppl\s+k\b|plastic\w*\s*\(\s*k\s*\)/.test(n) && /rehla/.test(n)) return 'SPPL(K) – Rehla';
  if (/sppl|plastic/.test(n) && /rehla/.test(n)) return 'SPPL – Rehla';
  if (n === 'shd') return 'SHD';
  if (n === 'hq') return 'HQ';
  return raw;
}
