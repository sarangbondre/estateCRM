// Platform wiring on the local stack (`pnpm db:start`): migrations, health, authentication, and the relay, drain and jobs endpoints.
import { readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION } from '../src/config.js';
import { env, harness } from './helpers.js';

const h = harness();
afterAll(() => h.close());

const cron = { 'x-cron-secret': env.CRON_SECRET };

describe('insight platform', () => {
  it('EXPECTED_MIGRATION is the newest migration file', () => {
    const newest = readdirSync(new URL('../migrations', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .at(-1);
    expect(newest?.slice(0, 4)).toBe(EXPECTED_MIGRATION);
  });

  it('serves health and readiness', async () => {
    expect((await h.app.request('/health/live')).status).toBe(200);
    const ready = (await (await h.app.request('/health/ready')).json()) as { status: string; checks: Record<string, string> };
    expect(ready.status).toBe('ok');
    expect(ready.checks.db).toBe('ok');
  });

  it('relay and drain run with the cron secret and refuse without it', async () => {
    expect((await h.app.request('/internal/v1/relay', { method: 'POST' })).status).toBe(401);
    const relay = await h.app.request('/internal/v1/relay', { method: 'POST', headers: cron });
    expect(relay.status).toBe(200); // body shape is checked against the contract (validateResponses in tests)
    const drain = await h.app.request('/internal/v1/drain/q_insight', { method: 'POST', headers: cron });
    expect(drain.status).toBe(200);
  });

  it('rejects unknown queues and jobs', async () => {
    expect((await h.app.request('/internal/v1/drain/q_nope', { method: 'POST', headers: cron })).status).toBe(400);
    expect((await h.app.request('/internal/v1/jobs/no-such-job', { method: 'POST', headers: cron })).status).toBe(400);
  });

  it('runs the idempotency-prune and rollup-reconcile jobs', async () => {
    const prune = await h.cron('/internal/v1/jobs/idempotency-prune');
    expect(prune.status).toBe(200);
    const reconcile = await h.cron('/internal/v1/jobs/rollup-reconcile');
    expect(reconcile.status).toBe(200);
  });
});
