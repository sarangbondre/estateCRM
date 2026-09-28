// DB-backed reference data: the active vocabulary release (fallback: libs/vocabulary v0.6), the micromarket
// hierarchy index, the catalogue's tenant switches and "data as of". Reads are cached per instance for 30 s
// (LLD §4.2 "cached for 30 s"; the cache is never the source of truth).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { tenantScope } from '@11e/db';
import { matchKey, releaseContent } from '@11e/vocabulary';
import type {
  CatalogueRepo,
  MicromarketNode,
  ReadModelInfo,
  ReferenceData,
  ReferenceStore,
  VocabularyReleaseDoc,
} from '../application/ports.js';
import type { LocationEntry, LocationIndex, VocabularyView } from '../domain/plans/validator.js';
import type { InsightDb } from './db.js';

const TTL_MS = 30_000;

function cached<T>(load: (tenantId: string) => Promise<T>, ttl = TTL_MS) {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  const get = (tenantId: string): Promise<T> => {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = load(tenantId).catch((err: unknown) => {
      cache.delete(tenantId);
      throw err;
    });
    cache.set(tenantId, { at: Date.now(), value });
    return value;
  };
  return Object.assign(get, { clear: () => cache.clear() });
}

export function libraryVocabulary(): VocabularyView {
  const doc = releaseContent();
  return {
    version: doc.version,
    values: Object.fromEntries(Object.entries(doc.fields).map(([f, d]) => [f, [...d.values]])),
  };
}

export function viewOf(doc: VocabularyReleaseDoc): VocabularyView {
  return { version: doc.version, values: Object.fromEntries(Object.entries(doc.fields).map(([f, d]) => [f, d.values])) };
}

export function createReferenceData(db: Kysely<InsightDb>): ReferenceData & { clear(): void } {
  const vocabulary = cached(async (tenantId): Promise<VocabularyView> => {
    const row = await tenantScope(db, tenantId)
      .selectFrom('vocabulary_release')
      .select('content')
      .where('active', '=', true)
      .executeTakeFirst();
    return row ? viewOf(row.content as VocabularyReleaseDoc) : libraryVocabulary();
  });
  const locations = cached(async (tenantId): Promise<LocationIndex> => {
    const rows = await tenantScope(db, tenantId)
      .selectFrom('micromarket_ref')
      .select(['name', 'aliases', 'level'])
      .where('level', 'in', ['zone', 'micromarket', 'locality', 'sub_locality'])
      .orderBy('level')
      .orderBy('name')
      .limit(10_000)
      .execute();
    const index = new Map<string, LocationEntry>();
    // Micromarkets win over localities of the same name (a question naming it means the whole micromarket).
    const rank: Record<string, number> = { micromarket: 0, locality: 1, sub_locality: 2, zone: 3 };
    const sorted = [...rows].sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));
    for (const r of sorted) {
      for (const n of [r.name, ...r.aliases]) {
        const k = matchKey(n);
        if (!index.has(k)) index.set(k, { name: r.name, level: r.level });
      }
    }
    return index;
  });
  return {
    vocabulary,
    locations,
    clear: () => {
      vocabulary.clear();
      locations.clear();
    },
  };
}

export function createReferenceStore(db: Kysely<InsightDb>): ReferenceStore {
  return {
    async pendingTenants(limit) {
      const r = await sql<{ tenant_id: string }>`
        select tenant_id from job_checkpoint where job = 'vocabulary-refresh' and cursor like 'pending:%'
        order by updated_at limit ${limit}`.execute(db);
      return r.rows.map((x) => x.tenant_id);
    },
    async saveVocabulary(tenantId, doc) {
      await db.transaction().execute(async (trx) => {
        const t = tenantScope(trx, tenantId);
        await t.updateTable('vocabulary_release').set({ active: false, updated_at: new Date() }).where('active', '=', true).execute();
        await t
          .insertInto('vocabulary_release', { version: doc.version, checksum: doc.checksum ?? null, content: JSON.stringify(doc), active: true })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'version']).doUpdateSet({ content: JSON.stringify(doc), checksum: doc.checksum ?? null, active: true, updated_at: new Date() }),
          )
          .execute();
      });
    },
    async replaceMicromarkets(tenantId, nodes: MicromarketNode[]) {
      await db.transaction().execute(async (trx) => {
        const t = tenantScope(trx, tenantId);
        await t.deleteFrom('micromarket_ref').execute();
        for (let i = 0; i < nodes.length; i += 500) {
          const batch = nodes.slice(i, i + 500).map((n) => ({
            id: n.id,
            parent_id: n.parentId,
            level: n.level,
            name: n.name,
            aliases: n.aliases,
            city: n.city,
            in_launch_area: n.inLaunchArea,
            tree_version: n.treeVersion,
          }));
          if (batch.length) await t.insertInto('micromarket_ref', batch).execute();
        }
      });
    },
    async markRefreshed(tenantId) {
      await tenantScope(db, tenantId)
        .updateTable('job_checkpoint')
        .set({ cursor: `refreshed:${new Date().toISOString()}`, updated_at: new Date() })
        .where('job', '=', 'vocabulary-refresh')
        .execute();
    },
  };
}

export function createCatalogueRepo(db: Kysely<InsightDb>): CatalogueRepo {
  const disabled = cached(async (tenantId) => {
    const rows = await tenantScope(db, tenantId).selectFrom('plan_template').select('plan_id').where('enabled', '=', false).execute();
    return new Set(rows.map((r) => r.plan_id)) as ReadonlySet<string>;
  });
  return { disabled };
}

export function createReadModelInfo(db: Kysely<InsightDb>): ReadModelInfo {
  return {
    async dataAsOf(tenantId) {
      const row = await tenantScope(db, tenantId).selectFrom('rm_state').select('last_event_at').executeTakeFirst();
      return row?.last_event_at ?? null;
    },
  };
}
