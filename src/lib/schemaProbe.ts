import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * "Is this column there yet?" — a read-only probe for features that wait on a
 * migration that has not been applied. Any error (missing column, offline)
 * counts as not there, so the screen keeps its old behaviour.
 */
const results = new Map<string, Promise<boolean>>();

export function probeColumn(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  let p = results.get(key);
  if (!p) {
    p = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).from(table).select(column).limit(1);
        return !error;
      } catch {
        return false;
      }
    })();
    results.set(key, p);
  }
  return p;
}

/** False until the probe answers; true only when the column exists. */
export function useColumnLive(table: string, column: string): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    void probeColumn(table, column).then(v => { if (alive) setLive(v); });
    return () => { alive = false; };
  }, [table, column]);
  return live;
}
