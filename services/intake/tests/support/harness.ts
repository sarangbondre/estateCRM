// Test harness: migrated local schema, the real app with a test JWKS, a fresh tenant per test (isolation without
// cleanup), token helpers, in-memory Storage, and outbox events checked against the AsyncAPI payload schemas.
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { authenticate } from '@11e/auth';
import { createDb, migrate } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../../src/app.js';
import { SCHEMA, SERVICE, loadConfig } from '../../src/config.js';
import { composeApp } from '../../src/main.js';
import type { Overrides } from '../../src/main.js';
import type { App } from '../../src/application/context.js';
import type { IntakeDb } from '../../src/adapters/db.js';
import { dbEnv } from './env.js';
import { validateEvent } from './events.js';
import { MemoryFileStore } from './fakes.js';

export type Role = 'Admin' | 'Manager' | 'Demand agent' | 'Supply agent' | 'Data operator';

export interface Envelope {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  data: Record<string, unknown>;
}

export interface CallResult {
  status: number;
  body: Record<string, unknown> & { items?: Record<string, unknown>[] };
  headers: Headers;
}

let migrated = false;

export async function createHarness(overrides: Overrides & { env?: Record<string, string> } = {}) {
  if (!migrated) {
    await migrate({
      connectionString: dbEnv.MIGRATOR_DATABASE_URL,
      schema: SCHEMA,
      dir: new URL('../../migrations', import.meta.url).pathname,
    });
    migrated = true;
  }
  const config = loadConfig({ ...dbEnv, ENVIRONMENT_NAME: 'test', ...overrides.env });
  const handle = createDb<IntakeDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  });
  const files = (overrides.files as MemoryFileStore | undefined) ?? new MemoryFileStore();
  const app: App = composeApp(config, handle.db, { ...overrides, files });
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] };
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: dbEnv.CRON_SECRET });
  const svc = buildApp({
    config,
    db: handle.db,
    obs: observe(SERVICE, { level: (process.env['TEST_LOG'] ?? 'fatal') as 'fatal' }),
    auth,
    app,
  });
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

  const h = {
    svc,
    app,
    config,
    files,
    db: handle.db,
    cron: { 'x-cron-secret': dbEnv.CRON_SECRET },
    close: () => handle.close(),
    async staff(tenant: string, role: Role = 'Admin', userId: string = randomUUID()) {
      const token = await sign({ tid: tenant, uid: userId, role }, userId);
      return {
        authorization: `Bearer ${token}`,
        'x-user-id': userId,
        'x-user-role': role,
        'x-tenant-id': tenant,
      };
    },
    async service(tenant: string, caller: string) {
      return { authorization: `Bearer ${await sign({ tid: tenant }, caller)}` };
    },
    async call(
      method: string,
      path: string,
      headers: Record<string, string>,
      body?: unknown,
    ): Promise<CallResult> {
      const res = await svc.app.request(path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as CallResult['body']) : {},
        headers: res.headers,
      };
    },
    /** Outbox events of a tenant, oldest first, each validated against its AsyncAPI payload schema. */
    async events(tenant: string, type?: string): Promise<Envelope[]> {
      let q = handle.db.selectFrom('outbox').select(['payload']).where('tenant_id', '=', tenant);
      if (type) q = q.where('event_type', '=', type);
      const rows = await q.orderBy('occurred_at').orderBy('id').execute();
      const out: Envelope[] = [];
      for (const r of rows) {
        const env = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Envelope;
        await validateEvent(env);
        out.push(env);
      }
      return out;
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export const newTenant = () => randomUUID();
