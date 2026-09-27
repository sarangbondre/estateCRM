// Composition root: the only place concrete adapters are created (CLAUDE.md §3.1).
import { authenticate } from '@11e/auth';
import { createDb } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { buildApp } from './app.js';
import { SCHEMA, SERVICE, loadConfig } from './config.js';
import type { CrmEngineDb } from './adapters/db.js';
import { journeysSubjectStates } from './adapters/journeys-client.js';
import { recordsMicromarketSource } from './adapters/records-client.js';

export function compose(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const telemetry = setupTelemetry({ serviceName: SERVICE, env });
  const handle = createDb<CrmEngineDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  });
  const obs = observe(SERVICE);
  const auth = authenticate({ service: SERVICE, jwksUrl: config.jwksUrl, cronSecret: config.cronSecret });
  const micromarkets = recordsMicromarketSource({
    recordsUrl: config.recordsUrl,
    webUrl: config.webUrl,
    credential: config.serviceCredential,
    onCall: obs.onCall,
  });
  const subjectStates = journeysSubjectStates({
    journeysUrl: config.journeysUrl,
    webUrl: config.webUrl,
    credential: config.serviceCredential,
    onCall: obs.onCall,
  });
  const svc = buildApp({
    config,
    db: handle.db,
    obs,
    auth,
    clock: { now: () => new Date() },
    micromarkets,
    subjectStates,
  });
  return {
    config,
    app: svc.app,
    shutdown: async () => {
      await handle.close();
      await telemetry.shutdown();
    },
  };
}
