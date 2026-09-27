import { describe, expect, it } from 'vitest';
import { CircuitBreaker, DownstreamError, createHttpClient } from '../src/index.js';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createHttpClient', () => {
  it('retries idempotent calls once on 5xx, never retries a plain POST', async () => {
    const calls: string[] = [];
    const client = createHttpClient({
      name: 'records',
      baseUrl: 'http://records.internal',
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${String(url)}`);
        return calls.length === 1 ? json(503) : json(200, { ok: true });
      },
    });
    const r = await client.request<{ ok: boolean }>('/v1/offers', {
      query: { limit: 5 },
      correlationId: 'c-9',
    });
    expect(r.body).toEqual({ ok: true });
    expect(calls).toEqual([
      'GET http://records.internal/v1/offers?limit=5',
      'GET http://records.internal/v1/offers?limit=5',
    ]);

    calls.length = 0;
    const post = createHttpClient({
      name: 'records',
      baseUrl: 'http://records.internal',
      fetch: async () => (calls.push('x'), json(503)),
    });
    await expect(post.request('/v1/offers', { method: 'POST', body: {} })).rejects.toBeInstanceOf(
      DownstreamError,
    );
    expect(calls).toHaveLength(1);
  });

  it('retries a POST that carries an Idempotency-Key, and forwards correlation + auth headers', async () => {
    const seen: Headers[] = [];
    const client = createHttpClient({
      name: 'journeys',
      baseUrl: 'http://journeys.internal/',
      headers: async () => ({ authorization: 'Bearer svc-token' }),
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers));
        return seen.length === 1 ? Promise.reject(new TypeError('socket hang up')) : json(201, { id: 1 });
      },
    });
    const r = await client.request('v1/things', {
      method: 'POST',
      body: { a: 1 },
      idempotencyKey: 'k-1',
      correlationId: 'c-1',
    });
    expect(r.status).toBe(201);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.get('authorization')).toBe('Bearer svc-token');
    expect(seen[1]?.get('x-correlation-id')).toBe('c-1');
    expect(seen[1]?.get('idempotency-key')).toBe('k-1');
  });

  it('returns 4xx to the caller without retrying', async () => {
    let n = 0;
    const client = createHttpClient({
      name: 'x',
      baseUrl: 'http://x',
      fetch: async () => (n++, json(404, { code: 'not-found' })),
    });
    const r = await client.request('/v1/a');
    expect(r.status).toBe(404);
    expect(n).toBe(1);
  });

  it('times out slow calls (2 s default, configurable)', async () => {
    const client = createHttpClient({
      name: 'slow',
      baseUrl: 'http://slow',
      timeoutMs: 50,
      retries: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    });
    await expect(client.request('/v1/a')).rejects.toMatchObject({
      name: 'DownstreamError',
      downstream: 'slow',
    });
  });
});

describe('CircuitBreaker', () => {
  it('opens at ≥50% failures over 20 calls, half-opens after 30 s with a single probe, closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker({}, () => now);
    for (let i = 0; i < 19; i++) {
      b.before();
      b.after(i % 2 === 0);
    }
    expect(b.state).toBe('closed');
    b.before();
    b.after(false);
    expect(b.state).toBe('open');
    expect(() => b.before()).toThrow('circuit open');

    now = 30_000;
    expect(b.state).toBe('half-open');
    b.before();
    expect(() => b.before()).toThrow('circuit open');
    b.after(false);
    expect(b.state).toBe('open');

    now = 60_000;
    b.before();
    b.after(true);
    expect(b.state).toBe('closed');
  });

  it('the client fails fast while the circuit is open', async () => {
    let n = 0;
    const client = createHttpClient({
      name: 'flaky',
      baseUrl: 'http://f',
      retries: 0,
      breaker: { window: 4 },
      fetch: async () => (n++, json(500)),
    });
    for (let i = 0; i < 4; i++) await client.request('/v1/a').catch(() => {});
    expect(client.breaker.state).toBe('open');
    await expect(client.request('/v1/a')).rejects.toThrow('circuit open');
    expect(n).toBe(4);
  });
});
