// Test harness on the local stack: a fresh tenant per test file, a controllable clock, fake integrations, staff
// tokens signed with a test key, direct event delivery through the application handlers, and outbox inspection.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { load } from 'js-yaml';
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { authenticate } from '@11e/auth';
import { createDb, sql } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../src/app.js';
import { SCHEMA, SERVICE, loadConfig } from '../src/config.js';
import { configurePgTypes } from '../src/adapters/db.js';
import type { JourneysDb } from '../src/adapters/db.js';
import { createTokens } from '../src/adapters/integrations.js';
import { createTxRunner } from '../src/adapters/store.js';
import { handlers } from '../src/application/handlers.js';
import { allJobs } from '../src/application/jobs.js';
import type { JobName } from '../src/application/jobs.js';
import type { Handler, Incoming } from '../src/application/handlers.js';
import type { FileStoragePort, Integrations, PdfInput, Tx } from '../src/application/ports.js';
import type { OfferContent, PropertyContent } from '../src/domain/proposals.js';

configurePgTypes();

const HOST = '127.0.0.1:54322/postgres';
export const env = {
  DATABASE_URL: process.env['JOURNEYS_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['JOURNEYS_MIGRATOR_DATABASE_URL'] ?? `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
  ENVIRONMENT_NAME: 'test',
};
export const config = loadConfig(env);

/** Migrations run once in tests/global-setup.ts (vitest globalSetup); kept for readability in the test files. */
export const ensureMigrated = async (): Promise<void> => undefined;

export class TestClock {
  #now: Date;
  constructor(iso = '2026-10-01T04:30:00.000Z') {
    this.#now = new Date(iso);
  }
  now = () => new Date(this.#now);
  set(iso: string | Date) {
    this.#now = new Date(iso);
  }
  /** Moves to 10:00 IST of a date (YYYY-MM-DD). */
  day(date: string) {
    this.#now = new Date(`${date}T10:00:00+05:30`);
  }
  advanceDays(n: number) {
    this.#now = new Date(this.#now.getTime() + n * 86_400_000);
  }
}

export class MemoryStorage implements FileStoragePort {
  files = new Map<string, Uint8Array>();
  put = async (path: string, body: Uint8Array) => {
    this.files.set(path, body);
  };
  copyFromUrl = async (url: string, path: string) => {
    this.files.set(path, new TextEncoder().encode(url));
  };
  signedUrl = async (path: string, expiresInSec: number) => `https://storage.test/${path}?exp=${expiresInSec}`;
  signedUrls = async (paths: readonly string[], expiresInSec: number) => paths.map((p) => `https://storage.test/${p}?exp=${expiresInSec}`);
  remove = async (paths: readonly string[]) => {
    for (const p of paths) this.files.delete(p);
  };
}

export class FakeContent {
  offers = new Map<string, OfferContent>();
  properties = new Map<string, PropertyContent>();
  photoUrls = new Map<string, { id: string; url: string | null; caption: string | null }[]>();
  failing = false;
  rera: string | null = null;
  rendered: PdfInput[] = [];
}

export function fakeIntegrations(content = new FakeContent(), storage = new MemoryStorage()): Integrations {
  return {
    content: {
      offer: async (_t, id) => {
        if (content.failing) throw new Error('records unavailable');
        return content.offers.get(id) ?? null;
      },
      property: async (_t, id) => content.properties.get(id) ?? null,
      photos: async (_t, id) => content.photoUrls.get(id) ?? [],
    },
    publication: { mahareraAgentNumber: async () => content.rera },
    storage,
    pdf: {
      render: async (input) => {
        content.rendered.push(input);
        return new TextEncoder().encode(`%PDF-fake ${input.code}`);
      },
    },
    tokens: createTokens('test-salt'),
    publicBaseUrl: 'https://crm.test',
  };
}

/** Records (operationId, status) of every request so global-setup's teardown can check contract coverage. */
function recordingObs() {
  const obs = observe(SERVICE, { level: 'fatal' });
  const dir = process.env['JOURNEYS_HITS_DIR'];
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

export async function serviceHeaders(tenantId: string, caller: string): Promise<Record<string, string>> {
  const token = await new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer('web')
    .setAudience(SERVICE)
    .setSubject(caller)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  return { authorization: `Bearer ${token}` };
}

export function harness(opts: { clock?: TestClock; content?: FakeContent; storage?: MemoryStorage } = {}) {
  // journeys_svc has a pilot connection cap of 4: one connection per test file, waiting for a free one if needed.
  const handle = createDb<JourneysDb>({ connectionString: config.databaseUrl, schema: SCHEMA, maxConnections: 1, acquireTimeoutMs: 60_000, idleTimeoutMs: 1_000 });
  const clock = opts.clock ?? new TestClock();
  const content = opts.content ?? new FakeContent();
  const storage = opts.storage ?? new MemoryStorage();
  const integrations = fakeIntegrations(content, storage);
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: env.CRON_SECRET });
  const svc = buildApp({
    config,
    db: handle.db,
    obs: recordingObs(),
    auth,
    clock,
    integrations,
    jobBudgetMs: 20_000,
  });
  const runner = createTxRunner(handle.db, clock.now);
  const tenantId: string = randomUUID();

  const tx = <T>(fn: (tx: Tx) => Promise<T>, tenant = tenantId) => runner.run(tenant, { correlationId: 'test' }, fn);

  let versions = new Map<string, number>();
  async function deliver<T extends EventType>(
    type: T,
    data: EventDataMap[T],
    o: { aggregateId?: string; version?: number; occurredAt?: Date; tenant?: string } = {},
  ) {
    const aggregateId = o.aggregateId ?? (Object.values(data as object).find((v) => typeof v === 'string') as string);
    const version = o.version ?? (versions.get(aggregateId) ?? 0) + 1;
    versions.set(aggregateId, version);
    const e: Incoming<T> = {
      eventId: randomUUID(),
      eventType: type,
      occurredAt: (o.occurredAt ?? clock.now()).toISOString(),
      aggregateId,
      aggregateType: type.split('.')[0] as string,
      aggregateVersion: version,
      data,
    };
    const h = handlers[type] as Handler<T> | undefined;
    if (!h) throw new Error(`no handler for ${type}`);
    await tx((t) => h(t, e), o.tenant ?? tenantId);
  }

  async function as(userId: string, role: Role, tenant = tenantId) {
    const headers = await staffHeaders(tenant, userId, role);
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const res = await svc.app.request(path, {
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}),
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return { status: res.status, body: json as ApiBody, headers: Object.fromEntries(res.headers.entries()) as Record<string, string> };
    };
    return {
      get: (p: string, extra?: Record<string, string>) => call('GET', p, undefined, extra),
      post: (p: string, b?: unknown, extra?: Record<string, string>) => call('POST', p, b ?? {}, extra),
      postRaw: (p: string, extra?: Record<string, string>) => call('POST', p, undefined, extra),
      patch: (p: string, b: unknown, extra?: Record<string, string>) => call('PATCH', p, b, extra),
      put: (p: string, b: unknown, extra?: Record<string, string>) => call('PUT', p, b, extra),
      del: (p: string, extra?: Record<string, string>) => call('DELETE', p, undefined, extra),
    };
  }

  async function cron(path: string) {
    const res = await svc.app.request(path, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** Runs a job for this tenant only (no platform lease, so test files don't collide) until it reports done. */
  async function runJob(name: JobName, budgetMs = 20_000) {
    const scoped = { ...runner, tenants: async () => [tenantId] };
    const all = allJobs({ runner: scoped, clock, storage, budgetMs });
    let processed = 0;
    for (let i = 0; i < 100; i++) {
      const r = await all[name]();
      processed += r.processed;
      if (!r.remaining) return { processed };
    }
    throw new Error(`${name} did not finish`);
  }

  async function outbox(type?: EventType, tenant = tenantId) {
    const r = await sql<{ event_type: string; aggregate_id: string; aggregate_version: number; payload: { data: Record<string, unknown> } & Record<string, unknown> }>`
      select event_type, aggregate_id, aggregate_version, payload from outbox where tenant_id = ${tenant}
      ${type ? sql`and event_type = ${type}` : sql``} order by occurred_at, aggregate_version`.execute(handle.db);
    return r.rows;
  }

  async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>) {
    return (await query.execute(handle.db)).rows as T[];
  }

  return {
    svc,
    runner,
    integrations,
    app: svc.app,
    db: handle.db,
    close: () => handle.close(),
    clock,
    content,
    storage,
    tenantId,
    tx,
    deliver,
    as,
    cron,
    runJob,
    outbox,
    rows,
    resetVersions: () => (versions = new Map()),
  };
}
export type Harness = ReturnType<typeof harness>;

// ------------------------------------------------------------------------------------------ AsyncAPI payload checks
const doc = load(readFileSync(new URL('../../../contracts/asyncapi/events.yaml', import.meta.url), 'utf8')) as {
  components: { messages: Record<string, { name: string; payload: unknown }> };
};
const deref = (node: unknown, seen = new Set<string>()): unknown => {
  if (Array.isArray(node)) return node.map((n) => deref(n, seen));
  if (!node || typeof node !== 'object') return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], doc);
    return deref(target, new Set([...seen, ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, seen)]));
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
