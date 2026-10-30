import { useSearchParams } from 'react-router-dom';
import type { SortDir } from '../components/ui/useSortable';
import { patchUrlParams } from './urlParams';

type SortState = { key: string | null; dir: SortDir };

/**
 * A list's page, page size and sort kept in the URL (?p= ?ps= ?sort= ?dir=),
 * so Back / Cancel from an opened row, back= links and a refresh land on the
 * same page in the same order. Filters already live in the URL (useUrlFilters).
 *
 *   const url = useUrlTable({ key: 'date', dir: 'desc' });
 *   const s = useSortable(rows, accessors, url.sort, url.onSort);
 *   const { pageRows, controls } = usePagination(s.sorted, { resetKey, ...url.paging, ready: !loading });
 *
 * `prefix` keeps two lists on one screen apart (e.g. 'od' → ?odp= ?odsort=).
 * Defaults are left out of the URL. Writes go through patchUrlParams, which
 * reads the live URL, so they never undo a filter written in the same tick.
 */
export function useUrlTable(defaultSort?: { key: string; dir: SortDir }, prefix = '') {
  const [params, setParams] = useSearchParams();
  const k = { p: `${prefix}p`, ps: `${prefix}ps`, sort: `${prefix}sort`, dir: `${prefix}dir` };
  const rawKey = params.get(k.sort);
  const sort = rawKey
    ? { key: rawKey, dir: (params.get(k.dir) === 'asc' ? 'asc' : 'desc') as SortDir }
    : defaultSort;
  return {
    sort,
    onSort: (s: SortState) => {
      const isDefault = defaultSort ? s.key === defaultSort.key && s.dir === defaultSort.dir : !s.key;
      patchUrlParams(setParams, { [k.sort]: isDefault ? '' : s.key ?? '', [k.dir]: isDefault ? '' : s.dir });
    },
    paging: {
      initialPage: Number(params.get(k.p)) || 1,
      initialPageSize: Number(params.get(k.ps)) || 10,
      onChange: (page: number, size: number) => patchUrlParams(setParams, {
        [k.p]: page > 1 ? String(page) : '',
        [k.ps]: size !== 10 ? String(size) : '',
      }),
    },
  };
}
