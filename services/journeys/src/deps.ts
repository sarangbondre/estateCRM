// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { Clock, Integrations } from './application/ports.js';
import type { Config } from './config.js';
import type { JourneysDb } from './adapters/db.js';

export interface AppDeps {
  config: Config;
  db: Kysely<JourneysDb>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
  clock: Clock;
  integrations: Integrations;
  /** Per-call budget of jobs (default 50 s; tests use less). */
  jobBudgetMs?: number;
}
