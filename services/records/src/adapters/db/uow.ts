// UnitOfWork on Kysely: one transaction per use case with the tenant-scoped store, read queries, code issuer,
// transactional outbox (libs/outbox) and private work queue sends.
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { withTransaction } from '@11e/db';
import { queueSend, writeEvent } from '@11e/outbox';
import type { EventDataMap, EventType } from '@11e/contracts/events';
import type { CodeIssuer, EmitOptions, EventSink, Tx, UnitOfWork, UnitOfWorkOptions } from '../../application/ports.js';
import { SCHEMA, SERVICE } from '../../config.js';
import { KyselyQueries } from './queries.js';
import type { RecordsDb } from './schema.js';
import { KyselyStore } from './store.js';

class OutboxSink implements EventSink {
  constructor(
    private readonly trx: Transaction<RecordsDb>,
    private readonly tenantId: string,
    private readonly correlationId: string,
    private readonly traceparent: string | undefined,
  ) {}

  async emit<T extends EventType>(type: T, aggregate: EmitOptions, data: EventDataMap[T]): Promise<void> {
    await writeEvent(this.trx, {
      eventType: type,
      tenantId: this.tenantId,
      aggregateType: aggregate.aggregateType,
      aggregateId: aggregate.aggregateId,
      aggregateVersion: aggregate.aggregateVersion,
      data,
      correlationId: this.correlationId,
      producer: SERVICE,
      ...(this.traceparent ? { traceparent: this.traceparent } : {}),
    });
  }
}

class SequenceCodes implements CodeIssuer {
  constructor(
    private readonly trx: Transaction<RecordsDb>,
    private readonly tenantId: string,
  ) {}

  async next(prefix: string, pad: number): Promise<string> {
    const [code] = await this.block(prefix, pad, 1);
    return code as string;
  }

  async block(prefix: string, pad: number, n: number): Promise<string[]> {
    if (n <= 0) return [];
    // Row lock per prefix; a batch reserves its block in one statement (gaps allowed, never reused).
    const r = await sql<{ first: string }>`
      insert into ${sql.table(`${SCHEMA}.code_sequences`)} as s (tenant_id, prefix, next_value, pad)
      values (${this.tenantId}, ${prefix}, ${1 + n}, ${pad})
      on conflict (tenant_id, prefix) do update set next_value = s.next_value + ${n}
      returning (next_value - ${n})::text as first`.execute(this.trx);
    const first = Number(r.rows[0]?.first ?? 1);
    return Array.from({ length: n }, (_, i) => `${prefix}-${String(first + i).padStart(pad, '0')}`);
  }
}

export class KyselyUnitOfWork implements UnitOfWork {
  constructor(
    private readonly db: Kysely<RecordsDb>,
    private readonly traceparent: () => string | undefined = () => undefined,
  ) {}

  run<T>(
    ctx: { tenantId: string; correlationId: string },
    fn: (tx: Tx) => Promise<T>,
    options: UnitOfWorkOptions = {},
  ): Promise<T> {
    return withTransaction(
      this.db,
      async (trx) => {
        const tx: Tx = {
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          now: new Date(),
          store: new KyselyStore(trx, ctx.tenantId),
          q: new KyselyQueries(trx, ctx.tenantId),
          codes: new SequenceCodes(trx, ctx.tenantId),
          events: new OutboxSink(trx, ctx.tenantId, ctx.correlationId, this.traceparent()),
          advisoryLock: async (key: string) => {
            await sql`select pg_advisory_xact_lock(hashtext(${`${SCHEMA}:${ctx.tenantId}:${key}`}))`.execute(trx);
          },
          enqueueWork: async (queue: string, message: Record<string, unknown>) => {
            await queueSend(trx, SCHEMA, queue, { ...message, tenantId: ctx.tenantId, correlationId: ctx.correlationId });
          },
        };
        return fn(tx);
      },
      { statementTimeoutMs: options.timeoutMs ?? 2000 },
    );
  }
}

/** Tenants with reference data (a tiny technical scan across tenants, used only by scheduled jobs). */
export async function knownTenants(db: Kysely<RecordsDb>): Promise<string[]> {
  const rows = await db.selectFrom('reference_versions').select('tenant_id').where('kind', '=', 'micromarkets').limit(1000).execute();
  return rows.map((r) => r.tenant_id);
}
