// @11e/db: pooled Postgres access, tenant scoping, transactions, migrations and idempotency keys (F-08).
export { ConnectionAcquireTimeoutError, RoleCapAwarePool, createDb } from './pool.js';
export type { Db, DbOptions } from './pool.js';
export { classifyDbError } from './errors.js';
export type { DbErrorInfo, DbErrorKind } from './errors.js';
export { withTransaction } from './transaction.js';
export type { TransactionOptions } from './transaction.js';
export { InvalidTenantError, assertTenantId, tenantScope } from './tenant.js';
export type { TenantScope, TenantTable } from './tenant.js';
export { lintMigration, loadMigrations, migrate } from './migrate.js';
export type { MigrateOptions, MigrateResult, MigrationFile } from './migrate.js';
export {
  IDEMPOTENCY_WINDOW_MS,
  beginIdempotent,
  completeIdempotent,
  expireIdempotencyKeys,
  hashRequest,
  releaseIdempotent,
} from './idempotency.js';
export type { IdempotencyBegin, IdempotencyDb, IdempotencyKeysTable, IdempotencyRef } from './idempotency.js';
export { checkDbReady } from './health.js';
export type { DbReadiness } from './health.js';
export { sql } from 'kysely';
export type { ColumnType, Generated, Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely';
