import { useSearchParams } from 'react-router-dom';
import { patchUrlParams } from './urlParams';

/**
 * List filters that live in the URL (q, plant, reactor, status, from, to, …),
 * so back= links and a refresh restore exactly what was on screen. Pair with
 * the v2 FilterBar / FilterSelect / DateRangeFilter — this is only the glue.
 *
 *   const f = useUrlFilters(['q', 'plant', 'from', 'to'] as const);
 *   <FilterBar search={f.values.q} onSearch={q => f.set({ q })} onReset={f.reset}>
 */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(keys.map(k => [k, params.get(k) || ''])) as Record<K, string>;
  return {
    values,
    /** Patch some filters; '' clears a key. Other query params are kept. */
    set: (patch: Partial<Record<K, string>>) => patchUrlParams(setParams, patch),
    /** Clear every filter key (other params such as back= / tab= stay). */
    reset: () => patchUrlParams(setParams, Object.fromEntries(keys.map(k => [k, '']))),
    /** Clear every filter, then apply `patch` — one URL write (KPI "See …" links). */
    only: (patch: Partial<Record<K, string>>) =>
      patchUrlParams(setParams, { ...Object.fromEntries(keys.map(k => [k, ''])), ...patch }),
    /** True when any filter is set. */
    active: keys.some(k => !!values[k]),
  };
}
