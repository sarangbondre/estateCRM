// Local Postgres for adapter integration tests. The web CI job runs without a database (`database: false`), so these
// suites skip cleanly when it isn't reachable; locally they run against the shared Supabase stack (`pnpm db:start`).
import pg from 'pg';
import { createDb, migrate } from '@11e/db';
import type { Kysely } from '@11e/db';
import type { WebDb } from '../src/adapters/db/schema';
import { SCHEMA } from '../src/config';

const HOST = '127.0.0.1:54322/postgres';
export const DB_URL = process.env['WEB_DATABASE_URL'] ?? `postgresql://web_svc:local_web_svc@${HOST}`;
export const MIGRATOR_URL =
  process.env['WEB_MIGRATOR_DATABASE_URL'] ?? `postgresql://web_migrator:local_web_migrator@${HOST}`;

async function reachable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

export const hasDb = await reachable();

let handle: { db: Kysely<WebDb>; close: () => Promise<void> } | undefined;
export async function testDb(): Promise<Kysely<WebDb>> {
  if (!handle) {
    await migrate({
      connectionString: MIGRATOR_URL,
      schema: SCHEMA,
      dir: new URL('../migrations', import.meta.url).pathname,
    });
    handle = createDb<WebDb>({ connectionString: DB_URL, schema: SCHEMA, maxConnections: 2 });
  }
  return handle.db;
}
export async function closeDb() {
  await handle?.close();
  handle = undefined;
}
