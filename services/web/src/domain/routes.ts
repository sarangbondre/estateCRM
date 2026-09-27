// The gateway routing table (web contract `x-routes`, LLD §4.3): evaluated top-down, first match wins; `*` = one path
// segment, `**` = the rest. A prefix matches the path itself or anything below it. Pure.

export interface RouteEntry {
  prefix: string;
  service: string;
  auth?: string;
  note?: string;
}

export interface CompiledRoute {
  prefix: string;
  service: string;
  /** false for `auth: none` (the public proposal page). */
  authenticated: boolean;
  re: RegExp;
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function compileRoute(e: RouteEntry): CompiledRoute {
  const parts = e.prefix.split('/').map((seg) => (seg === '*' ? '[^/]+' : seg === '**' ? '.*' : escape(seg)));
  const body = parts.join('/');
  const re = e.prefix.endsWith('/**') ? new RegExp(`^${body}$`) : new RegExp(`^${body}(?:/.*)?$`);
  return { prefix: e.prefix, service: e.service, authenticated: e.auth !== 'none', re };
}

export class RouteTable {
  private readonly routes: CompiledRoute[];
  constructor(entries: readonly RouteEntry[]) {
    this.routes = entries.map(compileRoute);
  }
  /** The first route whose prefix matches `path` (no query string). */
  match(path: string): CompiledRoute | undefined {
    if (path.includes('..') || path.includes('//')) return undefined;
    return this.routes.find((r) => r.re.test(path));
  }
  get entries(): readonly CompiledRoute[] {
    return this.routes;
  }
}

/** Rate-limit buckets (web contract, LLD §4.4). `rate` in tokens per second. */
export const BUCKETS = {
  api: { rate: 20, burst: 40 },
  chat_msg: { rate: 30 / 60, burst: 30 },
  upload: { rate: 5 / 3600, burst: 5 },
  public_page: { rate: 60 / 60, burst: 60 },
  invite: { rate: 20 / 3600, burst: 20 },
  service_token: { rate: 60 / 60, burst: 60 },
} as const;
export type Bucket = keyof typeof BUCKETS;

/** Extra buckets a proxied request takes besides `api`. */
export function extraBuckets(method: string, path: string): Bucket[] {
  if (method === 'POST' && path === '/v1/uploads') return ['upload'];
  if (method === 'POST' && /^\/v1\/chat\/conversations\/[^/]+\/messages$/.test(path)) return ['chat_msg'];
  return [];
}

/** A chat message POST streams SSE: one concurrent stream per user (chat_stream_lease). */
export function isChatStream(method: string, path: string): boolean {
  return method === 'POST' && /^\/v1\/chat\/conversations\/[^/]+\/messages$/.test(path);
}

/** Downstream timeouts (conventions §4, R-5, D-9): 2 s; /v1/parse 4 s; chat stream first byte 3 s, total 15 s. */
export function timeoutsFor(method: string, path: string): { firstByteMs: number; totalMs: number } {
  if (isChatStream(method, path)) return { firstByteMs: 3000, totalMs: 15_000 };
  if (path === '/v1/parse') return { firstByteMs: 4000, totalMs: 4000 };
  return { firstByteMs: 2000, totalMs: 2000 };
}

/** One retry for idempotent calls: GET/PUT/DELETE always, POST/PATCH only with Idempotency-Key or If-Match. */
export function retryable(method: string, headers: { idempotencyKey?: string | null; ifMatch?: string | null }): boolean {
  if (['GET', 'HEAD', 'PUT', 'DELETE'].includes(method)) return true;
  if (method === 'POST' || method === 'PATCH') return Boolean(headers.idempotencyKey || headers.ifMatch);
  return false;
}

/** Retry-After seconds for a refused bucket. */
export function retryAfterSec(bucket: Bucket, available: number, cost = 1): number {
  const { rate } = BUCKETS[bucket];
  return Math.max(1, Math.ceil((cost - available) / rate));
}
