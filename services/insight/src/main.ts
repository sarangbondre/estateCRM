// Composition root: the only place concrete adapters are created (CLAUDE.md §3.1).
import { authenticate, createServiceTokenClient } from '@11e/auth';
import { createDb } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { buildApp } from './app.js';
import { SCHEMA, SERVICE, loadConfig } from './config.js';
import { configurePgTypes } from './adapters/db.js';
import type { InsightDb } from './adapters/db.js';
import { createRecordsReference, recordsHttpClient } from './adapters/records.js';

export function compose(env: NodeJS.ProcessEnv = process.env) {
  configurePgTypes();
  const config = loadConfig(env);
  const telemetry = setupTelemetry({ serviceName: SERVICE, env });
  const handle = createDb<InsightDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  });
  const obs = observe(SERVICE);
  const auth = authenticate({ service: SERVICE, jwksUrl: config.jwksUrl, cronSecret: config.cronSecret });
  const tokens = config.serviceCredential
    ? createServiceTokenClient({ webUrl: config.webUrl, credential: config.serviceCredential })
    : null;
  const records = createRecordsReference(tokens ? recordsHttpClient(config.recordsUrl) : null, tokens);
  const svc = buildApp({ config, db: handle.db, obs, auth, clock: { now: () => new Date() }, records });
  return {
    config,
    app: svc.app,
    shutdown: async () => {
      await handle.close();
      await telemetry.shutdown();
    },
  };
}
