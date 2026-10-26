import { describe, it, expect } from 'vitest';
import { fetchAllRows, fetchByIds } from './fetchAll';

/** Fake paged table: rows 0..total-1, served in [from, to] slices. */
function table(total: number) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const data = Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i);
    return Promise.resolve({ data, error: null });
  };
  return { page, calls };
}

describe('fetchAllRows', () => {
  it('makes one request when the table fits in a page', async () => {
    const { page, calls } = table(40);
    const res = await fetchAllRows<number>(page);
    expect(res.data).toHaveLength(40);
    expect(res.truncated).toBe(false);
    expect(calls).toEqual([[0, 999]]);
  });

  it('returns every row in order past the 1000-row cap', async () => {
    const { page } = table(2471);
    const res = await fetchAllRows<number>(page);
    expect(res.data).toHaveLength(2471);
    expect(res.data.every((v, i) => v === i)).toBe(true);
    expect(res.truncated).toBe(false);
  });

  it('stops at the first short page even inside a parallel batch', async () => {
    const { page } = table(1500);
    const res = await fetchAllRows<number>(page);
    expect(res.data).toHaveLength(1500);
  });

  it('reports an error with the rows read so far', async () => {
    const page = (from: number) =>
      Promise.resolve(from === 0
        ? { data: Array.from({ length: 1000 }, (_, i) => i), error: null }
        : { data: null, error: { message: 'boom' } });
    const res = await fetchAllRows<number>(page);
    expect(res.error?.message).toBe('boom');
    expect(res.data).toHaveLength(1000);
    expect(res.truncated).toBe(true);
  });
});

describe('fetchByIds', () => {
  it('splits ids into URL-safe chunks and merges the results', async () => {
    const ids = Array.from({ length: 2471 }, (_, i) => `id-${i}`);
    const sizes: number[] = [];
    const res = await fetchByIds<string>(ids, chunk => {
      sizes.push(chunk.length);
      return Promise.resolve({ data: chunk, error: null });
    });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(150);
    expect(res.data).toHaveLength(2471);
    expect(res.error).toBeNull();
  });

  it('dedupes ids and surfaces a chunk error', async () => {
    const res = await fetchByIds<string>(['a', 'a', 'b'], chunk =>
      Promise.resolve({ data: null, error: { message: `bad ${chunk.length}` } }));
    expect(res.error?.message).toBe('bad 2');
  });
});
