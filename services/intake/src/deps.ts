// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { App } from './application/context.js';
import type { Config } from './config.js';
import type { IntakeDb } from './adapters/db.js';

export interface AppDeps {
  config: Config;
  db: Kysely<IntakeDb>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
  /** Use cases' ports (built by composeApp in src/main.ts, or with fakes in tests). */
  app: App;
}
