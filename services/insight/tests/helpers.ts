// Test harness on the local stack: a fresh tenant per test file, a controllable clock, staff tokens signed with a test
// key, direct event delivery through the projector (inside a transaction, like the drain), and outbox inspection.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { load } from 'js-yaml';
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { authenticate } from '@11e/auth';
import { createDb, sql, withTransaction } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { SCHEMA, SERVICE, loadConfig } from '../src/config.js';
import { applyEvent } from '../src/application/projection.js';
import { configurePgTypes } from '../src/adapters/db.js';
import type { InsightDb } from '../src/adapters/db.js';
import { createReadModelStore } from '../src/adapters/readModelStore.js';

configurePgTypes();

const HOST = '127.0.0.1:54322/postgres';
export const env = {
  DATABASE_URL: process.env['INSIGHT_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['INSIGHT_MIGRATOR_DATABASE_URL'] ?? `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
  ENVIRONMENT_NAME: 'test',
};
export const config = loadConfig(env);

export class TestClock {
  #now: Date;
  constructor(iso = '2026-10-07T06:30:00.000Z') {
    this.#now = new Date(iso);
  }
  now = () => new Date(this.#now);
  set(iso: string | Date) {
    this.#now = new Date(iso);
  }
  advanceDays(n: number) {
    this.#now = new Date(this.#now.getTime() + n * 86_400_000);
  }
}

/** Records (operationId, status) of every request so global-setup's teardown can check contract coverage. */
function recordingObs() {
  const obs = observe(SERVICE, { level: 'fatal' });
  const dir = process.env['INSIGHT_HITS_DIR'];
  if (!dir) return obs;
  const file = join(dir, `hits-${process.pid}-${randomUUID()}.jsonl`);
  return {
    ...obs,
    onRequestEnd: (info: Parameters<typeof obs.onRequestEnd>[0]) => {
      obs.onRequestEnd(info);
      if (info.operationId) appendFileSync(file, `${JSON.stringify([info.operationId, info.status])}\n`);
    },
  };
}

const keys = await generateKeyPair('ES256');
const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'ES256' }] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiBody = Record<string, any> & { items?: Record<string, any>[]; nextCursor?: string | null };

export type Role = 'Admin' | 'Manager' | 'Demand agent' | 'Supply agent' | 'Data operator';

export async function staffHeaders(tenantId: string, userId: string, role: Role): Promise<Record<string, string>> {
  const token = await new SignJWT({ tid: tenantId, uid: userId, role })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer('web')
    .setAudience(SERVICE)
    .setSubject('web')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  return { authorization: `Bearer ${token}`, 'x-user-id': userId, 'x-user-role': role, 'x-tenant-id': tenantId };
}

export type HarnessOptions = Partial<Omit<AppDeps, 'config' | 'db' | 'obs' | 'auth' | 'clock'>> & {
  clock?: TestClock;
  config?: Partial<typeof config>;
};

export function harness(opts: HarnessOptions = {}) {
  // insight_svc may hold at most 3 connections (pilot cap): one connection per test file.
  const handle = createDb<InsightDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: 1,
    acquireTimeoutMs: 60_000,
    idleTimeoutMs: 1_000,
  });
  const clock = opts.clock ?? new TestClock();
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: env.CRON_SECRET });
  const { clock: _c, config: cfg, ...rest } = opts;
  void _c;
  const deps: AppDeps = {
    ...rest,
    config: { ...config, ...(cfg ?? {}) },
    db: handle.db,
    obs: recordingObs(),
    auth,
    clock,
    jobBudgetMs: 20_000,
  };
  const svc = buildApp(deps);
  const tenantId: string = randomUUID();

  const versions = new Map<string, number>();
  async function deliver<T extends EventType>(
    type: T,
    data: EventDataMap[T],
    o: { aggregateId?: string; version?: number; occurredAt?: Date | string; tenant?: string; producer?: string; eventId?: string } = {},
  ) {
    const aggregateId = o.aggregateId ?? (Object.values(data as object).find((v) => typeof v === 'string') as string);
    const version = o.version ?? (versions.get(aggregateId) ?? 0) + 1;
    versions.set(aggregateId, Math.max(version, versions.get(aggregateId) ?? 0));
    const tenant = o.tenant ?? tenantId;
    await withTransaction(handle.db, (trx) =>
      applyEvent(
        createReadModelStore(trx, tenant),
        {
          eventId: o.eventId ?? randomUUID(),
          eventType: type,
          occurredAt: new Date(o.occurredAt ?? clock.now()).toISOString(),
          producer: o.producer ?? 'test',
          aggregateId,
          aggregateVersion: version,
          data,
        },
        clock.now(),
      ),
    );
  }

  async function as(userId: string, role: Role, tenant = tenantId) {
    const headers = await staffHeaders(tenant, userId, role);
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const res = await svc.app.request(path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return {
        status: res.status,
        body: json as ApiBody,
        text,
        headers: Object.fromEntries(res.headers.entries()) as Record<string, string>,
      };
    };
    return {
      get: (p: string, extra?: Record<string, string>) => call('GET', p, undefined, extra),
      post: (p: string, b?: unknown, extra?: Record<string, string>) => call('POST', p, b ?? {}, extra),
      postRaw: (p: string, extra?: Record<string, string>) => call('POST', p, undefined, extra),
      del: (p: string, extra?: Record<string, string>) => call('DELETE', p, undefined, extra),
    };
  }

  async function cron(path: string) {
    const res = await svc.app.request(path, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function outbox(type?: EventType, tenant = tenantId) {
    const r = await sql<{
      event_type: string;
      aggregate_id: string;
      aggregate_version: number;
      payload: { data: Record<string, unknown> } & Record<string, unknown>;
    }>`select event_type, aggregate_id, aggregate_version, payload from outbox where tenant_id = ${tenant}
      ${type ? sql`and event_type = ${type}` : sql``} order by occurred_at, aggregate_version`.execute(handle.db);
    return r.rows;
  }

  async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>) {
    return (await query.execute(handle.db)).rows as T[];
  }

  return { svc, deps, app: svc.app, db: handle.db, close: () => handle.close(), clock, tenantId, deliver, as, cron, outbox, rows };
}
export type Harness = ReturnType<typeof harness>;

// ------------------------------------------------------------------------------------------ AsyncAPI payload checks
const doc = load(readFileSync(new URL('../../../contracts/asyncapi/events.yaml', import.meta.url), 'utf8')) as {
  components: { messages: Record<string, { name: string; payload: unknown }> };
};
const deref = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map((n) => deref(n));
  if (!node || typeof node !== 'object') return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], doc);
    return deref(target);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v)]));
};
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
const validators = new Map(
  Object.values(doc.components.messages).map((m) => [m.name, ajv.compile(deref(m.payload) as object)]),
);

/** Validates a produced envelope against its AsyncAPI payload schema; returns the error text or null. */
export function eventProblems(envelope: unknown): string | null {
  const type = (envelope as { eventType?: string }).eventType ?? '';
  const v = validators.get(type);
  if (!v) return `unknown event type ${type}`;
  return v(envelope) ? null : ajv.errorsText(v.errors);
}

export const ids = (): string => randomUUID();
