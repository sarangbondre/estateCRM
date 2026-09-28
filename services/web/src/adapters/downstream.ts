// The gateway's hop to an owning service (web LLD §4.3, conventions §4): streams bodies both ways, first-byte and
// total timeouts, one retry with 100–400 ms jitter for idempotent calls, a circuit breaker per downstream (50 %
// errors over 20 calls → open 30 s → half-open probe). Breaker open or timeout → 503 dependency-unavailable.
import { CircuitBreaker, CircuitOpenError } from '@11e/http';
import { injectTraceHeaders } from '@11e/observability';
import type { CallInfo } from '@11e/observability';
import type { Downstream, DownstreamRequest } from '../application/ports';
import { WebError } from '../domain/errors';

const DROP_RESPONSE = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie'];

export interface HttpDownstreamOptions {
  baseUrls: Record<string, string>;
  fetch?: typeof fetch;
  onCall?: (info: CallInfo) => void;
  jitter?: () => number;
  now?: () => number;
}

class Timeout extends Error {}

export class HttpDownstream implements Downstream {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly doFetch: typeof fetch;
  private readonly jitter: () => number;

  constructor(private readonly o: HttpDownstreamOptions) {
    this.doFetch = o.fetch ?? fetch;
    this.jitter = o.jitter ?? (() => 100 + Math.random() * 300);
  }

  private breaker(service: string): CircuitBreaker {
    let b = this.breakers.get(service);
    if (!b) {
      b = new CircuitBreaker({}, this.o.now ?? Date.now);
      this.breakers.set(service, b);
    }
    return b;
  }

  states(): Record<string, string> {
    return Object.fromEntries([...this.breakers].map(([k, b]) => [`circuit:${k}`, b.state]));
  }

  async send(req: DownstreamRequest): Promise<Response> {
    const base = this.o.baseUrls[req.service];
    if (!base) throw new WebError('dependency-unavailable', `no URL for ${req.service}`, 30);
    const breaker = this.breaker(req.service);
    const attempts = req.retry ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        breaker.before();
      } catch (err) {
        if (err instanceof CircuitOpenError) throw new WebError('dependency-unavailable', `${req.service} circuit open`, 30);
        throw err;
      }
      const started = performance.now();
      try {
        const res = await this.once(base, req);
        const failed = res.status >= 500;
        breaker.after(!failed);
        this.o.onCall?.({ name: req.service, method: req.method, path: '', status: res.status, durationMs: performance.now() - started, attempt });
        if (failed && [502, 503, 504].includes(res.status) && attempt < attempts) {
          await res.body?.cancel().catch(() => undefined);
          await new Promise((r) => setTimeout(r, this.jitter()));
          continue;
        }
        return res;
      } catch (err) {
        breaker.after(false);
        this.o.onCall?.({ name: req.service, method: req.method, path: '', status: 'error', durationMs: performance.now() - started, attempt });
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, this.jitter()));
          continue;
        }
        throw new WebError('dependency-unavailable', err instanceof Timeout ? `${req.service} timed out` : `${req.service} unreachable`, 30);
      }
    }
  }

  private async once(base: string, req: DownstreamRequest): Promise<Response> {
    const ctrl = new AbortController();
    let firstByte: ReturnType<typeof setTimeout> | undefined;
    const total = setTimeout(() => ctrl.abort(new Timeout('total')), req.totalMs);
    const headersArrived = new Promise<never>((_, reject) => {
      firstByte = setTimeout(() => {
        ctrl.abort(new Timeout('first byte'));
        reject(new Timeout('first byte'));
      }, req.firstByteMs);
    });
    try {
      const url = new URL(req.pathAndQuery, base.endsWith('/') ? base : `${base}/`);
      const res = await Promise.race([
        this.doFetch(url, {
          method: req.method,
          headers: injectTraceHeaders({ ...req.headers }),
          ...(req.body && !['GET', 'HEAD'].includes(req.method) ? { body: req.body } : {}),
          signal: ctrl.signal,
          redirect: 'manual',
        }),
        headersArrived,
      ]);
      clearTimeout(firstByte);
      const headers = new Headers(res.headers);
      for (const h of DROP_RESPONSE) headers.delete(h);
      const body = res.body
        ? res.body.pipeThrough(
            new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
              flush: () => clearTimeout(total),
            }),
          )
        : null;
      if (!body) clearTimeout(total);
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      clearTimeout(firstByte);
      clearTimeout(total);
      if (ctrl.signal.aborted) throw new Timeout('timeout');
      throw err;
    }
  }
}
