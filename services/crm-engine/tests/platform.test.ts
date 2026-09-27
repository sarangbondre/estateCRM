// Platform wiring on the local stack (`pnpm db:start`): migrations, health, authentication, and the relay, drain and jobs endpoints.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '@11e/auth';
import { createDb, migrate } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../src/app.js';
import { EXPECTED_MIGRATION, SCHEMA, SERVICE, loadConfig } from '../src/config.js';
import type { CrmEngineDb } from '../src/adapters/db.js';

const HOST = '127.0.0.1:54322/postgres';
const env = {
  DATABASE_URL:
    process.env['CRM_ENGINE_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['CRM_ENGINE_MIGRATOR_DATABASE_URL'] ??
    `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
};
const config = loadConfig(env);
const handle = createDb<CrmEngineDb>({ connectionString: config.databaseUrl, schema: SCHEMA });
let app: ReturnType<typeof buildApp>['app'];

beforeAll(async () => {
  await migrate({
    connectionString: env.MIGRATOR_DATABASE_URL,
    schema: SCHEMA,
    dir: new URL('../migrations', import.meta.url).pathname,
  });
  const { publicKey } = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] };
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: env.CRON_SECRET });
  app = buildApp({ config, db: handle.db, obs: observe(SERVICE, { level: 'fatal' }), auth }).app;
});
afterAll(() => handle.close());

const cron = { 'x-cron-secret': env.CRON_SECRET };

describe('crm-engine platform', () => {
  it('EXPECTED_MIGRATION is the newest migration file', () => {
    const newest = readdirSync(new URL('../migrations', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .at(-1);
    expect(newest?.slice(0, 4)).toBe(EXPECTED_MIGRATION);
  });

  it('serves health and readiness', async () => {
    expect((await app.request('/health/live')).status).toBe(200);
    expect(await (await app.request('/health/ready')).json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('relay and drain run with the cron secret and refuse without it', async () => {
    expect((await app.request('/internal/v1/relay', { method: 'POST' })).status).toBe(401);
    const relay = await app.request('/internal/v1/relay', { method: 'POST', headers: cron });
    expect(relay.status).toBe(200); // body shape is checked against the contract (validateResponses in tests)
    const drain = await app.request('/internal/v1/drain/q_crm_engine', { method: 'POST', headers: cron });
    expect(drain.status).toBe(200);
  });

  it('rejects unknown queues and jobs', async () => {
    expect((await app.request('/internal/v1/drain/q_nope', { method: 'POST', headers: cron })).status).toBe(
      400,
    );
    expect(
      (await app.request('/internal/v1/jobs/no-such-job', { method: 'POST', headers: cron })).status,
    ).toBe(400);
  });
});
