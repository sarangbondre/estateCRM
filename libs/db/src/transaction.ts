// Transactions with a per-transaction statement timeout (`SET LOCAL` is transaction-mode pooler safe) and an
// optional retry of the whole unit on serialization failures and deadlocks.
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { classifyDbError } from './errors.js';

export interface TransactionOptions {
  /** Statement timeout inside the transaction. Default 2000 ms (conventions: sync API budget). */
  statementTimeoutMs?: number;
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  /** Extra attempts after a retryable failure. Default 2. */
  retries?: number;
}

export async function withTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const timeout = Math.max(1, Math.trunc(options.statementTimeoutMs ?? 2000));
  for (let attempt = 0; ; attempt++) {
    try {
      let builder = db.transaction();
      if (options.isolationLevel) builder = builder.setIsolationLevel(options.isolationLevel);
      return await builder.execute(async (trx) => {
        await sql`select set_config('statement_timeout', ${String(timeout)}, true)`.execute(trx);
        return fn(trx);
      });
    } catch (err) {
      if (attempt >= retries || !classifyDbError(err).retryable) throw err;
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt * (0.5 + Math.random())));
    }
  }
}
