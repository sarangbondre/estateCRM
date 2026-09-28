// Reference data routes (REC-02): vocabulary, micromarkets, launch area.
import type { operations } from '@11e/contracts/records';
import { HttpError } from '@11e/http';
import type { Service } from '@11e/http';
import type { AppDeps } from '../../deps.js';
import {
  createMicromarket,
  ensureReference,
  getLaunchArea,
  getVocabulary,
  patchMicromarket,
  putLaunchArea,
} from '../../application/reference.js';
import type { LaunchAreaState } from '../../application/reference.js';
import type { MicromarketRow, VocabularyReleaseRow } from '../../application/model.js';
import { actorOf, guard, ifMatchVersion, isoKey, json, page, pageOf, withIdempotency, wrap } from './support.js';

type Ops = operations;

export function presentRelease(r: VocabularyReleaseRow) {
  const content = r.content as Record<string, unknown>;
  return {
    version: r.version,
    checksum: r.checksum,
    activatedAt: (r.activated_at ?? r.created_at).toISOString(),
    status: r.status === 'active' ? 'active' : 'superseded',
    fields: content['fields'] ?? {},
    recordScopes: content['recordScopes'] ?? [],
    legacyTerms: content['legacyTerms'] ?? [],
    displayLabels: content['displayLabels'] ?? [],
  };
}

export function presentMicromarket(m: MicromarketRow, adjacentIds: string[], treeVersion: number) {
  return {
    id: m.id,
    parentId: m.parent_id,
    level: m.level,
    name: m.name,
    aliases: m.aliases,
    city: m.city,
    inLaunchArea: m.in_launch_area,
    adjacentIds,
    treeVersion,
    version: m.version,
  };
}

export function presentLaunchArea(s: LaunchAreaState) {
  return {
    cities: s.cities.map((c) => ({ name: c.name, enabled: c.enabled })),
    version: s.version,
    recomputeStatus: s.recomputeStatus,
  };
}

export function registerReferenceRoutes(svc: Service<Ops>, deps: AppDeps): void {
  const { app } = deps;

  svc.op(
    'getVocabulary',
    wrap(async (c, { query }) => {
      const release = await guard(() => getVocabulary(app, actorOf(c), query.version));
      const etag = `"${release.checksum}"`;
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag });
      c.header('etag', etag);
      return json(c, presentRelease(release));
    }),
  );

  svc.op(
    'listVocabularyVersions',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      await guard(() => ensureReference(app, actor));
      const rows = await app.uow.run(actor, (tx) => tx.q.listVocabularyReleases({ after, limit: limit + 1 }));
      return json(
        c,
        await pageOf(rows, limit, (r) => ({ k: isoKey(r.activated_at), id: r.id }), (items) =>
          items.map((r) => ({
            version: r.version,
            checksum: r.checksum,
            status: r.status,
            activatedAt: r.activated_at ? r.activated_at.toISOString() : null,
          })),
        ),
      );
    }),
  );

  const micromarketsById = async (actor: ReturnType<typeof actorOf>, ids: string[]) =>
    app.uow.run(actor, async (tx) => {
      const [rows, adjacency, [ref]] = await Promise.all([
        tx.store.getMany('micromarkets', ids),
        tx.q.adjacentIds(ids),
        tx.store.find('reference_versions', { kind: 'micromarkets' }, { limit: 1 }),
      ]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.flatMap((id) => {
        const m = byId.get(id);
        return m ? [presentMicromarket(m, adjacency.get(id) ?? [], ref?.version ?? 1)] : [];
      });
    });

  svc.op(
    'listMicromarkets',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      await guard(() => ensureReference(app, actor));
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listMicromarkets({ parentId: query.parentId, level: query.level, q: query.q }, { after, limit: limit + 1 }),
      );
      return json(
        c,
        await pageOf(rows, limit, (r) => ({ k: r.name_norm, id: r.id }), (items) => micromarketsById(actor, items.map((i) => i.id))),
      );
    }),
  );

  svc.op(
    'createMicromarket',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const id = await createMicromarket(app, actor, {
          level: body.level,
          name: body.name,
          city: body.city,
          parentId: body.parentId,
          aliases: body.aliases,
          adjacentIds: body.adjacentIds,
        });
        const [m] = await micromarketsById(actor, [id]);
        return { status: 201, body: m };
      });
    }),
  );

  svc.op(
    'patchMicromarket',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      await guard(() =>
        patchMicromarket(
          app,
          actor,
          params.id,
          { parentId: body.parentId, name: body.name, aliases: body.aliases, adjacentIds: body.adjacentIds },
          ifMatchVersion(c),
        ),
      );
      const [m] = await micromarketsById(actor, [params.id]);
      if (!m) throw new HttpError(404, 'not-found');
      return json(c, m);
    }),
  );

  svc.op(
    'getLaunchArea',
    wrap(async (c) => json(c, presentLaunchArea(await guard(() => getLaunchArea(app, actorOf(c)))))),
  );

  svc.op(
    'putLaunchArea',
    wrap(async (c, { body }) => {
      const state = await guard(() => putLaunchArea(app, actorOf(c), body.cities, ifMatchVersion(c)));
      return json(c, presentLaunchArea(state), 202);
    }),
  );
}
