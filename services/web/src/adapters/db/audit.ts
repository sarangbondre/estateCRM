// Audit log repository (US-35, web LLD §4.6): append under a per-tenant advisory lock so the hash chain is linear,
// cursor reads on the stored fields, chain reads for the verify job.
import { randomUUID } from 'node:crypto';
import { sql, tenantScope } from '@11e/db';
import type { Kysely, Selectable, Transaction } from '@11e/db';
import type { AuditQuery, AuditRepo, NewAudit } from '../../application/ports';
import { GENESIS_HASH, linkEntry } from '../../domain/audit';
import type { AuditEntry, Producer, Via } from '../../domain/audit';
import { sha256 } from '../crypto';
import type { AuditLogTable, WebDb } from './schema';

export function toAuditEntry(r: Selectable<AuditLogTable>): AuditEntry {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    eventId: r.event_id,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    producer: r.producer as Producer,
    action: r.action,
    actorUserId: r.actor_user_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    via: r.via as Via,
    details: r.details ?? {},
    correlationId: r.correlation_id,
    prevHash: new Uint8Array(r.prev_hash),
    entryHash: new Uint8Array(r.entry_hash),
  };
}

/** Appends one entry to the tenant's chain inside `trx`. False when the source event was already recorded. */
export async function appendAudit(trx: Transaction<WebDb>, e: NewAudit): Promise<boolean> {
  const scope = tenantScope(trx, e.tenantId);
  await sql`select pg_advisory_xact_lock(hashtext(${`audit:${e.tenantId}`}))`.execute(trx);
  if (e.eventId) {
    const dup = await scope
      .selectFrom('audit_log')
      .select('id')
      .where('event_id', '=', e.eventId)
      .limit(1)
      .executeTakeFirst();
    if (dup) return false;
  }
  const last = await scope
    .selectFrom('audit_log')
    .select(['entry_hash', 'recorded_at'])
    .orderBy('recorded_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx);
  let recordedAt = new Date(rows[0]!.now.getTime());
  const lastAt = (last as { recorded_at?: Date } | undefined)?.recorded_at;
  // Chain order is (recorded_at, id): never go backwards, even across a clock step.
  if (lastAt && recordedAt.getTime() <= lastAt.getTime()) recordedAt = new Date(lastAt.getTime() + 1);
  const prev = (last as { entry_hash?: Buffer } | undefined)?.entry_hash;
  const entry = linkEntry(
    {
      tenantId: e.tenantId,
      id: randomUUID(),
      eventId: e.eventId ?? null,
      occurredAt: new Date(e.occurredAt.getTime()),
      recordedAt,
      producer: e.producer,
      action: e.action,
      actorUserId: e.actorUserId,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      via: e.via,
      details: e.details ?? {},
      correlationId: e.correlationId,
    },
    prev ? new Uint8Array(prev) : GENESIS_HASH,
    sha256,
  );
  await scope
    .insertInto('audit_log', {
      id: entry.id,
      event_id: entry.eventId,
      occurred_at: entry.occurredAt,
      recorded_at: entry.recordedAt,
      producer: entry.producer,
      action: entry.action,
      actor_user_id: entry.actorUserId,
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      via: entry.via,
      details: JSON.stringify(entry.details),
      correlation_id: entry.correlationId,
      prev_hash: Buffer.from(entry.prevHash),
      entry_hash: Buffer.from(entry.entryHash),
    })
    .execute();
  return true;
}

export class DbAuditRepo implements AuditRepo {
  constructor(private readonly db: Kysely<WebDb>) {}

  async list(tenantId: string, q: AuditQuery): Promise<AuditEntry[]> {
    let query = tenantScope(this.db, tenantId).selectFrom('audit_log').selectAll();
    if (q.actorUserId) query = query.where('actor_user_id', '=', q.actorUserId);
    if (q.subjectType) query = query.where('subject_type', '=', q.subjectType);
    if (q.subjectId) query = query.where('subject_id', '=', q.subjectId);
    if (q.producer) query = query.where('producer', '=', q.producer);
    if (q.action) {
      query =
        'exact' in q.action
          ? query.where('action', '=', q.action.exact)
          : query.where('action', 'like', `${q.action.prefix.replace(/[%_\\]/g, '\\$&')}%`);
    }
    if (q.from) query = query.where('occurred_at', '>=', q.from);
    if (q.to) query = query.where('occurred_at', '<', q.to);
    if (q.after) {
      const { occurredAt, id } = q.after;
      query = query.where(sql<boolean>`(occurred_at, id) < (${occurredAt}, ${id}::uuid)`);
    }
    const rows = await query.orderBy('occurred_at', 'desc').orderBy('id', 'desc').limit(q.limit).execute();
    return (rows as Selectable<AuditLogTable>[]).map(toAuditEntry);
  }

  async chainSince(tenantId: string, since: Date, limit: number): Promise<AuditEntry[]> {
    const rows = await tenantScope(this.db, tenantId)
      .selectFrom('audit_log')
      .selectAll()
      .where('recorded_at', '>=', since)
      .orderBy('recorded_at')
      .orderBy('id')
      .limit(limit)
      .execute();
    return (rows as Selectable<AuditLogTable>[]).map(toAuditEntry);
  }

  async tenantsWithEntriesSince(since: Date): Promise<string[]> {
    // Phase 1 has one tenant; bounded anyway.
    const rows = await this.db.selectFrom('users').select('tenant_id').distinct().limit(100).execute();
    void since;
    return rows.map((r) => r.tenant_id);
  }

  async ensurePartitions(): Promise<void> {
    await sql`select web.ensure_audit_partitions(3)`.execute(this.db);
  }
}
