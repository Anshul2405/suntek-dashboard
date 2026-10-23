import type { SetURLSearchParams } from 'react-router-dom';

/**
 * Set / clear some query params without losing the others. Reads the LIVE URL:
 * react-router's functional setSearchParams hands back the params of the last
 * render, so two writes in one tick (tab click + filter reset) undid each other.
 * Empty values delete the key. No-op when nothing changes.
 */
export function patchUrlParams(set: SetURLSearchParams, patch: Record<string, string | null | undefined>) {
  const current = new URLSearchParams(window.location.search);
  const next = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v); else next.delete(k);
  }
  if (next.toString() === current.toString()) return;
  set(next, { replace: true });
}
