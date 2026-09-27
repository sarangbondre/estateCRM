// Test harness: migrated local schema, the real app with a test JWKS, per-test tenants (isolation without cleanup),
// token helpers, fakes for intake/storage, and event checks against the AsyncAPI payload schemas.
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { authenticate } from '@11e/auth';
import { createDb, migrate } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../../src/app.js';
import { SCHEMA, SERVICE, loadConfig } from '../../src/config.js';
import { composeApp } from '../../src/main.js';
import type { App, AppPorts } from '../../src/application/context.js';
import type { RecordsDb } from '../../src/adapters/db/schema.js';
import { validateEvent } from './events.js';
import { systemActor } from '../../src/application/context.js';
import { activateVocabulary } from '../../src/application/reference.js';

const HOST = '127.0.0.1:54322/postgres';
export const env = {
  DATABASE_URL: process.env['RECORDS_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['RECORDS_MIGRATOR_DATABASE_URL'] ?? `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
  ENVIRONMENT_NAME: 'test',
};

export type Role = 'Admin' | 'Manager' | 'Demand agent' | 'Supply agent' | 'Data operator';

export interface Harness {
  app: ReturnType<typeof buildApp>['app'];
  svc: ReturnType<typeof buildApp>;
  appCtx: App;
  db: ReturnType<typeof createDb<RecordsDb>>['db'];
  close(): Promise<void>;
  /** Headers of a staff user of `tenant`. */
  staff(tenant: string, role?: Role, userId?: string): Promise<Record<string, string>>;
  service(tenant: string, caller: string): Promise<Record<string, string>>;
  cron: Record<string, string>;
  /** JSON request helper. */
  call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> & { items?: Record<string, unknown>[] }; headers: Headers }>;
  /** Outbox events of a tenant (each validated against the AsyncAPI payload schema). */
  events(tenant: string, type?: string): Promise<{ eventType: string; aggregateId: string; aggregateVersion: number; data: Record<string, unknown> }[]>;
}

let migrated = false;

export async function createHarness(overrides: Partial<AppPorts> = {}): Promise<Harness> {
  if (!migrated) {
    await migrate({ connectionString: env.MIGRATOR_DATABASE_URL, schema: SCHEMA, dir: new URL('../../migrations', import.meta.url).pathname });
    migrated = true;
  }
  const config = loadConfig(env);
  const handle = createDb<RecordsDb>({ connectionString: config.databaseUrl, schema: SCHEMA, maxConnections: 3 });
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] };
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: env.CRON_SECRET });
  const appCtx = composeApp(config, handle.db, { intake: undefined, photoStore: undefined, images: undefined, tenantIds: [], ...overrides });
  const svc = buildApp({ config, db: handle.db, obs: observe(SERVICE, { level: 'fatal' }), auth, app: appCtx });
  const sign = (claims: Record<string, unknown>, sub: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('web')
      .setAudience(SERVICE)
      .setSubject(sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey as CryptoKey);

  const h: Harness = {
    app: svc.app,
    svc,
    appCtx,
    db: handle.db,
    close: () => handle.close(),
    cron: { 'x-cron-secret': env.CRON_SECRET },
    async staff(tenant, role = 'Admin', userId = randomUUID()) {
      const token = await sign({ tid: tenant, uid: userId, role }, userId);
      return { authorization: `Bearer ${token}`, 'x-user-id': userId, 'x-user-role': role, 'x-tenant-id': tenant };
    },
    async service(tenant, caller) {
      return { authorization: `Bearer ${await sign({ tid: tenant }, caller)}` };
    },
    async call(method, path, headers, body) {
      const res = await svc.app.request(path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
    },
    async events(tenant, type) {
      let q = handle.db.selectFrom('outbox').select(['payload', 'occurred_at']).where('tenant_id', '=', tenant);
      if (type) q = q.where('event_type', '=', type);
      const rows = await q.orderBy('occurred_at').orderBy('id').execute();
      return Promise.all(
        rows.map(async (r) => {
          const env = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as {
            eventType: string;
            aggregateId: string;
            aggregateVersion: number;
            data: Record<string, unknown>;
          };
          await validateEvent(env);
          return env;
        }),
      );
    },
  };
  return h;
}

export const newTenant = () => randomUUID();

/** A fresh tenant with its reference data (vocabulary v0.6 active, MMR hierarchy, launch area). */
export async function readyTenant(h: Harness): Promise<string> {
  const t = randomUUID();
  await activateVocabulary(h.appCtx, systemActor(t, 'test-setup'));
  return t;
}
