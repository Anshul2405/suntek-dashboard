import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePagination } from './usePagination';

describe('usePagination restored page', () => {
  it('does not clamp a restored page to 1 while the list is still filling', () => {
    const first = { rows: ['a', 'b', 'c'] as string[], ready: false, initialPage: 3 };
    const { result, rerender } = renderHook(
      (props: { rows: string[]; ready: boolean; initialPage: number }) =>
        usePagination(props.rows, { initialPage: props.initialPage, ready: props.ready }),
      { initialProps: first },
    );

    // Manuals-only: 3 rows, 1 page. Internal page must stay 3 until tickets arrive.
    expect(result.current.controls.page).toBe(1); // displayed, list too short
    rerender({
      rows: Array.from({ length: 35 }, (_, i) => String(i)),
      ready: true,
      initialPage: 3,
    });
    expect(result.current.controls.page).toBe(3);
    expect(result.current.pageRows[0]).toBe('20');
  });

  it('still snaps to page 1 when the filter resetKey changes', () => {
    const rows = Array.from({ length: 35 }, (_, i) => String(i));
    const { result, rerender } = renderHook(
      (props: { resetKey: string }) => usePagination(rows, { initialPage: 3, resetKey: props.resetKey }),
      { initialProps: { resetKey: 'all' } },
    );
    act(() => result.current.controls.setPage(3));
    expect(result.current.controls.page).toBe(3);
    rerender({ resetKey: 'verified' });
    expect(result.current.controls.page).toBe(1);
  });
});
