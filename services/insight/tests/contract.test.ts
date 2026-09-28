// INS-07 contract checks: every operation of contracts/openapi/insight.yaml has a handler (svc.unimplemented() is
// empty), staff operations refuse missing or foreign credentials, and the platform endpoints answer in the contract's
// compact style. Responses are validated against the contract in every test file (validateResponses in tests); the
// global setup fails the run unless each operation was exercised with a 2xx and a 4xx.
import { afterAll, describe, expect, it } from 'vitest';
import spec from '@11e/contracts/openapi/insight.json' with { type: 'json' };
import { env, harness, ids } from './helpers.js';

const h = harness();
afterAll(() => h.close());

const operations = Object.entries(spec.paths as Record<string, Record<string, { operationId?: string; security?: unknown[] }>>).flatMap(
  ([path, item]) =>
    Object.entries(item)
      .filter(([, op]) => typeof op === 'object' && op && 'operationId' in op)
      .map(([method, op]) => ({ path, method: method.toUpperCase(), operationId: op.operationId as string, security: op.security ?? [] })),
);

describe('insight contract', () => {
  it('implements all 20 operations', async () => {
    expect(operations).toHaveLength(20);
    // live / ready are served by libs/http createService itself (before any operation route)
    expect(h.svc.unimplemented().filter((o) => o !== 'live' && o !== 'ready')).toEqual([]);
    expect((await h.app.request('/health/live')).status).toBe(200);
    expect((await h.app.request('/health/ready')).status).toBe(200);
  });

  it('refuses staff operations without a token (401) and scheduler operations without the cron secret', async () => {
    for (const op of operations) {
      if (op.operationId === 'live' || op.operationId === 'ready') continue;
      const path = op.path.replace('{conversationId}', ids()).replace('{idOrCode}', ids()).replace('{queue}', 'q_insight').replace('{name}', 'export-expire');
      const res = await h.app.request(path, {
        method: op.method,
        headers: { 'content-type': 'application/json' },
        ...(op.method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status, `${op.operationId}`).toBe(401);
    }
  });

  it('refuses a token for another audience and a header/claim mismatch', async () => {
    const api = await h.as(ids(), 'Manager');
    const res = await h.app.request('/v1/chat/plan-catalogue', { headers: { authorization: 'Bearer not-a-jwt' } });
    expect(res.status).toBe(401);
    const ok = await api.get('/v1/chat/plan-catalogue');
    expect(ok.status).toBe(200);
    const mismatch = await api.get('/v1/chat/plan-catalogue', { 'x-user-role': 'Admin' });
    expect(mismatch.status).toBe(401);
  });

  it('platform endpoints use the compact style', async () => {
    const relay = await h.cron('/internal/v1/relay');
    expect(Object.keys(relay.body).sort()).toEqual(['more', 'processed']);
    const job = await h.app.request('/internal/v1/jobs/idempotency-prune', { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } });
    expect([200, 409]).toContain(job.status);
  });
});
