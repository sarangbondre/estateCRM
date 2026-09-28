// Platform wiring on the local stack (`pnpm db:start`): migrations, health, authentication, and the relay, drain and jobs endpoints.
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION } from '../src/config.js';
import { createHarness } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('records platform', () => {
  it('EXPECTED_MIGRATION is the newest migration file', () => {
    const newest = readdirSync(new URL('../migrations', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .at(-1);
    expect(newest?.slice(0, 4)).toBe(EXPECTED_MIGRATION);
  });

  it('serves health and readiness', async () => {
    expect((await h.app.request('/health/live')).status).toBe(200);
    expect(await (await h.app.request('/health/ready')).json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('relay and drain run with the cron secret and refuse without it', async () => {
    expect((await h.app.request('/internal/v1/relay', { method: 'POST' })).status).toBe(401);
    const relay = await h.app.request('/internal/v1/relay', { method: 'POST', headers: h.cron });
    expect(relay.status).toBe(200); // body shape is checked against the contract (validateResponses in tests)
    const drain = await h.app.request('/internal/v1/drain/q_records', { method: 'POST', headers: h.cron });
    expect(drain.status).toBe(200);
  });

  it('rejects unknown queues and jobs', async () => {
    expect((await h.app.request('/internal/v1/drain/q_nope', { method: 'POST', headers: h.cron })).status).toBe(400);
    expect((await h.app.request('/internal/v1/jobs/no-such-job', { method: 'POST', headers: h.cron })).status).toBe(400);
  });
});
