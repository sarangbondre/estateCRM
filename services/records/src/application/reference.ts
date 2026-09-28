// Reference data (REC-02): vocabulary releases (D-16, US-37), the micromarket hierarchy with aliases and adjacency
// (US-34, R-13) and the launch area (Z-7, R-9).
import { createHash } from 'node:crypto';
import { releaseContent } from '@11e/vocabulary';
import { RecordsError, notFound } from '../domain/errors.js';
import { INITIAL_LAUNCH_CITIES } from '../domain/launch-area.js';
import { MMR_SEED } from '../domain/mmr-seed.js';
import type { SeedNode } from '../domain/mmr-seed.js';
import { norm, uniqueStrings } from '../domain/text.js';
import type { Actor, App } from './context.js';
import type { LaunchAreaCityRow, MicromarketRow, ReferenceVersionRow, VocabularyReleaseRow } from './model.js';
import type { Tx } from './ports.js';

// --- vocabulary ----------------------------------------------------------------------------------------------

/** sha256 of the canonical (key-sorted) JSON of the release content. */
export function releaseChecksum(content: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

/** `v0.6` → [0, 6] for ordering releases. */
const versionKey = (v: string) =>
  v
    .replace(/^v/, '')
    .split('.')
    .map((x) => Number(x) || 0);
export function compareVersions(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The releases shipped with this build (records LLD §4.13): loaded from @11e/vocabulary. */
export function shippedReleases(): { version: string; content: unknown }[] {
  const content = releaseContent();
  return [{ version: content.version, content }];
}

/**
 * Per-tenant bootstrap (idempotent): shipped vocabulary releases as `pending`, the MMR hierarchy seed, the launch-area
 * cities and the reference version rows. Runs from activate-vocabulary (after each deploy and daily) and lazily on the
 * first reference read of a tenant (the tenant is unknown at migration time).
 */
export async function bootstrapTenant(app: App, tx: Tx): Promise<void> {
  await tx.advisoryLock('bootstrap');
  for (const r of shippedReleases()) {
    await tx.store.insertIgnore('vocabulary_releases', {
      id: app.ids.next(),
      version: r.version,
      checksum: releaseChecksum(r.content),
      status: 'pending',
      content: r.content,
      activated_at: null,
    });
  }
  const [mmVersion] = await tx.store.find('reference_versions', { kind: 'micromarkets' }, { limit: 1 });
  if (!mmVersion) {
    await seedLaunchArea(app, tx);
    await seedMicromarkets(app, tx);
    await tx.store.insert('reference_versions', [
      { kind: 'micromarkets', version: 1, recompute_status: null, recompute_cursor: null },
      { kind: 'launch_area', version: 1, recompute_status: null, recompute_cursor: null },
    ]);
  }
}

async function seedLaunchArea(app: App, tx: Tx) {
  for (const name of INITIAL_LAUNCH_CITIES) {
    await tx.store.insertIgnore('launch_area_cities', {
      id: app.ids.next(),
      city_norm: norm(name) as string,
      name,
      enabled: true,
      version: 1,
    });
  }
}

async function seedMicromarkets(app: App, tx: Tx) {
  const enabled = new Set(INITIAL_LAUNCH_CITIES.map((c) => norm(c) as string));
  const rows: Parameters<typeof tx.store.insert<'micromarkets'>>[1] = [];
  const add = (node: SeedNode, level: MicromarketRow['level'], parentId: string | null, city: string) => {
    const id = app.ids.next();
    const c = node.city ?? city;
    (rows as unknown[]).push({
      id,
      parent_id: parentId,
      level,
      name: node.name,
      name_norm: norm(node.name) as string,
      aliases: node.aliases ?? [],
      aliases_norm: (node.aliases ?? []).map((a) => norm(a) as string),
      city: c,
      city_norm: norm(c) as string,
      in_launch_area: enabled.has(norm(c) as string),
      version: 1,
    });
    const childLevel = level === 'zone' ? 'micromarket' : level === 'micromarket' ? 'locality' : 'sub_locality';
    for (const child of node.children ?? []) add(child, childLevel, id, c);
  };
  for (const zone of MMR_SEED) add({ name: zone.zone, children: zone.micromarkets }, 'zone', null, zone.city);
  await tx.store.insert('micromarkets', rows);
}

/** Activates the newest pending release above the active one (job activate-vocabulary). */
export async function activateVocabulary(app: App, actor: Actor): Promise<{ activated: string | null }> {
  const result = await app.uow.run(actor, async (tx) => {
    await bootstrapTenant(app, tx);
    const releases = await tx.store.find('vocabulary_releases', {}, { limit: 100, lock: true });
    const active = releases.find((r) => r.status === 'active');
    const next = releases
      .filter((r) => r.status === 'pending' && (!active || compareVersions(r.version, active.version) > 0))
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!next) return null;
    if (active) await tx.store.update('vocabulary_releases', active.id, { status: 'superseded' });
    await tx.store.update('vocabulary_releases', next.id, { status: 'active', activated_at: tx.now });
    await tx.events.emit(
      'vocabulary.released.v1',
      { aggregateType: 'vocabulary', aggregateId: next.id, aggregateVersion: 1 },
      { version: next.version, checksum: next.checksum },
    );
    return next.version;
  });
  app.cache.vocabulary.drop(actor.tenantId);
  return { activated: result };
}

/** Makes sure a tenant that never ran the job has its reference data (first request of a new tenant). */
export async function ensureReference(app: App, actor: Actor): Promise<void> {
  const ready = await app.uow.run(actor, async (tx) => {
    const [active] = await tx.store.find('vocabulary_releases', { status: 'active' }, { limit: 1 });
    return active !== undefined;
  });
  if (!ready) await activateVocabulary(app, actor);
}

export async function getVocabulary(app: App, actor: Actor, version?: string): Promise<VocabularyReleaseRow> {
  await ensureReference(app, actor);
  return app.uow.run(actor, async (tx) => {
    const [row] = await tx.store.find(
      'vocabulary_releases',
      version ? { version: version.startsWith('v') ? version : `v${version}` } : { status: 'active' },
      { limit: 1 },
    );
    if (!row || row.status === 'pending') throw notFound('vocabulary release');
    return row;
  });
}

// --- micromarkets --------------------------------------------------------------------------------------------

export interface MicromarketInput {
  parentId?: string | null | undefined;
  level?: MicromarketRow['level'] | undefined;
  name?: string | undefined;
  aliases?: string[] | undefined;
  city?: string | undefined;
  adjacentIds?: string[] | undefined;
}

async function bumpReference(tx: Tx, kind: 'micromarkets' | 'launch_area', patch: Partial<ReferenceVersionRow> = {}) {
  const [row] = await tx.store.find('reference_versions', { kind }, { limit: 1, lock: true });
  const version = (row?.version ?? 0) + 1;
  if (row) await tx.store.updateWhere('reference_versions', { kind }, { version, ...patch });
  else await tx.store.insert('reference_versions', { kind, version, recompute_status: null, recompute_cursor: null, ...patch });
  return version;
}

/** Queues recompute-launch-area (flags and micromarket re-resolution of existing records). */
async function queueRecompute(tx: Tx) {
  await tx.store.updateWhere('reference_versions', { kind: 'launch_area' }, { recompute_status: 'queued', recompute_cursor: null });
}

async function assertNamesFree(tx: Tx, names: string[], excludeId?: string) {
  const taken = await tx.q.micromarketsNamed(names, excludeId);
  if (taken.length) {
    throw new RecordsError('micromarket-alias-taken', 'a name or alias already resolves to another micromarket', {
      extensions: { conflictingIds: taken.map((t) => t.id) },
    });
  }
}

async function replaceAdjacency(app: App, tx: Tx, id: string, adjacentIds: readonly string[]) {
  const others = [...new Set(adjacentIds)].filter((a) => a !== id);
  const found = await tx.store.getMany('micromarkets', others);
  if (found.length !== others.length) throw new RecordsError('validation-failed', 'unknown adjacent micromarket', {
    errors: [{ field: 'adjacentIds', code: 'not-found' }],
  });
  await tx.store.delete('micromarket_adjacency', { micromarket_id: id });
  await tx.store.delete('micromarket_adjacency', { adjacent_id: id });
  void app;
  await tx.store.insert(
    'micromarket_adjacency',
    others.flatMap((a) => [
      { micromarket_id: id, adjacent_id: a },
      { micromarket_id: a, adjacent_id: id },
    ]),
  );
}

async function emitTree(tx: Tx, version: number) {
  await tx.events.emit(
    'micromarkets.updated.v1',
    { aggregateType: 'micromarkets', aggregateId: tx.tenantId, aggregateVersion: version },
    { version },
  );
}

export async function createMicromarket(
  app: App,
  actor: Actor,
  input: MicromarketInput & { level: MicromarketRow['level']; name: string; city: string },
) {
  await ensureReference(app, actor);
  const id = await app.uow.run(actor, async (tx) => {
    await tx.advisoryLock('micromarkets');
    if (input.parentId) {
      const parent = await tx.store.get('micromarkets', input.parentId);
      if (!parent) throw new RecordsError('validation-failed', 'parent not found', { errors: [{ field: 'parentId', code: 'not-found' }] });
    }
    const aliases = uniqueStrings(input.aliases ?? []);
    const names = [input.name, ...aliases].map((n) => norm(n)).filter((n): n is string => !!n);
    await assertNamesFree(tx, names);
    const cities = await tx.store.find('launch_area_cities', { city_norm: norm(input.city) as string, enabled: true }, { limit: 1 });
    const id = app.ids.next();
    await tx.store.insert('micromarkets', {
      id,
      parent_id: input.parentId ?? null,
      level: input.level,
      name: input.name.trim(),
      name_norm: norm(input.name) as string,
      aliases,
      aliases_norm: aliases.map((a) => norm(a) as string),
      city: input.city.trim(),
      city_norm: norm(input.city) as string,
      in_launch_area: cities.length > 0,
      version: 1,
    });
    if (input.adjacentIds?.length) await replaceAdjacency(app, tx, id, input.adjacentIds);
    const version = await bumpReference(tx, 'micromarkets');
    await emitTree(tx, version);
    return id;
  });
  app.cache.micromarkets.drop(actor.tenantId);
  return id;
}

export async function patchMicromarket(app: App, actor: Actor, id: string, patch: MicromarketInput, ifMatch: number | undefined) {
  await app.uow.run(actor, async (tx) => {
    await tx.advisoryLock('micromarkets');
    const row = await tx.store.get('micromarkets', id, { lock: true });
    if (!row) throw notFound('micromarket');
    if (ifMatch !== undefined && ifMatch !== row.version) throw new RecordsError('version-mismatch');
    const update: Partial<MicromarketRow> = { version: row.version + 1 };
    if (patch.parentId !== undefined && patch.parentId !== row.parent_id) {
      if (patch.parentId !== null) {
        const below = await tx.q.micromarketDescendants([id]);
        if (below.includes(patch.parentId)) {
          throw new RecordsError('validation-failed', 'a node cannot move under its own descendant', {
            errors: [{ field: 'parentId', code: 'cycle' }],
          });
        }
        if (!(await tx.store.get('micromarkets', patch.parentId))) {
          throw new RecordsError('validation-failed', 'parent not found', { errors: [{ field: 'parentId', code: 'not-found' }] });
        }
      }
      update.parent_id = patch.parentId;
    }
    const name = patch.name ?? row.name;
    const aliases = patch.aliases !== undefined ? uniqueStrings(patch.aliases) : row.aliases;
    if (patch.name !== undefined || patch.aliases !== undefined) {
      const names = [name, ...aliases].map((n) => norm(n)).filter((n): n is string => !!n);
      await assertNamesFree(tx, names, id);
      update.name = name.trim();
      update.name_norm = norm(name) as string;
      update.aliases = aliases;
      update.aliases_norm = aliases.map((a) => norm(a) as string);
    }
    await tx.store.update('micromarkets', id, update);
    if (patch.adjacentIds !== undefined) await replaceAdjacency(app, tx, id, patch.adjacentIds);
    const version = await bumpReference(tx, 'micromarkets');
    await emitTree(tx, version);
    if (update.parent_id !== undefined || update.name_norm !== undefined) await queueRecompute(tx);
  });
  app.cache.micromarkets.drop(actor.tenantId);
}

// --- launch area ---------------------------------------------------------------------------------------------

export interface LaunchAreaState {
  cities: LaunchAreaCityRow[];
  version: number;
  recomputeStatus: 'queued' | 'running' | 'done' | null;
}

export async function getLaunchArea(app: App, actor: Actor): Promise<LaunchAreaState> {
  await ensureReference(app, actor);
  return app.uow.run(actor, (tx) => readLaunchArea(tx));
}

async function readLaunchArea(tx: Tx): Promise<LaunchAreaState> {
  const [cities, [ref]] = await Promise.all([
    tx.store.find('launch_area_cities', {}, { limit: 200, orderBy: [{ column: 'name' }] }),
    tx.store.find('reference_versions', { kind: 'launch_area' }, { limit: 1 }),
  ]);
  return { cities, version: ref?.version ?? 1, recomputeStatus: ref?.recompute_status ?? null };
}

export async function putLaunchArea(
  app: App,
  actor: Actor,
  cities: { name: string; enabled: boolean }[],
  ifMatch: number | undefined,
): Promise<LaunchAreaState> {
  await ensureReference(app, actor);
  const state = await app.uow.run(actor, async (tx) => {
    const [ref] = await tx.store.find('reference_versions', { kind: 'launch_area' }, { limit: 1, lock: true });
    if (ifMatch !== undefined && ifMatch !== (ref?.version ?? 1)) throw new RecordsError('version-mismatch');
    const wanted = new Map<string, { name: string; enabled: boolean }>();
    for (const c of cities) {
      const key = norm(c.name);
      if (key) wanted.set(key, { name: c.name.trim(), enabled: c.enabled });
    }
    const existing = await tx.store.find('launch_area_cities', {}, { limit: 1000 });
    for (const row of existing) {
      const w = wanted.get(row.city_norm);
      if (!w) await tx.store.delete('launch_area_cities', { id: row.id });
      else if (w.enabled !== row.enabled || w.name !== row.name) {
        await tx.store.update('launch_area_cities', row.id, { enabled: w.enabled, name: w.name, version: row.version + 1 });
      }
    }
    const known = new Set(existing.map((r) => r.city_norm));
    const fresh = [...wanted.entries()].filter(([k]) => !known.has(k));
    await tx.store.insert(
      'launch_area_cities',
      fresh.map(([cityNorm, c]) => ({ id: app.ids.next(), city_norm: cityNorm, name: c.name, enabled: c.enabled, version: 1 })),
    );
    // Micromarket nodes follow their city (bounded: the hierarchy of one tenant).
    const enabled = new Set([...wanted.entries()].filter(([, c]) => c.enabled).map(([k]) => k));
    const nodes = await tx.store.find('micromarkets', {}, { limit: 1000 });
    let treeChanged = false;
    for (const n of nodes) {
      const inside = enabled.has(n.city_norm);
      if (inside !== n.in_launch_area) {
        await tx.store.update('micromarkets', n.id, { in_launch_area: inside, version: n.version + 1 });
        treeChanged = true;
      }
    }
    if (treeChanged) await emitTree(tx, await bumpReference(tx, 'micromarkets'));
    await bumpReference(tx, 'launch_area', { recompute_status: 'queued', recompute_cursor: null });
    return readLaunchArea(tx);
  });
  app.cache.invalidate(actor.tenantId);
  return state;
}
