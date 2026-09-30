// App factory + contract validation against the real records contract.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { operations } from '@11e/contracts/records';
import {
  HttpError,
  createService,
  decodeCursor,
  encodeCursor,
  ifMatchVersion,
  pageLimit,
  problemResponse,
  toPage,
  toProblem,
} from '../src/index.js';
import type { OpenApiDoc, RequestEndInfo } from '../src/index.js';

const spec = JSON.parse(
  readFileSync(new URL('../../../contracts/generated/openapi/records.json', import.meta.url), 'utf8'),
) as OpenApiDoc;

const PROPERTY = '5b0f7c1e-3a53-4c1c-9d5b-0a9a3c2f1d11';
const OFFER = {
  id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455',
  code: 'OFF-000001',
  propertyId: PROPERTY,
  dealType: 'Lease',
  label: 'For Lease',
  recordStage: 'Captured',
  sourceType: 'Direct',
  status: 'active',
  createdAt: '2026-09-27T00:00:00Z',
  updatedAt: '2026-09-27T00:00:00Z',
  version: 1,
};

function build(opts: { ready?: boolean; validateResponses?: boolean } = {}) {
  const ends: RequestEndInfo[] = [];
  const errors: unknown[] = [];
  const svc = createService<operations>({
    service: 'records',
    spec,
    ready: async () => ({ ok: opts.ready ?? true, checks: { db: opts.ready === false ? 'down' : 'ok' } }),
    validateResponses: opts.validateResponses ?? true,
    onRequestEnd: (i) => ends.push(i),
    onError: (e) => errors.push(e),
  });
  return { svc, ends, errors };
}

const call = (svc: ReturnType<typeof build>['svc'], path: string, init: RequestInit = {}) =>
  svc.app.request(path, init);

describe('createService', () => {
  it('serves health endpoints', async () => {
    const { svc } = build();
    expect(await (await call(svc, '/health/live')).json()).toEqual({ status: 'ok' });
    const ready = await call(svc, '/health/ready');
    expect(ready.status).toBe(200);
    const { svc: down } = build({ ready: false });
    const r = await call(down, '/health/ready');
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: 'down', checks: { db: 'down' } });
  });

  it('propagates a valid correlation id and replaces an invalid one', async () => {
    const { svc } = build();
    const a = await call(svc, '/health/live', { headers: { 'x-correlation-id': 'abc-123' } });
    expect(a.headers.get('x-correlation-id')).toBe('abc-123');
    const b = await call(svc, '/health/live', { headers: { 'x-correlation-id': 'bad id with spaces' } });
    expect(b.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with a 404 problem', async () => {
    const { svc } = build();
    const r = await call(svc, '/v1/nope');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    expect(await r.json()).toMatchObject({
      code: 'not-found',
      status: 404,
      type: 'https://errors.11estates.in/not-found',
    });
  });

  it('validates and coerces query parameters from the contract (limit max 100, unknown params rejected)', async () => {
    const { svc } = build();
    let seen: unknown;
    svc.op('listOffers', (c, input) => {
      seen = input.query;
      return c.json({ items: [OFFER], nextCursor: null });
    });
    const ok = await call(svc, '/v1/offers?limit=10&dealType=Lease');
    expect(ok.status).toBe(200);
    expect(seen).toMatchObject({ limit: 10, dealType: 'Lease' });

    const bad = await call(svc, '/v1/offers?limit=500&colour=red', {
      headers: { 'x-correlation-id': 'c-1' },
    });
    expect(bad.status).toBe(400);
    const p = (await bad.json()) as { errors: { field: string }[] };
    expect(p).toMatchObject({ code: 'validation-failed', correlationId: 'c-1' });
    expect(p.errors.map((e: { field: string }) => e.field).sort()).toEqual(['colour', 'limit']);
  });

  it('validates JSON bodies: invalid JSON, missing required fields, extra fields, wrong media type', async () => {
    const { svc } = build();
    svc.op('createOffer', (c) => c.json(OFFER, 201));
    const post = (body: string, type = 'application/json') =>
      call(svc, '/v1/offers', { method: 'POST', body, headers: { 'content-type': type } });

    expect((await post('{nope')).status).toBe(400);
    const missing = (await (await post(JSON.stringify({ propertyId: PROPERTY }))).json()) as {
      errors: unknown[];
    };
    expect(missing.errors).toContainEqual(expect.objectContaining({ field: 'body.offer', code: 'required' }));
    const extra = (await (
      await post(JSON.stringify({ propertyId: PROPERTY, offer: { dealType: 'Lease' }, hack: 1 }))
    ).json()) as {
      errors: unknown[];
    };
    expect(extra.errors).toContainEqual(
      expect.objectContaining({ field: 'body.hack', code: 'additionalProperties' }),
    );
    expect((await post('{}', 'text/plain')).status).toBe(415);
    expect((await call(svc, '/v1/offers', { method: 'POST' })).status).toBe(400);
  });

  it('rejects oversized bodies with 413', async () => {
    const svc = createService<operations>({
      service: 'records',
      spec,
      ready: async () => ({ ok: true }),
      maxBodyBytes: 100,
    });
    svc.op('createOffer', (c) => c.json(OFFER, 201));
    const r = await svc.app.request('/v1/offers', {
      method: 'POST',
      body: JSON.stringify({ propertyId: PROPERTY, offer: { dealType: 'x'.repeat(200) } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(413);
  });

  it('renders HttpError as a problem, hides unexpected errors, and reports every request', async () => {
    const { svc, ends, errors } = build();
    svc.op('getOffer', () => {
      throw new HttpError(404, 'not-found', { detail: 'no offer OFF-9' });
    });
    svc.op('listOffers', () => {
      throw new Error('db exploded with phone 9820012345');
    });
    const nf = await call(svc, '/v1/offers/OFF-9');
    expect(await nf.json()).toMatchObject({ code: 'not-found', detail: 'no offer OFF-9' });
    const boom = await call(svc, '/v1/offers');
    expect(boom.status).toBe(500);
    const body = await boom.text();
    expect(body).not.toContain('9820012345');
    expect(JSON.parse(body)).toMatchObject({ code: 'internal' });
    expect(errors).toHaveLength(1);
    expect(ends.map((e) => [e.operationId, e.status, e.route])).toEqual([
      ['getOffer', 404, '/v1/offers/{idOrCode}'],
      ['listOffers', 500, '/v1/offers'],
    ]);
  });

  it('catches responses that break the contract (contract tests)', async () => {
    const { svc } = build({ validateResponses: true });
    svc.op('getOffer', (c) => c.json({ id: 'not-a-uuid' }));
    const r = await call(svc, '/v1/offers/OFF-1');
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ code: 'contract-violation' });
  });

  it('lists operations without handlers', () => {
    const { svc } = build();
    svc.op('listOffers', (c) => c.json({ items: [], nextCursor: null }));
    const missing = svc.unimplemented();
    expect(missing).toContain('createOffer');
    expect(missing).not.toContain('listOffers');
  });
});

describe('request helpers', () => {
  it('If-Match accepts plain, quoted and weak versions, rejects junk', async () => {
    const { svc } = build({ validateResponses: false });
    svc.op('patchOffer', (c) => c.json({ ...OFFER, version: ifMatchVersion(c) ?? 0 }));
    const patch = (ifMatch?: string) =>
      call(svc, '/v1/offers/OFF-1', {
        method: 'PATCH',
        body: '{}',
        headers: {
          'content-type': 'application/merge-patch+json',
          ...(ifMatch ? { 'if-match': ifMatch } : {}),
        },
      });
    const version = async (r: Response | Promise<Response>) =>
      ((await (await r).json()) as { version: number }).version;
    expect(await version(patch('7'))).toBe(7);
    expect(await version(patch('W/"8"'))).toBe(8);
    expect(await version(patch())).toBe(0);
    expect((await patch('abc')).status).toBe(400);
  });

  it('cursor pagination round-trips, caps the limit and rejects tampered cursors', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, k: i }));
    const page = toPage(rows, 3, (r) => ({ k: r.k, id: r.id }));
    expect(page.items).toHaveLength(3);
    expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ k: 2, id: 'id-2' });
    expect(toPage(rows.slice(0, 2), 3, (r) => ({ id: r.id })).nextCursor).toBeNull();
    expect(pageLimit(undefined)).toBe(25);
    expect(pageLimit(1000)).toBe(100);
    expect(() => decodeCursor('%%%')).toThrow(HttpError);
    expect(() => decodeCursor(encodeCursor({ a: 1 }).slice(0, 3))).toThrow(HttpError);
  });

  it('problems carry extension members; standard members win over them', async () => {
    const plain = toProblem(new HttpError(404, 'not-found'), 'cid-1');
    expect(Object.keys(plain).sort()).toEqual(['code', 'correlationId', 'status', 'title', 'type']);
    const err = new HttpError(409, 'duplicate-property', {
      detail: 'looks like an existing property',
      extensions: { candidates: [{ id: 'p1' }], status: 200, code: 'x' },
    });
    const p = toProblem(err, 'cid-2');
    expect(p).toMatchObject({ status: 409, code: 'duplicate-property', candidates: [{ id: 'p1' }] });
    const r = problemResponse(err, 'cid-2');
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ candidates: [{ id: 'p1' }], correlationId: 'cid-2' });
  });
});
