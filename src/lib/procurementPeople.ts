import { supabase } from './supabase';

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

const q = (name: string) => (supabase as unknown as { from: (t: string) => any }).from(name);

export async function loadBuyers(): Promise<BuyerPerson[]> {
  const { data } = await q('ops_settings').select('value').eq('key', 'procurement_people').maybeSingle();
  const people = data?.value?.people;
  if (!Array.isArray(people) || people.length === 0) return DEFAULT_BUYERS;
  return people
    .filter((p: BuyerPerson) => p && typeof p.name === 'string' && p.name.trim())
    .map((p: BuyerPerson) => ({
      name: p.name.trim(),
      type: BUYER_TYPES.includes(p.type) ? p.type : 'Purchase',
    }));
}

export async function saveBuyers(people: BuyerPerson[], updatedBy: string): Promise<string | null> {
  const cleaned = people.filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), type: p.type }));
  const { error } = await q('ops_settings').upsert({
    key: 'procurement_people',
    value: { people: cleaned },
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  }, { onConflict: 'key' });
  return error?.message ?? null;
}
