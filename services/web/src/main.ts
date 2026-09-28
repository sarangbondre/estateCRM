// Composition root (CLAUDE.md §3.1): the only place concrete adapters are created. One runtime per server instance,
// shared by the route handlers, the proxy and server-rendered pages.
import 'server-only';
import { createDb } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { uuidv7 } from 'uuidv7';
import { Sessions } from './application/sessions';
import type { EnvironmentInfo } from './application/sessions';
import { Tokens } from './application/tokens';
import type { Clock } from './application/ports';
import { SCHEMA, SERVICE, loadConfig } from './config';
import type { Config } from './config';
import { Keyring } from './adapters/crypto';
import { DbServiceClientRepo, DbSigningKeyStore } from './adapters/db/keys';
import type { WebDb } from './adapters/db/schema';
import { DbUnitOfWork } from './adapters/db/uow';
import { DbUserRepo } from './adapters/db/users';
import spec from '@11e/contracts/openapi/web.json' with { type: 'json' };
import { Gateway } from './application/gateway';
import { RouteTable } from './domain/routes';
import type { RouteEntry } from './domain/routes';
import { PgRateLimiter, PgStreamLeases } from './adapters/db/limits';
import { HttpDownstream } from './adapters/downstream';
import { buildApi } from './adapters/http/api';
import type { WebService } from './adapters/http/api';
import { containsContact } from '@11e/redaction';
import { sql } from '@11e/db';
import { AuditAndNotifications } from './application/audit';
import { Users } from './application/users';
import { IDLE_TIMEOUT_MS } from './domain/users';
import { sha256 } from './adapters/crypto';
import { DbAuditRepo } from './adapters/db/audit';
import { DbNotificationRepo } from './adapters/db/notifications';
import { JoseSigner } from './adapters/signer';
import { SupabaseAuthProvider } from './adapters/supabase';
import type { SupabaseSettings } from './adapters/supabase';

export interface Runtime {
  config: Config;
  supabase: SupabaseSettings;
  sessions: Sessions;
  tokens: Tokens;
  svc: WebService;
  keyring: Keyring;
  environment: EnvironmentInfo;
  /** Entry point for every API route handler (own endpoints, gateway, internal, health, JWKS). */
  handle(req: Request): Promise<Response>;
}

const CORRELATION = /^[A-Za-z0-9-]{8,64}$/;

/** web LLD §4.5: accept a well-formed X-Correlation-Id, otherwise mint a UUIDv7. */
export function withCorrelationId(req: Request): Request {
  const given = req.headers.get('x-correlation-id');
  if (given && CORRELATION.test(given)) return req;
  const headers = new Headers(req.headers);
  headers.set('x-correlation-id', uuidv7());
  return new Request(req, { headers });
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const config = loadConfig(env);
  setupTelemetry({ serviceName: SERVICE, env });
  const obs = observe(SERVICE);
  const clock: Clock = { now: () => new Date() };
  const db = createDb<WebDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  }).db;
  const keyring = new Keyring(config.kek);
  const supabase: SupabaseSettings = {
    url: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
    serviceRoleKey: config.supabaseServiceRoleKey,
    secureCookies: config.appOrigin.startsWith('https://'),
  };
  const auth = new SupabaseAuthProvider(supabase);
  const users = new DbUserRepo(db);
  const uow = new DbUnitOfWork(db);
  const sessions = new Sessions({ auth, users, uow, clock });
  const keys = new DbSigningKeyStore(db, keyring);
  const signer = new JoseSigner(keys, clock);
  const tokens = new Tokens({ signer, keys, clients: new DbServiceClientRepo(db, keyring), clock });
  const environment: EnvironmentInfo = {
    name: config.environment,
    pilot: config.pilot,
    vocabularyVersion: null,
  };
  const limiter = new PgRateLimiter(db, {
    onFallback: (bucket) => obs.logger.warn({ code: 'ratelimit_fallback', route: bucket }, 'rate limit store unavailable'),
  });
  const downstream = new HttpDownstream({ baseUrls: config.serviceUrls, onCall: obs.onCall });
  const routes = new RouteTable((spec as unknown as { 'x-routes': { table: RouteEntry[] } })['x-routes'].table);
  const gateway = new Gateway({
    routes,
    limiter,
    leases: new PgStreamLeases(db),
    downstream,
    tokens,
    publicTenantId: config.tenantId,
  });
  const staffAuth = { sessions, supabase, appOrigin: config.appOrigin };
  const onUserChanged = (userId: string) => {
    sessions.evict(userId);
    tokens.evictUser(userId);
  };
  const userAdmin = new Users({
    users,
    uow,
    auth,
    clock,
    hasher: { hash: (email) => keyring.hmac('email-hash', email).toString('hex') },
    onUserChanged,
  });
  const audit = new AuditAndNotifications({
    audit: new DbAuditRepo(db),
    notifications: new DbNotificationRepo(db),
    users,
    clock,
    looksLikePii: containsContact,
    onScrubbed: () => obs.logger.warn({ code: 'audit_details_scrubbed' }, 'PII removed from audit details'),
    onChainBroken: (tenantId) => obs.logger.error({ code: 'audit_chain_broken', tenantId }, 'audit hash chain broken'),
  });
  const jobs = {
    'invitation-expire': () => userAdmin.expireInvitations(),
    'idle-session-sweep': async () => {
      // Sessions idle > 12 h are refused on their next request (session-expired); drop them from this instance's caches.
      const idle = await users.listIdle(new Date(clock.now().getTime() - IDLE_TIMEOUT_MS), 500);
      for (const u of idle) onUserChanged(u.id);
      return { processed: idle.length, remaining: 0 };
    },
    'notification-prune': () => audit.pruneNotifications(),
    'rate-limit-prune': async () => {
      const processed = await limiter.prune(new Date(clock.now().getTime() - 3600_000), 5000);
      return { processed, remaining: processed >= 5000 ? 1 : 0 };
    },
    'audit-chain-verify': () => audit.verifyChains(sha256),
    'signing-key-rotate': () => tokens.rotate(),
    'keep-alive': async () => {
      await sql`select 1`.execute(db);
      return { processed: 1 };
    },
  };
  const svc = buildApi({
    users: userAdmin,
    audit,
    platform: { db, obs, audit, jobs },
    limiter,
    readyChecks: () => downstream.states(),
    gateway: { gateway, staffAuth, keyring },
    db,
    obs,
    sessions,
    tokens,
    signer,
    supabase,
    appOrigin: config.appOrigin,
    cronSecret: config.cronSecret,
    environment,
  });
  return {
    config,
    supabase,
    sessions,
    tokens,
    svc,
    keyring,
    environment,
    handle: async (req) => svc.app.fetch(withCorrelationId(req)),
  };
}

const KEY = Symbol.for('11e.web.runtime');
type Holder = { [KEY]?: Runtime };

/** The process-wide runtime (kept across dev hot reloads). */
export function runtime(): Runtime {
  const g = globalThis as Holder;
  g[KEY] ??= createRuntime();
  return g[KEY];
}
