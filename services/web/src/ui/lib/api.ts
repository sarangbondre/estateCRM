// Browser client for web's own /v1 API and the gateway (docs/04-lld/web.md §2: UI components never call services
// directly). Errors are RFC 7807 problems; mutating calls carry an Idempotency-Key chosen once per user action.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  correlationId?: string;
  errors?: { field: string; code: string; message?: string }[];
  [k: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.detail ?? problem.title ?? problem.code ?? `HTTP ${status}`);
  }
  get code(): string {
    return this.problem.code ?? `http-${this.status}`;
  }
}

export type Query = Record<
  string,
  string | number | boolean | null | undefined | readonly (string | number)[]
>;

export interface CallOptions {
  query?: Query;
  body?: unknown;
  /** Required for mutating POSTs that the contract makes idempotent; pass one key per user action. */
  idempotencyKey?: string;
  ifMatch?: string | number;
  contentType?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

export const newIdempotencyKey = (): string => crypto.randomUUID();

type Listener = (err: ApiError) => void;
const authListeners = new Set<Listener>();
/** The shell subscribes to redirect to sign-in on 401 (session expired or signed out elsewhere). */
export function onAuthError(fn: Listener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = opts.contentType ?? 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, {
      code: 'network-error',
      detail: 'Network error. Check your connection and try again.',
    });
  }
  const type = res.headers.get('content-type') ?? '';
  const parsed: unknown = type.includes('json') ? await res.json().catch(() => undefined) : undefined;
  if (!res.ok) {
    const problem: Problem = (parsed as Problem | undefined) ?? {
      status: res.status,
      code: `http-${res.status}`,
    };
    const err = new ApiError(res.status, problem);
    if (res.status === 401) for (const l of authListeners) l(err);
    throw err;
  }
  return { data: parsed as T, status: res.status, headers: res.headers };
}

export const get = <T>(path: string, query?: Query, signal?: AbortSignal) =>
  call<T>('GET', path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) }).then((r) => r.data);

/** A friendly one-liner for an error (cards show it next to the action). */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const p = err.problem;
    const fields = p.errors?.map((e) => `${e.field}: ${e.message ?? e.code}`).join('; ');
    const base = MESSAGES[err.code] ?? p.detail ?? p.title ?? `Request failed (${err.status})`;
    return fields ? `${base} (${fields})` : base;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const MESSAGES: Record<string, string> = {
  'rate-limited': 'Too many requests. Wait a moment and try again.',
  'dependency-unavailable': 'That part of the system is not reachable right now. Try again shortly.',
  'version-mismatch': 'Someone changed this record meanwhile. Reload it and try again.',
  forbidden: 'Your role cannot do this.',
  unauthenticated: 'Your session ended. Sign in again.',
  'session-expired': 'Your session ended after 12 hours idle. Sign in again.',
  'not-found': 'Not found.',
  'route-not-found': 'This feature is not available.',
  'network-error': 'Network error. Check your connection and try again.',
};

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** GET a resource and keep it fresh on demand (R-CHAT-3: cards show live state). `path` null = don't load. */
export function useResource<T>(path: string | null, query?: Query, pollMs?: number): Resource<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  const key = path === null ? null : withQuery(path, query);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (key === null) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    call<T>('GET', key, { signal: ctrl.signal })
      .then((r) => setState({ data: r.data, loading: false }))
      .catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError') setState((s) => ({ ...s, error, loading: false }));
      });
    return () => ctrl.abort();
  }, [key, tick]);

  useEffect(() => {
    if (!pollMs || key === null) return;
    const t = setInterval(() => setTick((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs, key]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
