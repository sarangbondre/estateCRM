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
import { buildApi } from './adapters/http/api';
import type { WebService } from './adapters/http/api';
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
  const svc = buildApi({
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
