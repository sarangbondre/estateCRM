// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { Clock, Planner, RecordsReference } from './application/ports.js';
import type { Config } from './config.js';
import type { InsightDb } from './adapters/db.js';

export interface AppDeps {
  config: Config;
  db: Kysely<InsightDb>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
  clock: Clock;
  /** records reference data (vocabulary-refresh); absent = not configured (local development). */
  records?: RecordsReference;
  /** The model planner; absent = not configured (keyword fallback answers). */
  planner?: Planner;
  /** Per-call budget of jobs (default 50 s; tests use less). */
  jobBudgetMs?: number;
}
