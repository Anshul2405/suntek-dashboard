import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * The purchaser list — who buys a part once Vijay ji approves it.
 *
 * Stored in ops_settings under key `procurement_people` and edited in
 * Access & backup (same pattern as the photo-hide list). People are matched to
 * a login by name, not by a hard-coded account, so the list can change without
 * a release.
 */
export type BuyerType = 'Purchase' | 'Management' | 'Accounts' | 'Store';

export interface BuyerPerson {
  name: string;
  type: BuyerType;
}

export const BUYER_TYPES: BuyerType[] = ['Purchase', 'Management', 'Accounts', 'Store'];

export const DEFAULT_BUYERS: BuyerPerson[] = [
  { name: 'Sagar sir', type: 'Purchase' },
  { name: 'Sunil sir', type: 'Purchase' },
  { name: 'Gandhi ji', type: 'Purchase' },
  { name: 'Robin ji', type: 'Purchase' },
  { name: 'Tiwari ji', type: 'Purchase' },
];

// ops_settings is not in the generated Database type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (name: string) => (supabase as unknown as { from: (t: string) => any }).from(name);

function clean(raw: unknown): BuyerPerson[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const people = raw
    .filter((p: BuyerPerson) => p && typeof p.name === 'string' && p.name.trim())
    .map((p: BuyerPerson) => ({
      name: p.name.trim(),
      type: BUYER_TYPES.includes(p.type) ? p.type : 'Purchase' as BuyerType,
    }));
  return people.length ? people : null;
}

let cache: BuyerPerson[] = DEFAULT_BUYERS;
const listeners = new Set<() => void>();

export async function loadBuyers(): Promise<BuyerPerson[]> {
  try {
    const { data } = await q('ops_settings').select('value').eq('key', 'procurement_people').maybeSingle();
    cache = clean(data?.value?.people) ?? DEFAULT_BUYERS;
  } catch { /* keep the last list */ }
  listeners.forEach(fn => fn());
  return cache;
}

export async function saveBuyers(people: BuyerPerson[], updatedBy: string): Promise<string | null> {
  const cleaned = people.filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), type: p.type }));
  const { error } = await q('ops_settings').upsert({
    key: 'procurement_people',
    value: { people: cleaned },
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  }, { onConflict: 'key' });
  if (!error) {
    cache = cleaned.length ? cleaned : DEFAULT_BUYERS;
    listeners.forEach(fn => fn());
  }
  return error?.message ?? null;
}

/** The purchaser list (defaults until the saved list loads). */
export function useBuyers(): BuyerPerson[] {
  const [value, setValue] = useState(cache);
  useEffect(() => {
    const fn = () => setValue(cache);
    listeners.add(fn);
    void loadBuyers();
    return () => { listeners.delete(fn); };
  }, []);
  return value;
}

const HONORIFICS = new Set(['sir', 'ji', 'sahab', 'saheb', 'mr', 'shri', 'sh', 'madam', 'mam']);

function words(s: string | null | undefined): string[] {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')
    .filter(w => w && !HONORIFICS.has(w));
}

/**
 * Does a list name ("Tiwari ji") mean this login ("Rakesh Tiwari")? Every word
 * of the list name, honorifics dropped, must be a word of the login name.
 */
export function personMatches(listName: string | null | undefined, profileName: string | null | undefined): boolean {
  const want = words(listName);
  if (!want.length) return false;
  const have = new Set(words(profileName));
  return want.every(w => have.has(w));
}

/** Is this login one of the purchasers? */
export function isListedBuyer(people: BuyerPerson[], profileName: string | null | undefined): boolean {
  return people.some(p => personMatches(p.name, profileName));
}
