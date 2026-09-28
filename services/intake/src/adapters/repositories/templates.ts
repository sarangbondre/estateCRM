// Templates (LLD §3.6) and the vocabulary cache (§3.9) on Postgres.
import { classifyDbError, sql, tenantScope } from '@11e/db';
import type { Kysely, Selectable, Transaction } from '@11e/db';
import type { SourceType } from '../../domain/upload.js';
import type { Template } from '../../domain/template.js';
import type { LegacyTermRow, TemplateRepository, VocabularyRepository } from '../../application/ports.js';
import type { IntakeDb, TemplatesTable } from '../db.js';

type Db = Kysely<IntakeDb> | Transaction<IntakeDb>;

const toTemplate = (r: Selectable<TemplatesTable>): Template => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  sourceType: r.source_type as SourceType,
  sourceDetail: r.source_detail,
  headers: r.headers,
  headerFingerprint: r.header_fingerprint,
  columnMap: r.column_map,
  constants: r.constants,
  createdBy: r.created_by,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const isUniqueViolation = (err: unknown) => classifyDbError(err).kind === 'unique-violation';

export function templateRepository(db: Db): TemplateRepository {
  const live = (tenantId: string) =>
    tenantScope(db, tenantId).selectFrom('templates').selectAll().where('deleted_at', 'is', null);
  return {
    async insert(t) {
      try {
        await tenantScope(db, t.tenantId)
          .insertInto('templates', {
            id: t.id,
            name: t.name,
            source_type: t.sourceType,
            source_detail: t.sourceDetail,
            headers: t.headers,
            header_fingerprint: t.headerFingerprint,
            column_map: JSON.stringify(t.columnMap),
            constants: t.constants ? JSON.stringify(t.constants) : null,
            created_by: t.createdBy,
            created_at: t.createdAt,
            updated_at: t.updatedAt,
          })
          .execute();
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    async find(tenantId, id) {
      const r = await live(tenantId).where('id', '=', id).executeTakeFirst();
      return r ? toTemplate(r as Selectable<TemplatesTable>) : undefined;
    },

    async findByFingerprint(tenantId, fingerprint) {
      const r = await live(tenantId)
        .where('header_fingerprint', '=', fingerprint)
        .orderBy('updated_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r ? toTemplate(r as Selectable<TemplatesTable>) : undefined;
    },

    async list(tenantId, filter, after, limit) {
      let q = live(tenantId);
      if (filter.sourceType) q = q.where('source_type', '=', filter.sourceType);
      if (filter.headerFingerprint) q = q.where('header_fingerprint', '=', filter.headerFingerprint);
      if (after) q = q.where(sql<boolean>`(lower(name), id) > (${after.k}, ${after.id}::uuid)`);
      const rows = await q
        .orderBy(sql`lower(name)`)
        .orderBy('id')
        .limit(limit)
        .execute();
      return (rows as Selectable<TemplatesTable>[]).map(toTemplate);
    },

    async replace(t, expectedVersion) {
      try {
        let q = tenantScope(db, t.tenantId)
          .updateTable('templates')
          .set({
            name: t.name,
            source_type: t.sourceType,
            source_detail: t.sourceDetail,
            headers: t.headers,
            header_fingerprint: t.headerFingerprint,
            column_map: JSON.stringify(t.columnMap),
            constants: t.constants ? JSON.stringify(t.constants) : null,
            updated_at: new Date(),
            version: sql<number>`version + 1`,
          } as never)
          .where('id', '=', t.id)
          .where('deleted_at', 'is', null);
        if (expectedVersion !== undefined) q = q.where('version', '=', expectedVersion);
        const r = await q.returningAll().executeTakeFirst();
        return r ? toTemplate(r as Selectable<TemplatesTable>) : undefined;
      } catch (err) {
        if (isUniqueViolation(err)) return 'name-taken';
        throw err;
      }
    },

    async softDelete(tenantId, id) {
      await tenantScope(db, tenantId)
        .updateTable('templates')
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .execute();
    },
  };
}

export function vocabularyRepository(db: Db): VocabularyRepository {
  const pick = { version: 'version', checksum: 'checksum', content: 'content' } as const;
  return {
    async active(tenantId) {
      const r = await tenantScope(db, tenantId)
        .selectFrom('vocabulary_cache')
        .select([pick.version, pick.checksum, pick.content])
        .where('status', '=', 'active')
        .executeTakeFirst();
      return r as { version: string; checksum: string; content: Record<string, unknown> } | undefined;
    },

    async get(tenantId, version) {
      const r = await tenantScope(db, tenantId)
        .selectFrom('vocabulary_cache')
        .select([pick.version, pick.checksum, pick.content])
        .where('version', '=', version)
        .executeTakeFirst();
      return r as { version: string; checksum: string; content: Record<string, unknown> } | undefined;
    },

    async save(tenantId, release, terms, activate, id) {
      const scope = tenantScope(db, tenantId);
      const inserted = await scope
        .insertInto('vocabulary_cache', {
          id,
          version: release.version,
          checksum: release.checksum,
          content: JSON.stringify(release.content),
          status: 'superseded',
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'version']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted && terms.length) {
        for (let i = 0; i < terms.length; i += 500) {
          await scope
            .insertInto(
              'legacy_terms',
              terms.slice(i, i + 500).map((t) => ({
                version: release.version,
                field: t.field,
                term_norm: t.termNorm,
                maps: JSON.stringify(t.maps),
              })),
            )
            .onConflict((oc) => oc.columns(['tenant_id', 'version', 'field', 'term_norm']).doNothing())
            .execute();
        }
      }
      if (activate) {
        await scope
          .updateTable('vocabulary_cache')
          .set({ status: 'superseded', superseded_at: new Date(), updated_at: new Date() })
          .where('status', '=', 'active')
          .where('version', '<>', release.version)
          .execute();
        await scope
          .updateTable('vocabulary_cache')
          .set({ status: 'active', superseded_at: null, updated_at: new Date() })
          .where('version', '=', release.version)
          .execute();
      }
    },

    async legacyTerms(tenantId, version) {
      const rows = await tenantScope(db, tenantId)
        .selectFrom('legacy_terms')
        .select(['field', 'term_norm', 'maps'])
        .where('version', '=', version)
        .limit(10_000)
        .execute();
      return rows.map((r): LegacyTermRow => ({ field: r.field, termNorm: r.term_norm, maps: r.maps }));
    },
  };
}
