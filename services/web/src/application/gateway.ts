// ProxyRequest (web LLD §4.3): one hop from the browser to the owning service by the x-routes table. web checks only
// "authenticated, active, tenant" here; the owning service applies role and resource rules (ADR-0007). The response
// is streamed back unchanged (no branching on bodies); web only adds correlation and rate-limit headers.
import { WebError } from '../domain/errors';
import { extraBuckets, isChatStream, retryable, timeoutsFor } from '../domain/routes';
import type { Bucket, RouteTable } from '../domain/routes';
import { isServiceName } from '../domain/service-tokens';
import type { Downstream, RateLimiter, StreamLeases } from './ports';
import type { StaffContext } from './sessions';
import type { Tokens } from './tokens';

export const MAX_BODY_BYTES = 1024 * 1024;
export const CHAT_LEASE_MS = 20_000;

export interface GatewayInput {
  method: string;
  path: string;
  /** "?a=b" or "". */
  search: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | null;
  correlationId: string;
  /** HMAC of the client IP (public_page bucket). */
  clientKey: string;
}

export interface GatewayDeps {
  routes: RouteTable;
  limiter: RateLimiter;
  leases: StreamLeases;
  downstream: Downstream;
  tokens: Tokens;
  /** Tenant for unauthenticated public routes (Phase 1: one tenant). */
  publicTenantId: string;
  /** Added to the contract timeout so a cold-starting function isn't answered with 503 (CR-014). Default 0. */
  coldStartAllowanceMs?: number;
}

/** Client headers passed through unchanged; everything else (cookies, X-User-*, X-Tenant-*, Authorization) is not. */
const PASS_THROUGH = ['accept', 'content-type', 'idempotency-key', 'if-match', 'if-none-match', 'accept-language'];

export class Gateway {
  constructor(private readonly d: GatewayDeps) {}

  /** Which service a path belongs to (undefined: not routed through the gateway). */
  target(path: string) {
    return this.d.routes.match(path);
  }

  async handle(req: GatewayInput, authenticate: () => Promise<StaffContext>): Promise<Response> {
    const route = this.d.routes.match(req.path);
    if (!route || !isServiceName(route.service)) throw new WebError('route-not-found');
    if (req.body && req.body.byteLength > MAX_BODY_BYTES) throw new WebError('validation-failed', 'body over 1 MB');

    let staff: StaffContext | undefined;
    let tenantId: string;
    let subject: string;
    let buckets: Bucket[];
    if (route.authenticated) {
      staff = await authenticate();
      tenantId = staff.tenantId;
      subject = staff.userId;
      buckets = ['api', ...extraBuckets(req.method, req.path)];
    } else {
      tenantId = this.d.publicTenantId;
      subject = req.clientKey;
      buckets = ['public_page'];
    }

    let limit = { limit: 0, remaining: 0 };
    for (const b of buckets) {
      const r = await this.d.limiter.take(tenantId, subject, b);
      if (!r.allowed) throw new WebError('rate-limited', `${b} limit reached`, r.retryAfterSec);
      if (b === buckets[0]) limit = { limit: r.limit, remaining: r.remaining };
    }

    let leaseId: string | null = null;
    if (staff && isChatStream(req.method, req.path)) {
      leaseId = await this.d.leases.acquire(tenantId, staff.userId, CHAT_LEASE_MS);
      if (!leaseId) throw new WebError('rate-limited', 'one chat answer at a time', 2);
    }

    const headers: Record<string, string> = { 'x-correlation-id': req.correlationId };
    for (const h of PASS_THROUGH) {
      const v = req.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    if (staff) {
      headers['authorization'] = `Bearer ${await this.d.tokens.userToken(staff, route.service)}`;
      headers['x-user-id'] = staff.userId;
      headers['x-user-role'] = staff.role;
      headers['x-tenant-id'] = staff.tenantId;
    }

    const base = timeoutsFor(req.method, req.path);
    const allowance = this.d.coldStartAllowanceMs ?? 0;
    const firstByteMs = base.firstByteMs + allowance;
    const totalMs = base.totalMs + allowance;
    let res: Response;
    try {
      res = await this.d.downstream.send({
        service: route.service,
        method: req.method,
        pathAndQuery: `${req.path}${req.search}`,
        headers,
        body: req.body,
        firstByteMs,
        totalMs,
        retry: retryable(req.method, {
          idempotencyKey: req.headers.get('idempotency-key'),
          ifMatch: req.headers.get('if-match'),
        }),
      });
    } catch (err) {
      if (leaseId && staff) await this.d.leases.release(tenantId, staff.userId, leaseId).catch(() => undefined);
      throw err;
    }

    const out = new Headers(res.headers);
    out.set('x-correlation-id', req.correlationId);
    out.set('x-ratelimit-limit', String(limit.limit));
    out.set('x-ratelimit-remaining', String(Math.max(0, Math.floor(limit.remaining))));
    if ((out.get('content-type') ?? '').includes('text/event-stream')) out.set('cache-control', 'no-cache, no-transform');

    // Downstream problems pass through unchanged; web only adds the correlation id when missing.
    if ((out.get('content-type') ?? '').includes('application/problem+json')) {
      const text = await res.text();
      let body = text;
      try {
        const p = JSON.parse(text) as Record<string, unknown>;
        if (p && typeof p === 'object' && !p['correlationId']) body = JSON.stringify({ ...p, correlationId: req.correlationId });
      } catch {
        /* not JSON: pass through */
      }
      out.delete('content-length');
      if (leaseId && staff) await this.d.leases.release(tenantId, staff.userId, leaseId).catch(() => undefined);
      return new Response(body, { status: res.status, headers: out });
    }

    let stream = res.body;
    if (leaseId && staff && stream) {
      const release = () => this.d.leases.release(tenantId, staff!.userId, leaseId!).catch(() => undefined);
      stream = stream.pipeThrough(
        new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
          flush: () => {
            void release();
          },
        }),
      );
      // A client that disconnects cancels the stream; the lease also expires on its own after 20 s.
    } else if (leaseId && staff) {
      await this.d.leases.release(tenantId, staff.userId, leaseId).catch(() => undefined);
    }
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: out });
  }
}
