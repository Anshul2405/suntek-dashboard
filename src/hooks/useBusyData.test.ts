// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];
let feedDown = false;
const rows: Record<string, unknown> = {
  '/api/kpis/overview?company=0007': { salesMTD: 100, purchaseMTD: 40 },
  '/api/kpis/overview?company=0009': { salesMTD: 10, purchaseMTD: 4 },
  '/api/kpis/overview?company=0010': { salesMTD: 1, purchaseMTD: 0.4 },
  '/api/kpis/overview?company=0012': { salesMTD: 5, purchaseMTD: 2 },
  '/api/purchases/recent?company=0007': [{ date: '2026-10-15', supplier: 'A', amount: 5 }],
  // server/lib/fallback.js spreads the saved list into an object and marks it.
  '/api/purchases/recent?company=0009': { 0: { date: '2026-09-01', supplier: 'Old', amount: 1 }, _fallback: true },
};

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: async (_col: string, paths: string[]) => {
          calls.push(paths);
          if (feedDown) return { data: null, error: new Error('down') };
          return {
            data: paths.filter((p) => p in rows).map((p) => ({ path: p, payload: rows[p], updated_at: '' })),
            error: null,
          };
        },
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  },
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const { fetchBusy, forgetBusyFeedCache } = await import('./useBusyData');

describe('Busy feed loader', () => {
  beforeEach(() => {
    calls.length = 0;
    feedDown = false;
    forgetBusyFeedCache();
  });

  it('asks the feed once for screens opened together', async () => {
    const [overview, purchases] = await Promise.all([
      fetchBusy<{ salesMTD: number }>('/api/kpis/overview', 'all'),
      fetchBusy<unknown[]>('/api/purchases/recent', 'all'),
    ]);
    expect(overview.salesMTD).toBe(116);
    expect(purchases).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(8);
  });

  it('serves a repeat read from memory', async () => {
    await fetchBusy('/api/kpis/overview', '0007');
    await fetchBusy('/api/kpis/overview', '0007');
    expect(calls).toHaveLength(1);
  });

  it('skips fallback copies the reader serves when SQL is down', async () => {
    await expect(fetchBusy('/api/purchases/recent', '0009')).rejects.toThrow('not connected');
  });

  it('keeps the last good read when the feed is down', async () => {
    const first = await fetchBusy<{ salesMTD: number }>('/api/kpis/overview', '0009');
    forgetBusyFeedCache();
    feedDown = true;
    const again = await fetchBusy<{ salesMTD: number }>('/api/kpis/overview', '0009');
    expect(again).toEqual(first);
  });
});
