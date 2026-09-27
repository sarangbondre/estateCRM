// Composition root: the only place concrete adapters are created (CLAUDE.md §3.1).
import { authenticate } from '@11e/auth';
import { createDb } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { buildApp } from './app.js';
import { SCHEMA, SERVICE, loadConfig } from './config.js';
import type { ListingsDb } from './adapters/db.js';
import { createRecordsClient } from './adapters/records-client.js';
import { metadataStripper } from './adapters/storage.js';
import { coreServices, platformAdapters } from './wiring.js';

export function compose(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const telemetry = setupTelemetry({ serviceName: SERVICE, env });
  const handle = createDb<ListingsDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: config.poolMax,
  });
  const obs = observe(SERVICE);
  const records = config.serviceCredential
    ? createRecordsClient({
        recordsUrl: config.recordsUrl,
        webUrl: config.webUrl,
        credential: config.serviceCredential,
        onCall: obs.onCall,
      })
    : undefined;
  const services = coreServices(config, handle.db, {
    ...(records
      ? { scanTerms: records.scanTerms, micromarkets: records.micromarkets, photoSource: records.photos }
      : {}),
    images: metadataStripper,
  });
  const platform = platformAdapters(config, handle.db);
  const auth = authenticate({
    service: SERVICE,
    jwksUrl: config.jwksUrl,
    cronSecret: config.cronSecret,
    verifyApiKey: platform.website.verify,
  });
  const svc = buildApp({ config, db: handle.db, obs, auth, services, ...platform });
  return {
    config,
    app: svc.app,
    shutdown: async () => {
      await handle.close();
      await telemetry.shutdown();
    },
  };
}
