// Tokens minted by web are accepted by @11e/auth `authenticate` in a service (iss=web, aud=<service>, tid/uid/role
// claims + matching X-User-* headers; service tokens without uid), using records' real contract.
import recordsSpec from '@11e/contracts/openapi/records.json' with { type: 'json' };
import type { operations as RecordsOps } from '@11e/contracts/records';
import { authenticate, principalOf } from '@11e/auth';
import { createService } from '@11e/http';
import type { OpenApiDoc } from '@11e/http';
import { describe, expect, it } from 'vitest';
import { TENANT, makeUser } from './fakes';
import { harness } from './harness';

async function recordsWithWebJwks() {
  const h = await harness();
  const jwks = (await h.tokens.jwks()) as { keys: Record<string, unknown>[] };
  const svc = createService<RecordsOps>({
    service: 'records',
    spec: recordsSpec as unknown as OpenApiDoc,
    ready: async () => ({ ok: true }),
    operationMiddleware: [authenticate({ service: 'records', jwks: jwks as never })],
    validateResponses: false,
  });
  svc.op('getVocabulary', (c) => c.json({ principal: principalOf(c) }));
  svc.op('putLaunchArea', (c) => c.json({ principal: principalOf(c) }));
  return { h, app: svc.app };
}

describe('@11e/auth accepts web-minted tokens', () => {
  it('user-context token + matching X-User-* headers → staff principal', async () => {
    const { h, app } = await recordsWithWebJwks();
    const u = makeUser({ role: 'Supply agent', isDataOperator: true });
    const token = await h.tokens.userToken(
      { tenantId: TENANT, userId: u.id, role: u.role, isDataOperator: true, user: u },
      'records',
    );
    const headers = {
      authorization: `Bearer ${token}`,
      'x-user-id': u.id,
      'x-user-role': u.role,
      'x-tenant-id': TENANT,
    };
    const res = await app.request('/v1/vocabulary', { headers });
    expect(res.status).toBe(200);
    expect((await res.json()).principal).toMatchObject({
      kind: 'staff',
      tenantId: TENANT,
      userId: u.id,
      role: 'Supply agent',
      dop: true,
    });

    // Headers must equal the claims.
    expect(
      (await app.request('/v1/vocabulary', { headers: { ...headers, 'x-user-role': 'Admin' } })).status,
    ).toBe(401);
    // x-roles still apply in the service (putLaunchArea is Admin only).
    const put = await app.request('/v1/launch-area', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(put.status).toBe(403);
  });

  it('a token for another audience is rejected', async () => {
    const { h, app } = await recordsWithWebJwks();
    const u = makeUser();
    const token = await h.tokens.userToken(
      { tenantId: TENANT, userId: u.id, role: u.role, isDataOperator: false, user: u },
      'journeys',
    );
    const res = await app.request('/v1/vocabulary', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-user-id': u.id,
        'x-user-role': u.role,
        'x-tenant-id': TENANT,
      },
    });
    expect(res.status).toBe(401);
  });

  it('service-to-service token (no uid) → service principal', async () => {
    const { h, app } = await recordsWithWebJwks();
    h.clients.clients.set('insight-credential-0123456789abcd', {
      name: 'insight',
      allowedAudiences: ['records'],
      status: 'active',
    });
    const { token } = await h.tokens.mintForService('insight-credential-0123456789abcd', 'records', TENANT);
    const res = await app.request('/v1/vocabulary', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).principal).toMatchObject({
      kind: 'service',
      caller: 'insight',
      tenantId: TENANT,
    });
  });
});
