// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { KeyHasher } from './application/admin.js';
import type { Services } from './application/context.js';
import type { Maintenance } from './application/jobs.js';
import type { Config } from './config.js';
import type { ListingsDb } from './adapters/db.js';
import type { RateLimiter, WebsiteAuth } from './adapters/website.js';

export interface AppDeps {
  config: Config;
  db: Kysely<ListingsDb>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
  services: Services;
  maintenance: Maintenance;
  website: WebsiteAuth;
  rateLimiter: RateLimiter;
  keyHasher: KeyHasher;
}
