// Cross-tenant job queries (Maintenance port). Job paths only; each uses a dedicated index of migration 0002.
import { expireIdempotencyKeys, sql } from '@11e/db';
import type { Kysely } from '@11e/db';
import { purgeProcessedEvents, purgePublishedOutbox } from '@11e/outbox';
import type { Maintenance, SweepRow } from '../application/jobs.js';
import type { SubjectType } from '../domain/types.js';
import { SCHEMA } from '../config.js';
import type { ListingsDb } from './db.js';

const toRow = (r: { tenant_id: string; id: string; subject_type: string; subject_id: string }): SweepRow => ({
  tenantId: r.tenant_id,
  id: r.id,
  subjectType: r.subject_type as SubjectType,
  subjectId: r.subject_id,
});

export function createMaintenance(db: Kysely<ListingsDb>): Maintenance {
  return {
    async sweepBatch(afterId, limit) {
      let q = db
        .selectFrom('publication')
        .select(['tenant_id', 'id', 'subject_type', 'subject_id'])
        .where('level', '<>', 'Private');
      if (afterId) q = q.where('id', '>', afterId);
      return (await q.orderBy('id').limit(limit).execute()).map(toRow);
    },
    async allPublicationsAfter(after, limit) {
      let q = db.selectFrom('publication').select(['tenant_id', 'id', 'subject_type', 'subject_id']);
      if (after) q = q.where(sql<boolean>`(tenant_id, id) > (${after.tenantId}::uuid, ${after.id}::uuid)`);
      return (await q.orderBy('tenant_id').orderBy('id').limit(limit).execute()).map(toRow);
    },
    async publicPayload(tenantId, id) {
      const r = await db
        .selectFrom('public_item')
        .select('payload')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .executeTakeFirst();
      return r?.payload;
    },
    async pruneChangeFeed(before, limit) {
      const r = await sql<{ n: number }>`with gone as (
          delete from change_feed where ctid in (select ctid from change_feed where occurred_at < ${before} limit ${limit})
          returning 1) select count(*)::int as n from gone`.execute(db);
      return r.rows[0]?.n ?? 0;
    },
    async pruneScans(before, limit) {
      // Keeps the latest scan of each subject (shown on C-12) however old it is.
      const r = await sql<{ n: number }>`with old as (
          select s.ctid from privacy_scan s where s.created_at < ${before}
            and exists (select 1 from privacy_scan n where n.tenant_id = s.tenant_id and n.subject_type = s.subject_type
                        and n.subject_id = s.subject_id and n.created_at > s.created_at)
          limit ${limit}),
        gone as (delete from privacy_scan where ctid in (select ctid from old) returning 1)
        select count(*)::int as n from gone`.execute(db);
      return r.rows[0]?.n ?? 0;
    },
    async pruneRateLimits(before, limit) {
      const r = await sql<{ n: number }>`with gone as (
          delete from rate_limit_bucket where api_key_id in
            (select api_key_id from rate_limit_bucket where refilled_at < ${before} limit ${limit})
          returning 1) select count(*)::int as n from gone`.execute(db);
      return r.rows[0]?.n ?? 0;
    },
    async pruneTechnical(limit) {
      const keys = await expireIdempotencyKeys(db, new Date(), limit);
      const events = await purgeProcessedEvents({ db, schema: SCHEMA }, 30, limit);
      const outbox = await purgePublishedOutbox({ db, schema: SCHEMA }, 7, limit);
      return Number(keys) + Number(events) + Number(outbox);
    },
    async expiredRotatingKeys(now, limit) {
      const rows = await db
        .selectFrom('api_key')
        .select(['tenant_id', 'id'])
        .where('status', '=', 'rotating')
        .where('grace_ends_at', '<=', now)
        .orderBy('grace_ends_at')
        .limit(limit)
        .execute();
      return rows.map((r) => ({ tenantId: r.tenant_id, id: r.id }));
    },
    async getCheckpoint(name) {
      const r = await db
        .selectFrom('job_checkpoint')
        .select('cursor')
        .where('name', '=', name)
        .executeTakeFirst();
      return r?.cursor;
    },
    async setCheckpoint(name, cursor) {
      const value = JSON.stringify(cursor);
      await db
        .insertInto('job_checkpoint')
        .values({ name, cursor: value, updated_at: new Date() })
        .onConflict((oc) => oc.column('name').doUpdateSet({ cursor: value, updated_at: new Date() }))
        .execute();
    },
  };
}
