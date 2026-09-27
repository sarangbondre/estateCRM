// Integration-test harness on the local stack (`pnpm db:start`): migrations, the app with generated signing keys, staff
// and service tokens, and a fresh tenant per test file so parallel files never see each other's rows.
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { authenticate } from '@11e/auth';
import { createDb, migrate, withTransaction } from '@11e/db';
import type { Transaction } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { SCHEMA, SERVICE, loadConfig } from '../src/config.js';
import type { CrmEngineDb } from '../src/adapters/db.js';
import { createStore } from '../src/adapters/store.js';
import type { MicromarketSource, Store, SubjectState, SubjectStateSource } from '../src/application/ports.js';
import type { MmSourceNode } from '../src/domain/micromarket.js';

const HOST = '127.0.0.1:54322/postgres';
export const env = {
  DATABASE_URL:
    process.env['CRM_ENGINE_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['CRM_ENGINE_MIGRATOR_DATABASE_URL'] ??
    `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
};

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface Harness {
  deps: AppDeps;
  app: ReturnType<typeof buildApp>['app'];
  svc: ReturnType<typeof buildApp>;
  tenant: string;
  user: string;
  staff(role?: string, opts?: { tenant?: string; user?: string }): Promise<Record<string, string>>;
  service(caller: string, opts?: { tenant?: string }): Promise<Record<string, string>>;
  cron: Record<string, string>;
  /** Runs fn with a store bound to a committed transaction. */
  tx<T>(fn: (store: Store, trx: Transaction<CrmEngineDb>) => Promise<T>): Promise<T>;
  now: { value: Date };
  micromarkets: { nodes: MmSourceNode[]; calls: number };
  /** journeys subject states served to projection-reconcile (2 per page). */
  subjectStates: { items: SubjectState[] };
  close(): Promise<void>;
}

let migrated: Promise<unknown> | undefined;

export async function harness(options: { now?: Date } = {}): Promise<Harness> {
  migrated ??= migrate({
    connectionString: env.MIGRATOR_DATABASE_URL,
    schema: SCHEMA,
    dir: new URL('../migrations', import.meta.url).pathname,
  });
  await migrated;
  const config = loadConfig(env);
  const handle = createDb<CrmEngineDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: 3,
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const privateKey: Key = pair.privateKey;
  const jwks: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }],
  };
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: env.CRON_SECRET });
  const now = { value: options.now ?? new Date('2026-10-01T06:30:00Z') };
  const micromarkets = { nodes: [] as MmSourceNode[], calls: 0 };
  const source: MicromarketSource = {
    fetchAll: async () => {
      micromarkets.calls++;
      return micromarkets.nodes;
    },
  };
  const subjectStates = { items: [] as SubjectState[] };
  const states: SubjectStateSource = {
    page: async (_t, type, cursor) => {
      const all = subjectStates.items.filter((x) => x.subjectType === type);
      const from = cursor ? Number(cursor) : 0;
      const next = from + 2 < all.length ? String(from + 2) : null;
      return { items: all.slice(from, from + 2), nextCursor: next };
    },
  };
  const deps: AppDeps = {
    config,
    db: handle.db,
    obs: observe(SERVICE, { level: 'fatal' }),
    auth,
    clock: { now: () => now.value },
    micromarkets: source,
    subjectStates: states,
  };
  const svc = buildApp(deps);
  const tenant = randomUUID();
  const user = randomUUID();
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('web')
      .setAudience(SERVICE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime('5m')
      .sign(privateKey);
  return {
    deps,
    app: svc.app,
    svc,
    tenant,
    user,
    now,
    micromarkets,
    subjectStates,
    async staff(role = 'Demand agent', o = {}) {
      const t = o.tenant ?? tenant;
      const u = o.user ?? user;
      const token = await sign({ sub: 'web', tid: t, uid: u, role });
      return { authorization: `Bearer ${token}`, 'x-user-id': u, 'x-user-role': role, 'x-tenant-id': t };
    },
    async service(caller, o = {}) {
      const token = await sign({ sub: caller, tid: o.tenant ?? tenant });
      return { authorization: `Bearer ${token}` };
    },
    cron: { 'x-cron-secret': env.CRON_SECRET },
    tx: (fn) =>
      withTransaction(
        handle.db,
        (trx) => fn(createStore(trx, { correlationId: `test-${randomUUID()}`, now: () => now.value }), trx),
        {
          statementTimeoutMs: 30_000,
        },
      ),
    close: () => handle.close(),
  };
}
