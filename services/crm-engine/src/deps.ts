// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { Clock, MicromarketSource, SubjectStateSource } from './application/ports.js';
import type { Config } from './config.js';
import type { CrmEngineDb } from './adapters/db.js';

export interface AppDeps {
  config: Config;
  db: Kysely<CrmEngineDb>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
  clock: Clock;
  /** records' micromarket hierarchy (R-13), read with a web-minted service token by the micromarket-refresh job. */
  micromarkets: MicromarketSource;
  /** journeys' subject states (projection-reconcile), read with a web-minted service token. */
  subjectStates: SubjectStateSource;
}
