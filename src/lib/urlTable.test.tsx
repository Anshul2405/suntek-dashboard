import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { useUrlTable } from './urlTable';
import { usePagination } from '../components/ui/usePagination';
import { useSortable } from '../components/ui/useSortable';

const rows = Array.from({ length: 35 }, (_, i) => ({ n: i }));

function useList(ready: boolean) {
  const url = useUrlTable({ key: 'n', dir: 'asc' });
  const s = useSortable(rows, { n: r => r.n }, url.sort, url.onSort);
  const pg = usePagination(ready ? s.sorted : s.sorted.slice(0, 3), { resetKey: `${s.sort.key}|${s.sort.dir}`, ...url.paging, ready });
  const loc = useLocation();
  return { pg, s, search: loc.search };
}

// BrowserRouter, like the app: patchUrlParams reads the live window URL.
const wrap = (entry: string) => {
  window.history.replaceState(null, '', entry);
  return ({ children }: { children: React.ReactNode }) => <BrowserRouter>{children}</BrowserRouter>;
};

describe('list page / sort in the URL (Back keeps them)', () => {
  it('writes page and sort, and a fresh mount on that URL restores them', () => {
    const first = renderHook(() => useList(true), { wrapper: wrap('/dashboard/x?q=pump') });
    act(() => first.result.current.s.onSort('n', 'asc')); // flip to desc
    act(() => first.result.current.pg.controls.setPage(3));
    const url = first.result.current.search;
    expect(url).toContain('p=3');
    expect(url).toContain('sort=n');
    expect(url).toContain('dir=desc');
    expect(url).toContain('q=pump');

    // "Back": the list mounts again on that URL while rows are still loading.
    first.unmount();
    window.history.replaceState(null, '', '/dashboard/other');
    const back = renderHook(({ ready }) => useList(ready), { wrapper: wrap(`/dashboard/x${url}`), initialProps: { ready: false } });
    back.rerender({ ready: true });
    expect(back.result.current.pg.controls.page).toBe(3);
    expect(back.result.current.s.sort).toEqual({ key: 'n', dir: 'desc' });
    expect(back.result.current.pg.pageRows[0]).toEqual({ n: 14 });
  });
});
