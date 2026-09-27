// Composition root: the only place concrete adapters are created (CLAUDE.md §3.1).
import { uuidv7 } from 'uuidv7';
import { authenticate } from '@11e/auth';
import { createDb } from '@11e/db';
import type { Kysely } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { buildApp } from './app.js';
import { SCHEMA, SERVICE, loadConfig } from './config.js';
import type { Config } from './config.js';
import type { App, IntakePolicy } from './application/context.js';
import type { FileStore } from './application/ports.js';
import type { IntakeDb } from './adapters/db.js';
import { spreadsheetReader } from './adapters/spreadsheet.js';
import { supabaseFileStore } from './adapters/storage.js';
import { unitOfWork } from './adapters/uow.js';

export function policyFrom(config: Config): IntakePolicy {
  return {
    pilotMode: config.pilotMode,
    chunkSize: config.chunkSize,
    chunkConcurrency: config.chunkConcurrency,
    chunkLeaseSec: config.pilotMode ? 120 : 330,
    maxRows: config.pilotMode ? 20_000 : 150_000,
    rawRowRetentionDays: config.pilotMode ? 30 : 730,
  };
}

/** A FileStore that refuses every call (Storage not configured, e.g. unit tests of unrelated routes). */
const missingStore: FileStore = new Proxy({} as FileStore, {
  get: () => () => Promise.reject(new Error('storage is not configured (STORAGE_URL, STORAGE_SERVICE_KEY)')),
});

export interface Overrides {
  files?: FileStore;
}

export function composeApp(config: Config, db: Kysely<IntakeDb>, overrides: Overrides = {}): App {
  const files =
    overrides.files ??
    (config.storageUrl && config.storageServiceKey
      ? supabaseFileStore({ url: config.storageUrl, serviceKey: config.storageServiceKey })
      : missingStore);
  return {
    uow: unitOfWork(db),
    files,
    sheets: spreadsheetReader(files),
    clock: { now: () => new Date() },
    ids: { uuid: () => uuidv7() },
    policy: policyFrom(config),
  };
}

export function compose(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const telemetry = setupTelemetry({ serviceName: SERVICE, env });
  const handle = createDb<IntakeDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  });
  const obs = observe(SERVICE);
  const auth = authenticate({ service: SERVICE, jwksUrl: config.jwksUrl, cronSecret: config.cronSecret });
  const app = composeApp(config, handle.db);
  const svc = buildApp({ config, db: handle.db, obs, auth, app });
  return {
    config,
    app: svc.app,
    shutdown: async () => {
      await handle.close();
      await telemetry.shutdown();
    },
  };
}
