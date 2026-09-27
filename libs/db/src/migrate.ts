// Forward-only SQL migration runner (implementation rules §1: plain SQL in services/<svc>/migrations; CLAUDE.md §3.2).
// - Files `NNNN_name.sql`, applied in lexical order, each in its own transaction as `<schema>_owner`.
// - Applied files are checksummed; editing an applied file is an error (write a new migration instead).
// - A per-schema advisory lock stops two deploys migrating at once.
// - Backward-compatibility lint: destructive statements (DROP/RENAME/ALTER TYPE/SET NOT NULL) need an explicit
//   `-- contract:` marker explaining which earlier expand step made them safe (expand → migrate → contract).
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  /** Migrator role connection (direct or session-mode; not the transaction pooler). */
  connectionString: string;
  schema: string;
  dir: string;
  /** Tracking table inside the schema. Default `schema_migrations`. */
  table?: string;
  /** Role to run DDL as. Default `<schema>_owner`. */
  ownerRole?: string;
  /** Default 30 s per file. */
  statementTimeoutMs?: number;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

const FILE = /^(\d{4,14})_([a-z0-9_]+)\.sql$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

const DESTRUCTIVE: { re: RegExp; what: string }[] = [
  { re: /\bdrop\s+(table|column|schema|type|view|materialized\s+view)\b/i, what: 'DROP' },
  { re: /\balter\s+table\b[^;]*\brename\b/i, what: 'RENAME' },
  {
    re: /\balter\s+table\b[^;]*\balter\s+(column\s+)?\w+\s+(set\s+data\s+)?type\b/i,
    what: 'ALTER COLUMN TYPE',
  },
  { re: /\balter\s+table\b[^;]*\bset\s+not\s+null\b/i, what: 'SET NOT NULL' },
  { re: /\btruncate\b/i, what: 'TRUNCATE' },
];

const stripComments = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Returns problems that break backward compatibility unless the file declares a `-- contract:` step. */
export function lintMigration(sqlText: string): string[] {
  if (/^--\s*contract:\s*\S/m.test(sqlText)) return [];
  const body = stripComments(sqlText);
  return DESTRUCTIVE.filter((d) => d.re.test(body)).map(
    (d) =>
      `${d.what} is not backward compatible; split into expand → migrate → contract and mark the contract file with "-- contract: <reason>"`,
  );
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const f of names) {
    const m = FILE.exec(f);
    if (!m) throw new Error(`migration file name must be NNNN_snake_name.sql: ${f}`);
    const version = m[1] as string;
    if (seen.has(version)) throw new Error(`duplicate migration version ${version}`);
    seen.add(version);
    const sqlText = await readFile(join(dir, f), 'utf8');
    const problems = lintMigration(sqlText);
    if (problems.length) throw new Error(`${f}: ${problems.join('; ')}`);
    files.push({
      version,
      name: m[2] as string,
      sql: sqlText,
      checksum: createHash('sha256').update(sqlText).digest('hex'),
    });
  }
  return files;
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const table = options.table ?? 'schema_migrations';
  const owner = options.ownerRole ?? `${options.schema}_owner`;
  for (const id of [options.schema, table, owner]) {
    if (!IDENT.test(id)) throw new Error(`invalid identifier: ${id}`);
  }
  const files = await loadMigrations(options.dir);
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: `migrate:${options.schema}`,
  });
  await client.connect();
  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [`migrate:${options.schema}`]);
    await client.query(`set role ${owner}`);
    await client.query(
      `create table if not exists ${options.schema}.${table} (
         version text primary key,
         name text not null,
         checksum text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>(
      `select version, checksum from ${options.schema}.${table}`,
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const known = new Set(files.map((f) => f.version));
    const unknown = [...applied.keys()].filter((v) => !known.has(v));
    if (unknown.length)
      throw new Error(`database has migrations missing from ${options.dir}: ${unknown.join(', ')}`);

    for (const f of files) {
      const prior = applied.get(f.version);
      if (prior !== undefined) {
        if (prior !== f.checksum) {
          throw new Error(
            `migration ${f.version}_${f.name} was edited after being applied (forward-only: add a new file)`,
          );
        }
        result.alreadyApplied.push(f.version);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(`set local search_path = ${options.schema}`);
        await client.query(
          `set local statement_timeout = ${Math.trunc(options.statementTimeoutMs ?? 30_000)}`,
        );
        await client.query(f.sql);
        await client.query(
          `insert into ${options.schema}.${table} (version, name, checksum) values ($1, $2, $3)`,
          [f.version, f.name, f.checksum],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${f.version}_${f.name} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(f.version);
    }
    return result;
  } finally {
    await client.query('reset role').catch(() => {});
    await client
      .query('select pg_advisory_unlock(hashtext($1))', [`migrate:${options.schema}`])
      .catch(() => {});
    await client.end();
  }
}
