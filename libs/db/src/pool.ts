// Pooled Postgres access through Supavisor transaction mode (data-hosting §5, ADR-0006).
// - No prepared statements: Kysely never names queries, so pg sends unnamed statements (transaction-mode safe).
// - Per-process semaphore: pg.Pool `max` + a bounded wait for a free client instead of failing immediately.
// - Role cap: when Postgres rejects a connection because the role's CONNECTION LIMIT is reached (53300), wait with
//   jittered backoff and retry until the acquire deadline. Other instances will release connections.
import { Kysely, PostgresDialect } from 'kysely';
import type { PostgresPool, PostgresPoolClient } from 'kysely';
import pg from 'pg';

export interface DbOptions {
  /** Pooler URL with the service's runtime role (`<svc>_svc`). */
  connectionString: string;
  /** The service's schema; every query builder is bound to it. */
  schema: string;
  /** In-process connection cap (capacity plan). Default 3. */
  maxConnections?: number;
  /** Longest wait for a connection, including role-cap retries. Default 2000 ms. */
  acquireTimeoutMs?: number;
  /** Idle client lifetime. Default 10 s (serverless-friendly). */
  idleTimeoutMs?: number;
  /** Shown in pg_stat_activity. */
  applicationName?: string;
}

export interface Db<DB> {
  /** Kysely bound to the service schema. */
  readonly db: Kysely<DB>;
  readonly schema: string;
  /** Close the pool (tests, graceful shutdown). */
  close(): Promise<void>;
}

const ROLE_CAP_CODES = new Set(['53300']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConnectionAcquireTimeoutError extends Error {
  override readonly name = 'ConnectionAcquireTimeoutError';
}

/** A pg.Pool whose `connect()` waits out role-cap rejections until a deadline. Exported for tests. */
export class RoleCapAwarePool implements PostgresPool {
  readonly #pool: pg.Pool;
  readonly #acquireTimeoutMs: number;

  constructor(pool: pg.Pool, acquireTimeoutMs: number) {
    this.#pool = pool;
    this.#acquireTimeoutMs = acquireTimeoutMs;
  }

  async connect(): Promise<PostgresPoolClient> {
    const deadline = Date.now() + this.#acquireTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#pool.connect();
      } catch (err) {
        const code = (err as { code?: string }).code;
        const remaining = deadline - Date.now();
        if (!code || !ROLE_CAP_CODES.has(code) || remaining <= 0) {
          if (code && ROLE_CAP_CODES.has(code)) {
            throw new ConnectionAcquireTimeoutError(
              'role connection cap reached; no connection freed in time',
              {
                cause: err,
              },
            );
          }
          throw err;
        }
        const backoff = Math.min(remaining, 25 * 2 ** Math.min(attempt, 5) * (0.5 + Math.random()));
        await sleep(backoff);
      }
    }
  }

  get options() {
    return this.#pool.options;
  }

  end(): Promise<void> {
    return this.#pool.end();
  }

  get stats() {
    return { total: this.#pool.totalCount, idle: this.#pool.idleCount, waiting: this.#pool.waitingCount };
  }
}

export function createDb<DB>(options: DbOptions): Db<DB> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 2000;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 3,
    idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
    connectionTimeoutMillis: acquireTimeoutMs,
    application_name: options.applicationName ?? options.schema,
  });
  // An idle client error (e.g. the pooler restarting) must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  const kysely = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new RoleCapAwarePool(pool, acquireTimeoutMs) }),
  }).withSchema(options.schema);
  return {
    db: kysely,
    schema: options.schema,
    close: () => kysely.destroy(),
  };
}
