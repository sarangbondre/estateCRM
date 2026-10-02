// WEB-03 gateway: the x-routes table covers every staff path of every service contract, and the proxy forwards one
// hop with auth, tenant, correlation, rate limits, Idempotency-Key pass-through, timeouts, retry and breaker.
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import webSpec from '@11e/contracts/openapi/web.json' with { type: 'json' };
import intake from '@11e/contracts/openapi/intake.json' with { type: 'json' };
import records from '@11e/contracts/openapi/records.json' with { type: 'json' };
import journeys from '@11e/contracts/openapi/journeys.json' with { type: 'json' };
import crmEngine from '@11e/contracts/openapi/crm-engine.json' with { type: 'json' };
import listings from '@11e/contracts/openapi/listings.json' with { type: 'json' };
import insight from '@11e/contracts/openapi/insight.json' with { type: 'json' };
import { Gateway } from '../src/application/gateway';
import type { RateLimiter, StreamLeases } from '../src/application/ports';
import { MemoryBucket } from '../src/adapters/db/limits';
import { HttpDownstream } from '../src/adapters/downstream';
import { BUCKETS, RouteTable, retryAfterSec } from '../src/domain/routes';
import type { Bucket, RouteEntry } from '../src/domain/routes';
import { TENANT, makeUser } from './fakes';
import { APP_ORIGIN, SUPABASE, harness } from './harness';

type Spec = { paths: Record<string, Record<string, { operationId?: string; security?: Record<string, unknown>[] }>> };
const table = (webSpec as unknown as { 'x-routes': { table: RouteEntry[] } })['x-routes'].table;
const routes = new RouteTable(table);

describe('routing table (x-routes) — contract coverage (LLD W-10)', () => {
  const specs: Record<string, Spec> = {
    intake: intake as unknown as Spec,
    records: records as unknown as Spec,
    journeys: journeys as unknown as Spec,
    'crm-engine': crmEngine as unknown as Spec,
    listings: listings as unknown as Spec,
    insight: insight as unknown as Spec,
    web: webSpec as unknown as Spec,
  };
  const concrete = (p: string) => p.replace(/\{[^}]+\}/g, 'X-000123');

  it.each(Object.keys(specs))('every staff-facing path of %s routes to its owner', (svc) => {
    const wrong: string[] = [];
    for (const [path, item] of Object.entries(specs[svc]!.paths)) {
      if (!path.startsWith('/v1/') && !path.startsWith('/p/')) continue;
      for (const op of Object.values(item)) {
        if (!op || typeof op !== 'object' || !op.operationId) continue;
        const schemes = (op.security ?? []).flatMap((s) => Object.keys(s));
        const staff = schemes.includes('staffViaWeb') || schemes.includes('staffSession');
        const isPublicPage = path.startsWith('/p/');
        if (!staff && !isPublicPage) continue; // website API (listings, X-Api-Key) is not routed through web
        const got = routes.match(concrete(path))?.service;
        if (got !== svc) wrong.push(`${path} → ${got ?? 'none'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('specific sub-resources win over the records catch-alls; internal paths never route', () => {
    expect(routes.match('/v1/offers/INV-00452/publication')?.service).toBe('listings');
    expect(routes.match('/v1/offers/INV-00452/matches')?.service).toBe('crm-engine');
    expect(routes.match('/v1/offers/INV-00452/journey')?.service).toBe('journeys');
    expect(routes.match('/v1/offers/INV-00452')?.service).toBe('records');
    expect(routes.match('/v1/offersx')).toBeUndefined();
    expect(routes.match('/v1/../internal/v1/relay')).toBeUndefined();
    expect(routes.match('/internal/v1/relay')?.service).toBe('none');
    expect(routes.match('/p/abc')).toMatchObject({ service: 'journeys', authenticated: false });
  });

  it('bucket maths', () => {
    expect(BUCKETS.api).toEqual({ rate: 20, burst: 40 });
    expect(retryAfterSec('upload', 0)).toBe(720);
    expect(retryAfterSec('api', 0.5)).toBe(1);
  });
});

class MemLimiter implements RateLimiter {
  bucket = new MemoryBucket(1);
  async take(tenantId: string, subject: string, b: Bucket, cost = 1) {
    const r = this.bucket.take(`${tenantId}|${subject}|${b}`, b, cost);
    return { allowed: r.allowed, remaining: r.tokens, limit: BUCKETS[b].burst, retryAfterSec: r.allowed ? 0 : retryAfterSec(b, r.tokens, cost) };
  }
}
class MemLeases implements StreamLeases {
  held = new Map<string, string>();
  async acquire(t: string, u: string) {
    if (this.held.has(`${t}|${u}`)) return null;
    const id = randomUUID();
    this.held.set(`${t}|${u}`, id);
    return id;
  }
  async release(t: string, u: string, id: string) {
    if (this.held.get(`${t}|${u}`) === id) this.held.delete(`${t}|${u}`);
  }
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

async function gatewayHarness(
  fetchImpl: (url: URL, init: RequestInit) => Promise<Response>,
  coldStartAllowanceMs = 0,
) {
  const seen: Seen[] = [];
  const leases = new MemLeases();
  const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const i = init ?? {};
    const hdrs = Object.fromEntries(new Headers(i.headers).entries());
    const body = i.body ? new TextDecoder().decode(i.body as Uint8Array) : null;
    seen.push({ url: String(input), method: i.method ?? 'GET', headers: hdrs, body });
    return fetchImpl(new URL(String(input)), i);
  }) as typeof fetch;
  const downstream = new HttpDownstream({
    baseUrls: { intake: 'http://intake.test', records: 'http://records.test', journeys: 'http://journeys.test', 'crm-engine': 'http://engine.test', listings: 'http://listings.test', insight: 'http://insight.test' },
    fetch: fakeFetch,
    jitter: () => 1,
  });
  const h = await harness((p) => {
    const gateway = new Gateway({ routes, limiter: new MemLimiter(), leases, downstream, tokens: p.tokens, publicTenantId: TENANT, coldStartAllowanceMs });
    return {
      limiter: new MemLimiter(),
      readyChecks: () => downstream.states(),
      gateway: { gateway, staffAuth: { sessions: p.sessions, supabase: SUPABASE, appOrigin: APP_ORIGIN }, keyring: p.keyring },
    };
  });
  return { ...h, seen, leases, downstream };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('gateway proxy', () => {
  let g: Awaited<ReturnType<typeof gatewayHarness>>;
  let user: ReturnType<typeof makeUser>;
  beforeEach(async () => {
    g = await gatewayHarness(async () => json({ ok: true }));
    user = g.memory.add(makeUser({ role: 'Supply agent' }));
  });

  it('forwards one hop with a service token, X-User-* and the correlation id; strips client identity headers', async () => {
    const res = await g.app.request(
      '/v1/offers/INV-00452?include=property',
      g.as(user.id, {
        headers: { 'x-user-id': 'spoofed', 'x-tenant-id': 'spoofed', cookie: 'a=b', 'x-correlation-id': 'corr-abc-12345' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('x-correlation-id')).toBe('corr-abc-12345');
    expect(res.headers.get('x-ratelimit-limit')).toBe('40');
    const s = g.seen[0]!;
    expect(s.url).toBe('http://records.test/v1/offers/INV-00452?include=property');
    expect(s.headers['x-user-id']).toBe(user.id);
    expect(s.headers['x-user-role']).toBe('Supply agent');
    expect(s.headers['x-tenant-id']).toBe(TENANT);
    expect(s.headers['x-correlation-id']).toBe('corr-abc-12345');
    expect(s.headers['cookie']).toBeUndefined();
    const claims = decodeJwt(s.headers['authorization']!.replace('Bearer ', ''));
    expect(claims).toMatchObject({ iss: 'web', aud: 'records', uid: user.id, tid: TENANT, role: 'Supply agent' });
  });

  it('passes Idempotency-Key, If-Match and the body through unchanged', async () => {
    const res = await g.app.request(
      '/v1/demands/DEM-000127/qualify',
      g.as(user.id, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-123', 'if-match': '"3"' },
        body: JSON.stringify({ decisionMaker: true }),
      }),
    );
    expect(res.status).toBe(200);
    const s = g.seen[0]!;
    expect(s.url).toBe('http://journeys.test/v1/demands/DEM-000127/qualify');
    expect(s.headers['idempotency-key']).toBe('k-123');
    expect(s.headers['if-match']).toBe('"3"');
    expect(s.body).toBe('{"decisionMaker":true}');
  });

  it('401 without a session, 404 route-not-found for unknown paths, own endpoints are never proxied', async () => {
    expect((await g.app.request('/v1/offers')).status).toBe(401);
    const nf = await g.app.request('/v1/nothing-here', g.as(user.id));
    expect(nf.status).toBe(404);
    expect((await nf.json()).code).toBe('route-not-found');
    expect((await g.app.request('/v1/me', g.as(user.id))).status).toBe(200);
    expect((await g.app.request('/v1/me', g.as(user.id, { method: 'POST' }))).status).toBe(404);
    expect(g.seen).toHaveLength(0);
  });

  it('downstream problems pass through with the correlation id added', async () => {
    g = await gatewayHarness(async () =>
      new Response(JSON.stringify({ type: 'x', title: 'Not found', status: 404, code: 'not-found' }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    user = g.memory.add(makeUser());
    const res = await g.app.request('/v1/offers/INV-1', g.as(user.id, { headers: { 'x-correlation-id': 'corr-xyz-98765' } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not-found', correlationId: 'corr-xyz-98765' });
  });

  it('rate limits: api burst 40 per user, then 429 with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 42; i++) statuses.push((await g.app.request('/v1/offers', g.as(user.id))).status);
    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    const last = await g.app.request('/v1/offers', g.as(user.id));
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBe('1');
    expect((await last.json()).code).toBe('rate-limited');
  });

  it('uploads: 5 per hour per user', async () => {
    const post = () => g.app.request('/v1/uploads', g.as(user.id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(200);
    const r = await post();
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(600);
  });

  it('chat: one concurrent stream per user; SSE is not buffered and the lease is released at the end', async () => {
    let push!: (s: string) => void;
    let end!: () => void;
    g = await gatewayHarness(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          push = (s) => ctrl.enqueue(new TextEncoder().encode(s));
          end = () => ctrl.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    user = g.memory.add(makeUser());
    const path = '/v1/chat/conversations/8a4c6c1e-0000-4000-8000-000000000001/messages';
    const init = () => g.as(user.id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
    const first = await g.app.request(path, init());
    expect(first.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect((await g.app.request(path, init())).status).toBe(429);
    const reader = first.body!.getReader();
    push('event: token\ndata: {"t":"Hel"}\n\n');
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain('Hel');
    end();
    while (!(await reader.read()).done);
    await new Promise((r) => setTimeout(r, 5));
    expect(g.leases.held.size).toBe(0);
  });

  it('timeouts and network errors → 503 dependency-unavailable with Retry-After; GET is retried once', async () => {
    let calls = 0;
    g = await gatewayHarness(async (_url, init) => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    user = g.memory.add(makeUser());
    const started = Date.now();
    const res = await g.app.request('/v1/offers', g.as(user.id));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await res.json()).code).toBe('dependency-unavailable');
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  it('a cold-starting service (first byte after 2.5 s) succeeds with the cold-start allowance (CR-014)', async () => {
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 2500));
      return json({ ok: true });
    };
    g = await gatewayHarness(slow, 1000);
    user = g.memory.add(makeUser());
    expect((await g.app.request('/v1/offers', g.as(user.id))).status).toBe(200);
  }, 15_000);

  it('POST without Idempotency-Key is not retried', async () => {
    let calls = 0;
    g = await gatewayHarness(async () => {
      calls++;
      throw new TypeError('fetch failed');
    });
    user = g.memory.add(makeUser());
    const res = await g.app.request('/v1/offers', g.as(user.id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it('the circuit opens after 50 % failures over 20 calls and shows in /health/ready', async () => {
    g = await gatewayHarness(async () => json({ code: 'boom' }, 500));
    user = g.memory.add(makeUser());
    for (let i = 0; i < 20; i++) await g.app.request('/v1/offers', g.as(user.id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const r = await g.app.request('/v1/offers', g.as(user.id));
    expect(r.status).toBe(503);
    expect((await (await g.app.request('/health/ready')).json()).checks['circuit:records']).toBe('open');
  });

  it('the public proposal page needs no session and carries no user token', async () => {
    const res = await g.app.request('/p/tok-abcdef123', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.status).toBe(200);
    expect(g.seen[0]?.url).toBe('http://journeys.test/p/tok-abcdef123');
    expect(g.seen[0]?.headers['authorization']).toBeUndefined();
  });
});
