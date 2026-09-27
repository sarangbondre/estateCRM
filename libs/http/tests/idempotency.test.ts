// Idempotency-Key end to end: HTTP layer + @11e/db store on the local stack (`pnpm db:start`).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@11e/db';
import type { IdempotencyKeysTable } from '@11e/db';
import type { operations } from '@11e/contracts/records';
import { HttpError, createService, idempotent } from '../src/index.js';
import type { OpenApiDoc } from '../src/index.js';

const ADMIN =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SCHEMA = `it_http_${randomUUID().slice(0, 8)}`;
const spec = JSON.parse(
  readFileSync(new URL('../../../contracts/generated/openapi/records.json', import.meta.url), 'utf8'),
) as OpenApiDoc;
const who = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
};
const PROPERTY = '5b0f7c1e-3a53-4c1c-9d5b-0a9a3c2f1d11';

const admin = new pg.Client({ connectionString: ADMIN });
const handle = createDb<{ idempotency_keys: IdempotencyKeysTable }>({
  connectionString: ADMIN,
  schema: SCHEMA,
});

beforeAll(async () => {
  await admin.connect();
  await admin.query(`create schema ${SCHEMA}`);
  await admin.query(
    `set search_path = ${SCHEMA}; ${readFileSync(new URL('../../db/sql/idempotency_keys.sql', import.meta.url), 'utf8')}; reset search_path;`,
  );
});
afterAll(async () => {
  await handle.close();
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.end();
});

describe('idempotent()', () => {
  let created = 0;
  let mode: 'ok' | 'boom' | 'reject' = 'ok';
  const svc = createService<operations>({
    service: 'records',
    spec,
    ready: async () => ({ ok: true }),
    validateResponses: false,
  });
  svc.op('createOffer', (c, input) =>
    idempotent(c, handle.db, who, input.body, async () => {
      if (mode === 'boom') throw new Error('db down');
      if (mode === 'reject') throw new HttpError(409, 'conflict', { detail: 'offer exists' });
      created++;
      return { status: 201, body: { n: created } };
    }),
  );
  const post = (
    key: string | undefined,
    body: unknown = { propertyId: PROPERTY, offer: { dealType: 'Lease' } },
  ) =>
    svc.app.request('/v1/offers', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    });

  it('replays the first response for the same key and body', async () => {
    const key = randomUUID();
    const a = await post(key);
    const b = await post(key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await b.json()).toEqual(await a.json());
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(created).toBe(1);
  });

  it('409 idempotency-key-reused for the same key with a different body', async () => {
    const key = randomUUID();
    await post(key);
    const r = await post(key, { propertyId: PROPERTY, offer: { dealType: 'Sale' } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'idempotency-key-reused' });
  });

  it('releases the key after a 5xx so the client can retry, but keeps 4xx outcomes', async () => {
    const key = randomUUID();
    mode = 'boom';
    expect((await post(key)).status).toBe(500);
    mode = 'ok';
    expect((await post(key)).status).toBe(201);

    const key2 = randomUUID();
    mode = 'reject';
    expect((await post(key2)).status).toBe(409);
    mode = 'ok';
    const replay = await post(key2);
    expect(replay.status).toBe(409);
    expect(replay.headers.get('content-type')).toBe('application/problem+json');
    expect(await replay.json()).toMatchObject({ code: 'conflict', detail: 'offer exists' });
  });

  it('runs without a key', async () => {
    const before = created;
    await post(undefined);
    await post(undefined);
    expect(created).toBe(before + 2);
  });

  it('rejects a malformed Idempotency-Key (contract: uuid)', async () => {
    expect((await post('not-a-uuid')).status).toBe(400);
  });
});
