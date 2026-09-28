// Composition root: the only place concrete adapters are created (CLAUDE.md §3.1).
import type { Kysely } from 'kysely';
import { authenticate } from '@11e/auth';
import { createDb } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { buildApp } from './app.js';
import { SCHEMA, SERVICE, loadConfig } from './config.js';
import type { Config } from './config.js';
import { createApp } from './application/context.js';
import type { App, AppPorts } from './application/context.js';
import { HmacKeyedHash, UuidV7, systemClock } from './adapters/crypto.js';
import { KyselyUnitOfWork, knownTenants } from './adapters/db/uow.js';
import type { RecordsDb } from './adapters/db/schema.js';
import { createIntakeClient } from './adapters/intake.js';
import { createPhotoStore, createImageFetcher } from './adapters/storage.js';
import { contactRedactor } from './adapters/redactor.js';

/** Application ports on real adapters; tests pass overrides (fakes for intake, storage, images). */
export function composeApp(config: Config, db: Kysely<RecordsDb>, overrides: Partial<AppPorts> = {}): App {
  return createApp({
    uow: new KyselyUnitOfWork(db),
    clock: systemClock,
    ids: new UuidV7(),
    hash: new HmacKeyedHash({
      contactHashSecret: config.contactHashSecret,
      scanSalt: config.scanSalt,
      scanSaltVersion: config.scanSaltVersion,
    }),
    redactor: contactRedactor,
    intake: createIntakeClient(config),
    photoStore: createPhotoStore(config),
    images: createImageFetcher(),
    tenantIds: config.tenantIds,
    knownTenants: () => knownTenants(db),
    ...overrides,
  });
}

export function compose(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const telemetry = setupTelemetry({ serviceName: SERVICE, env });
  const handle = createDb<RecordsDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  });
  const obs = observe(SERVICE);
  const auth = authenticate({ service: SERVICE, jwksUrl: config.jwksUrl, cronSecret: config.cronSecret });
  const svc = buildApp({ config, db: handle.db, obs, auth, app: composeApp(config, handle.db) });
  return {
    config,
    app: svc.app,
    shutdown: async () => {
      await handle.close();
      await telemetry.shutdown();
    },
  };
}
