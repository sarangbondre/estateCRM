import { readFileSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { operations } from '@11e/contracts/records';
import { createService } from '@11e/http';
import type { OpenApiDoc, Service } from '@11e/http';
import {
  assertTenant,
  authenticate,
  createServiceTokenClient,
  hashApiKey,
  principalOf,
  requireStaff,
  secretsEqual,
  tenantOf,
} from '../src/index.js';

const spec = JSON.parse(
  readFileSync(new URL('../../../contracts/generated/openapi/records.json', import.meta.url), 'utf8'),
) as OpenApiDoc;
const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000009';
const USER = '00000000-0000-4000-8000-000000000002';
const CRON = 'cron-secret-for-tests';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let privateKey: Key;
let foreignKey: Key;
let jwks: JSONWebKeySet;
let svc: Service<operations>;

const sign = (
  claims: Record<string, unknown>,
  opts: { key?: Key; aud?: string; iss?: string; exp?: string } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(opts.iss ?? 'web')
    .setAudience(opts.aud ?? 'records')
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);

const userToken = (role = 'Supply agent', extra: Record<string, unknown> = {}, opts = {}) =>
  sign({ sub: 'web', tid: TENANT, uid: USER, role, ...extra }, opts);
const serviceToken = (caller: string, opts = {}) => sign({ sub: caller, tid: TENANT }, opts);
const userHeaders = (token: string, role = 'Supply agent') => ({
  authorization: `Bearer ${token}`,
  'x-user-id': USER,
  'x-user-role': role,
  'x-tenant-id': TENANT,
});

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  foreignKey = (await generateKeyPair('ES256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] };

  svc = createService<operations>({
    service: 'records',
    spec,
    ready: async () => ({ ok: true }),
    validateResponses: false,
    operationMiddleware: [
      authenticate({
        service: 'records',
        jwks,
        cronSecret: CRON,
      }),
    ],
  });
  svc.op('listMicromarkets', (c) => c.json({ principal: principalOf(c), tenant: tenantOf(c) }));
  svc.op('createMicromarket', (c) => c.json({ ok: requireStaff(c, ['Admin']).role }, 201));
  svc.op('internalGetScanTerms', (c) => c.json(principalOf(c)));
  svc.op('recordsRelay', (c) => c.json(principalOf(c)));
  svc.op('getOffer', (c) => {
    assertTenant(c, OTHER_TENANT);
    return c.json({});
  });
});

const get = (path: string, headers: Record<string, string> = {}) => svc.app.request(path, { headers });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

describe('staff (user-context) tokens', () => {
  it('accepts a valid token whose headers match the claims, and exposes the principal', async () => {
    const r = await get('/v1/micromarkets', userHeaders(await userToken()));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      principal: { kind: 'staff', userId: USER, role: 'Supply agent', tenantId: TENANT },
      tenant: TENANT,
    });
  });

  it('401 without credentials, with a foreign key, expired, wrong audience or wrong issuer', async () => {
    expect((await get('/v1/micromarkets')).status).toBe(401);
    for (const t of [
      await userToken('Supply agent', {}, { key: foreignKey }),
      await userToken('Supply agent', {}, { exp: '-1m' }),
      await userToken('Supply agent', {}, { aud: 'listings' }),
      await userToken('Supply agent', {}, { iss: 'evil' }),
    ]) {
      const r = await get('/v1/micromarkets', userHeaders(t));
      expect(r.status).toBe(401);
      expect(await codeOf(r)).toBe('unauthenticated');
    }
  });

  it('401 when X-User-* headers disagree with the token (tampering)', async () => {
    const t = await userToken('Supply agent');
    const r = await get('/v1/micromarkets', { ...userHeaders(t), 'x-user-role': 'Admin' });
    expect(r.status).toBe(401);
  });

  it('enforces x-roles from the contract (createMicromarket is Admin only)', async () => {
    const body = {
      method: 'POST',
      body: JSON.stringify({ name: 'Powai', city: 'Mumbai' }),
      headers: { 'content-type': 'application/json' },
    };
    const agent = await svc.app.request('/v1/micromarkets', {
      ...body,
      headers: { ...body.headers, ...userHeaders(await userToken('Supply agent')) },
    });
    expect(agent.status).toBe(403);
    const admin = await svc.app.request('/v1/micromarkets', {
      ...body,
      headers: { ...body.headers, ...userHeaders(await userToken('Admin'), 'Admin') },
    });
    expect(admin.status).not.toBe(403);
    expect(admin.status).not.toBe(401);
  });

  it('assertTenant hides other tenants’ resources as 404', async () => {
    const r = await get('/v1/offers/OFF-1', userHeaders(await userToken()));
    expect(r.status).toBe(404);
  });
});

describe('service tokens', () => {
  it('accepts an allowed caller (x-callers) and rejects others', async () => {
    const ok = await get('/internal/v1/properties/5b0f7c1e-3a53-4c1c-9d5b-0a9a3c2f1d11/scan-terms', {
      authorization: `Bearer ${await serviceToken('listings')}`,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: 'service', caller: 'listings', tenantId: TENANT });
    const wrong = await get('/internal/v1/properties/5b0f7c1e-3a53-4c1c-9d5b-0a9a3c2f1d11/scan-terms', {
      authorization: `Bearer ${await serviceToken('insight')}`,
    });
    expect(wrong.status).toBe(403);
  });

  it('a user token is not accepted on a service-only route, and vice versa', async () => {
    const r = await get(
      '/internal/v1/properties/5b0f7c1e-3a53-4c1c-9d5b-0a9a3c2f1d11/scan-terms',
      userHeaders(await userToken()),
    );
    expect(r.status).toBe(403);
  });

  it('routes allowing staff or service accept a service token too', async () => {
    const r = await get('/v1/micromarkets', { authorization: `Bearer ${await serviceToken('journeys')}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ principal: { kind: 'service', caller: 'journeys' } });
  });
});

describe('scheduler (cron secret)', () => {
  it('accepts the configured secret only', async () => {
    const post = (secret?: string) =>
      svc.app.request('/internal/v1/relay', {
        method: 'POST',
        headers: secret ? { 'x-cron-secret': secret } : {},
      });
    expect((await post(CRON)).status).toBe(200);
    expect((await post('nope')).status).toBe(401);
    expect((await post()).status).toBe(401);
    const bearer = await svc.app.request('/internal/v1/relay', {
      method: 'POST',
      headers: { authorization: `Bearer ${await serviceToken('records')}` },
    });
    expect(bearer.status).toBe(401);
  });
});

describe('helpers', () => {
  it('secretsEqual and hashApiKey', () => {
    expect(secretsEqual('a', 'a')).toBe(true);
    expect(secretsEqual('a', 'b')).toBe(false);
    expect(secretsEqual(undefined, 'a')).toBe(false);
    expect(secretsEqual('', '')).toBe(false);
    expect(hashApiKey('k')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('service token client caches per audience+tenant, refreshes before expiry, and dedupes concurrent fetches', async () => {
    let now = 1_000_000;
    let calls = 0;
    const client = createServiceTokenClient({
      webUrl: 'http://web.internal',
      credential: 'cred',
      now: () => now,
      fetch: async (_url, init) => {
        calls++;
        expect(new Headers(init?.headers).get('x-service-credential')).toBe('cred');
        const body = JSON.parse(String(init?.body)) as { audience: string };
        return new Response(
          JSON.stringify({
            token: `t-${body.audience}-${calls}`,
            expiresAt: new Date(now + 300_000).toISOString(),
          }),
          { status: 200 },
        );
      },
    });
    const [a, b] = await Promise.all([client.token('records', TENANT), client.token('records', TENANT)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    now += 200_000;
    expect(await client.token('records', TENANT)).toBe(a);
    now += 50_000; // within 60 s of expiry
    expect(await client.token('records', TENANT)).not.toBe(a);
    expect(await (await client.headersFor('intake', TENANT))()).toEqual({
      authorization: `Bearer t-intake-3`,
    });
  });
});
