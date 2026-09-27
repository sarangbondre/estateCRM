'use client';
// Intake card hooks: a resource that polls every 2 s while `keepPolling(data)` holds (C-04 inspection and progress).
// Polling stops on terminal states and when the card unmounts (useResource clears its interval).
import { useEffect, useState } from 'react';
import { useResource } from '../../lib/api';
import type { Query, Resource } from '../../lib/api';

export const POLL_MS = 2000;

export function usePolled<T>(
  path: string | null,
  keepPolling: (data: T | undefined) => boolean,
  initial: boolean,
  query?: Query,
): Resource<T> {
  const [poll, setPoll] = useState(initial);
  const r = useResource<T>(path, query, poll ? POLL_MS : undefined);
  const want = r.data === undefined ? initial : keepPolling(r.data);
  useEffect(() => {
    if (want !== poll) setPoll(want);
  }, [want, poll]);
  return r;
}
