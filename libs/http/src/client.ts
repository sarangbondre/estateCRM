// Outbound HTTP client (conventions §4 timeouts; CLAUDE.md §3.5): 2 s timeout, retry with exponential backoff and
// jitter (100–400 ms) only for idempotent calls, and a circuit breaker per downstream (opens at ≥50% errors over the
// last 20 calls, half-open after 30 s). Correlation ID and auth headers are added to every call.
export interface BreakerOptions {
  window: number;
  failureRatio: number;
  openMs: number;
}

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
}

/** Counts outcomes over a sliding window of calls. Exported for tests. */
export class CircuitBreaker {
  readonly #opts: BreakerOptions;
  #outcomes: boolean[] = [];
  #openedAt: number | undefined;
  #probe = false;
  readonly now: () => number;

  constructor(opts: Partial<BreakerOptions> = {}, now: () => number = Date.now) {
    this.#opts = { window: 20, failureRatio: 0.5, openMs: 30_000, ...opts };
    this.now = now;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.#openedAt === undefined) return 'closed';
    return this.now() - this.#openedAt >= this.#opts.openMs ? 'half-open' : 'open';
  }

  /** Throws CircuitOpenError when calls must not go out. */
  before(): void {
    const s = this.state;
    if (s === 'open' || (s === 'half-open' && this.#probe)) throw new CircuitOpenError('circuit open');
    if (s === 'half-open') this.#probe = true;
  }

  after(ok: boolean): void {
    if (this.#openedAt !== undefined) {
      this.#probe = false;
      if (ok) {
        this.#openedAt = undefined;
        this.#outcomes = [];
      } else {
        this.#openedAt = this.now();
      }
      return;
    }
    this.#outcomes.push(ok);
    if (this.#outcomes.length > this.#opts.window) this.#outcomes.shift();
    const failures = this.#outcomes.filter((o) => !o).length;
    if (
      this.#outcomes.length >= this.#opts.window &&
      failures / this.#outcomes.length >= this.#opts.failureRatio
    ) {
      this.#openedAt = this.now();
    }
  }
}

export interface ClientOptions {
  /** Downstream name, for errors and metrics. */
  name: string;
  baseUrl: string;
  timeoutMs?: number;
  /** Extra attempts for idempotent calls. Default 1 (conventions §4). */
  retries?: number;
  /** Adds auth headers (service token from libs/auth). */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  breaker?: Partial<BreakerOptions>;
  fetch?: typeof fetch;
  onCall?: (info: {
    name: string;
    method: string;
    path: string;
    status: number | 'error';
    durationMs: number;
    attempt: number;
  }) => void;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  correlationId?: string;
  idempotencyKey?: string;
}

export interface ClientResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

export class DownstreamError extends Error {
  override readonly name = 'DownstreamError';
  readonly downstream: string;
  readonly status: number | undefined;
  constructor(
    downstream: string,
    status: number | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.downstream = downstream;
    this.status = status;
  }
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpClient {
  request<T = unknown>(path: string, options?: RequestOptions): Promise<ClientResponse<T>>;
  readonly breaker: CircuitBreaker;
}

export function createHttpClient(options: ClientOptions): HttpClient {
  const breaker = new CircuitBreaker(options.breaker);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;

  async function request<T>(path: string, req: RequestOptions = {}): Promise<ClientResponse<T>> {
    const method = (req.method ?? 'GET').toUpperCase();
    const retryable = IDEMPOTENT.has(method) || req.idempotencyKey !== undefined;
    const attempts = 1 + (retryable ? (options.retries ?? 1) : 0);
    const url = new URL(
      path.replace(/^\//, ''),
      options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
    );
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        breaker.before();
      } catch (err) {
        throw new DownstreamError(options.name, undefined, `${options.name}: circuit open`, { cause: err });
      }
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(await options.headers?.()),
        ...req.headers,
      };
      if (req.correlationId) headers['x-correlation-id'] = req.correlationId;
      if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
      if (req.body !== undefined) headers['content-type'] ??= 'application/json';
      const started = performance.now();
      try {
        const res = await doFetch(url, {
          method,
          headers,
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const durationMs = Math.round(performance.now() - started);
        options.onCall?.({ name: options.name, method, path, status: res.status, durationMs, attempt });
        const serverError = res.status >= 500 || res.status === 429;
        breaker.after(!serverError);
        if (serverError && attempt < attempts) {
          await sleep(100 + Math.random() * 300);
          continue;
        }
        const text = await res.text();
        const body = (text ? JSON.parse(text) : undefined) as T;
        if (serverError)
          throw new DownstreamError(options.name, res.status, `${options.name}: ${res.status}`);
        return { status: res.status, body, headers: res.headers };
      } catch (err) {
        if (err instanceof DownstreamError) throw err;
        const durationMs = Math.round(performance.now() - started);
        options.onCall?.({ name: options.name, method, path, status: 'error', durationMs, attempt });
        breaker.after(false);
        lastError = err;
        if (attempt < attempts) {
          await sleep(100 + Math.random() * 300);
          continue;
        }
      }
    }
    throw new DownstreamError(options.name, undefined, `${options.name}: unavailable`, { cause: lastError });
  }

  return { request, breaker };
}
