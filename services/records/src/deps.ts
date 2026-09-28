// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { App } from './application/context.js';
import type { Config } from './config.js';
import type { RecordsDb } from './adapters/db/schema.js';

export interface AppDeps {
  config: Config;
  db: Kysely<RecordsDb>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
  /** Application ports and caches (use cases). */
  app: App;
}
