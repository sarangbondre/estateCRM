# @11e/db

Postgres access for every service (F-08). It's infrastructure only and holds no domain models (CLAUDE.md §3.9).

| Export                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDb<DB>({ connectionString, schema, maxConnections, acquireTimeoutMs })`                           | Kysely bound to the service schema, over a `pg` pool. Prepared statements are never named, so it's safe behind the Supavisor transaction pooler. `maxConnections` is the in-process semaphore (capacity plan). When the role's `CONNECTION LIMIT` is hit (`53300`), it waits with jittered backoff until `acquireTimeoutMs`, then throws `ConnectionAcquireTimeoutError` (data-hosting §5). |
| `tenantScope(db, tenantId)`                                                                              | `selectFrom` / `insertInto` / `updateTable` / `deleteFrom` with the tenant filter and `tenant_id` added automatically (conventions §2, NFR-15). Use it for every business-table query.                                                                                                                                                                                                      |
| `withTransaction(db, fn, { statementTimeoutMs, isolationLevel, retries })`                               | Transaction with `SET LOCAL statement_timeout` (default 2 s). Serialization failures and deadlocks are retried.                                                                                                                                                                                                                                                                             |
| `beginIdempotent` / `completeIdempotent` / `releaseIdempotent` / `expireIdempotencyKeys` / `hashRequest` | Idempotency-Key store (R-3): outcomes `new`, `replay`, `conflict` (409 `idempotency-key-reused`) and `in-progress`. 24 h window.                                                                                                                                                                                                                                                            |
| `migrate({ connectionString, schema, dir })`, `loadMigrations`, `lintMigration`, CLI `11e-migrate`       | Forward-only SQL migrations run as `<schema>_owner`, with checksums, an advisory lock and a backward-compatibility lint (see below).                                                                                                                                                                                                                                                        |
| `checkDbReady(db, expectedMigration)`                                                                    | For `GET /health/ready`: DB reachable and migrations not behind.                                                                                                                                                                                                                                                                                                                            |
| `classifyDbError(err)`                                                                                   | `unique-violation`, `serialization-failure`, `statement-timeout`, … and whether a retry is safe.                                                                                                                                                                                                                                                                                            |

## Migrations

- Files live in `services/<svc>/migrations/NNNN_snake_name.sql` and are applied in order. Each runs in its own
  transaction with `search_path = <schema>`, as the schema owner.
- **Never edit an applied file.** The checksum check fails; add a new file instead.
- **Backward compatible only:** `DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL` and `TRUNCATE` are rejected unless the
  file starts with `-- contract: <reason>`, naming the earlier expand/migrate steps that made it safe (CLAUDE.md §3.2).
- Run: `MIGRATOR_DATABASE_URL=… 11e-migrate --schema records --dir migrations`. Lint only (CI, no DB):
  `11e-migrate --check --dir migrations`. Use a direct or session connection, not the transaction pooler.
- Technical tables: copy [`sql/idempotency_keys.sql`](sql/idempotency_keys.sql) into the service's first migration.
  libs/outbox provides the outbox and processed_events templates.

## Notes

- Query builders are bound to the service schema. **Raw `sql` templates are not.** Service roles have
  `search_path = <schema>` set by the platform bootstrap, so raw SQL still resolves on the pilot, but prefer the builder.
- Integration tests need the local stack (`pnpm db:start`). They use a throwaway schema and roles.
