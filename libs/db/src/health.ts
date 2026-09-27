// Readiness (conventions: GET /health/ready = DB reachable and migrations at the expected version).
import type { Kysely } from 'kysely';

export interface DbReadiness {
  ok: boolean;
  /** Latest applied migration version, if the tracking table is readable. */
  migration?: string;
  reason?: 'unreachable' | 'behind';
}

/**
 * @param expectedMigration the newest migration version shipped with this build (from the migrations folder).
 */
export async function checkDbReady<DB>(
  db: Kysely<DB>,
  expectedMigration: string,
  table = 'schema_migrations',
): Promise<DbReadiness> {
  try {
    // Query builder (not raw sql) so the Kysely instance's schema binding applies.
    const k = db as unknown as Kysely<Record<string, { version: string }>>;
    const row = await k
      .selectFrom(table)
      .select((eb) => eb.fn.max('version').as('version'))
      .executeTakeFirst();
    const migration = (row?.version as string | null | undefined) ?? undefined;
    const ready: DbReadiness = { ok: migration !== undefined && migration >= expectedMigration };
    if (migration !== undefined) ready.migration = migration;
    if (!ready.ok) ready.reason = 'behind';
    return ready;
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
