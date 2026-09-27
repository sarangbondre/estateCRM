// Chunks (LLD §3.2), fingerprints (§3.5) and raw-row partitions (§3.3) on Postgres.
import { sql, tenantScope } from '@11e/db';
import type { Kysely, Selectable, Transaction } from '@11e/db';
import type {
  ChunkRecord,
  ChunkRepository,
  ChunkStatus,
  FingerprintRepository,
  RawRowRepository,
} from '../../application/ports.js';
import type { IntakeDb, UploadChunksTable } from '../db.js';

type Db = Kysely<IntakeDb> | Transaction<IntakeDb>;

const toChunk = (r: Selectable<UploadChunksTable>): ChunkRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  uploadId: r.upload_id,
  chunkNo: r.chunk_no,
  rowFrom: r.row_from,
  rowTo: r.row_to,
  path: r.chunk_file_path,
  status: r.status as ChunkStatus,
  attempts: r.attempts,
});

export function chunkRepository(db: Db): ChunkRepository {
  return {
    async insertMany(chunks) {
      for (let i = 0; i < chunks.length; i += 1000) {
        const part = chunks.slice(i, i + 1000);
        const tenantId = part[0]?.tenantId;
        if (!tenantId) continue;
        await tenantScope(db, tenantId)
          .insertInto(
            'upload_chunks',
            part.map((c) => ({
              id: c.id,
              upload_id: c.uploadId,
              chunk_no: c.chunkNo,
              row_from: c.rowFrom,
              row_to: c.rowTo,
              chunk_file_path: c.path,
              error_code: null,
            })),
          )
          .onConflict((oc) => oc.columns(['tenant_id', 'upload_id', 'chunk_no']).doNothing())
          .execute();
      }
    },

    async lease(tenantId, uploadId, chunkNo, leaseSec, maxLive) {
      // One statement: the semaphore count and the conditional update see the same snapshot; the per-tenant
      // advisory lock serialises concurrent leases so the cap cannot be overshot.
      await sql`select pg_advisory_xact_lock(hashtext(${`intake-chunk-lease:${tenantId}`}))`.execute(db);
      const live = await tenantScope(db, tenantId)
        .selectFrom('upload_chunks')
        .select(sql<string>`count(*)`.as('n'))
        .where('status', '=', 'leased')
        .where('leased_until', '>', sql<Date>`now()`)
        .executeTakeFirst();
      const current = await tenantScope(db, tenantId)
        .selectFrom('upload_chunks')
        .selectAll()
        .where('upload_id', '=', uploadId)
        .where('chunk_no', '=', chunkNo)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { outcome: 'not-available', status: 'missing' };
      const c = current as Selectable<UploadChunksTable>;
      const expired = c.status === 'leased' && c.leased_until !== null && c.leased_until < new Date();
      if (c.status !== 'queued' && !expired)
        return { outcome: 'not-available', status: c.status as ChunkStatus };
      if (Number((live as { n?: string } | undefined)?.n ?? 0) >= maxLive && !expired)
        return { outcome: 'busy' };
      const row = await tenantScope(db, tenantId)
        .updateTable('upload_chunks')
        .set({
          status: 'leased',
          leased_until: sql<Date>`now() + make_interval(secs => ${leaseSec})`,
          attempts: sql<number>`attempts + 1`,
          started_at: sql<Date>`coalesce(started_at, now())`,
          updated_at: new Date(),
        } as never)
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { outcome: 'leased', chunk: toChunk(row as Selectable<UploadChunksTable>) };
    },

    async finish(tenantId, uploadId, chunkNo, counts) {
      await tenantScope(db, tenantId)
        .updateTable('upload_chunks')
        .set({
          status: 'done',
          leased_until: null,
          rows_accepted: counts.accepted,
          rows_rejected: counts.rejected,
          rows_unchanged: counts.unchanged,
          rows_needs_review: counts.needsReview,
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where('upload_id', '=', uploadId)
        .where('chunk_no', '=', chunkNo)
        .execute();
    },

    async fail(tenantId, uploadId, chunkNo, errorCode) {
      await tenantScope(db, tenantId)
        .updateTable('upload_chunks')
        .set({
          status: 'failed',
          leased_until: null,
          error_code: errorCode,
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where('upload_id', '=', uploadId)
        .where('chunk_no', '=', chunkNo)
        .execute();
    },

    async release(tenantId, uploadId, chunkNo) {
      await tenantScope(db, tenantId)
        .updateTable('upload_chunks')
        .set({ status: 'queued', leased_until: null, updated_at: new Date() })
        .where('upload_id', '=', uploadId)
        .where('chunk_no', '=', chunkNo)
        .where('status', '=', 'leased')
        .execute();
    },

    async cancelQueued(tenantId, uploadId) {
      const r = await tenantScope(db, tenantId)
        .updateTable('upload_chunks')
        .set({ status: 'cancelled', leased_until: null, updated_at: new Date() })
        .where('upload_id', '=', uploadId)
        .where('status', 'in', ['queued', 'leased'])
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    async paths(tenantId, uploadId) {
      const rows = await tenantScope(db, tenantId)
        .selectFrom('upload_chunks')
        .select('chunk_file_path')
        .where('upload_id', '=', uploadId)
        .limit(10_000)
        .execute();
      return rows.map((r) => (r as { chunk_file_path: string }).chunk_file_path);
    },

    async expiredLeases(now, limit) {
      const rows = await db
        .selectFrom('upload_chunks')
        .selectAll()
        .where('status', '=', 'leased')
        .where('leased_until', '<', now)
        .orderBy('leased_until')
        .limit(limit)
        .execute();
      return (rows as Selectable<UploadChunksTable>[]).map(toChunk);
    },
  };
}

export function fingerprintRepository(db: Db): FingerprintRepository {
  return {
    async getMany(tenantId, source, refs) {
      const out = new Map<string, string>();
      if (!refs.length) return out;
      const rows = await tenantScope(db, tenantId)
        .selectFrom('row_fingerprints')
        .select(['external_ref', 'content_hash'])
        .where('external_source', '=', source)
        .where('external_ref', 'in', [...new Set(refs)])
        .execute();
      for (const r of rows) out.set(r.external_ref, r.content_hash);
      return out;
    },

    async upsertMany(tenantId, source, rows) {
      for (let i = 0; i < rows.length; i += 1000) {
        const part = rows.slice(i, i + 1000);
        if (!part.length) continue;
        await tenantScope(db, tenantId)
          .insertInto(
            'row_fingerprints',
            part.map((r) => ({
              external_source: source,
              external_ref: r.externalRef,
              content_hash: r.contentHash,
              last_upload_id: r.uploadId,
              last_row_id: r.rowId,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'external_source', 'external_ref']).doUpdateSet({
              content_hash: (eb) => eb.ref('excluded.content_hash'),
              last_upload_id: (eb) => eb.ref('excluded.last_upload_id'),
              last_row_id: (eb) => eb.ref('excluded.last_row_id'),
              updated_at: new Date(),
            }),
          )
          .execute();
      }
    },

    async rekey(tenantId, entries) {
      const scope = tenantScope(db, tenantId);
      const kept = entries.filter((e) => e.action === 'kept' && e.newRefs[0] && e.newRefs[0] !== e.oldRef);
      const dropped = entries.filter((e) => e.action !== 'kept').map((e) => e.oldRef);
      for (let i = 0; i < kept.length; i += 1000) {
        const part = kept.slice(i, i + 1000);
        const olds = part.map((e) => e.oldRef);
        const news = part.map((e) => e.newRefs[0] as string);
        // new ref takes the old fingerprint (unless it already has its own), then the old one goes
        await sql`insert into intake.row_fingerprints
            (tenant_id, external_source, external_ref, content_hash, last_upload_id, last_row_id, updated_at)
          select f.tenant_id, f.external_source, m.new_ref, f.content_hash, f.last_upload_id, f.last_row_id, now()
          from unnest(${olds}::text[], ${news}::text[]) as m(old_ref, new_ref)
          join intake.row_fingerprints f
            on f.tenant_id = ${tenantId} and f.external_source = 'extractor' and f.external_ref = m.old_ref
          on conflict (tenant_id, external_source, external_ref) do nothing`.execute(db);
        dropped.push(...olds);
      }
      for (let i = 0; i < dropped.length; i += 1000) {
        await scope
          .deleteFrom('row_fingerprints')
          .where('external_source', '=', 'extractor')
          .where('external_ref', 'in', dropped.slice(i, i + 1000))
          .execute();
      }
    },
  };
}

export function rawRowRepository(db: Db): RawRowRepository {
  return {
    async ensurePartition(month) {
      await sql`select intake.ensure_raw_rows_partition(${month.toISOString().slice(0, 10)}::date)`.execute(
        db,
      );
    },
  };
}
