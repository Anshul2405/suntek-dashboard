import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { forgetBusyFeedCache, useBusyHeartbeat } from '../hooks/useBusyData';

function isBusyScreenKey(key: unknown) {
  return typeof key === 'string'
    && key !== 'busy-heartbeat'
    && (key.startsWith('busy-') || key.startsWith('anomaly-'));
}

/** Refetch the open Busy screens only when the Busy PC has pushed new data. */
export function BusyFeedSync() {
  const qc = useQueryClient();
  const { data } = useBusyHeartbeat();
  const last = useRef<string | null>(null);
  const at = data?.at ?? null;
  useEffect(() => {
    if (!at) return;
    if (last.current && last.current !== at) {
      forgetBusyFeedCache();
      void qc.invalidateQueries({ predicate: (q) => isBusyScreenKey(q.queryKey[0]) });
    }
    last.current = at;
  }, [at, qc]);
  return null;
}
