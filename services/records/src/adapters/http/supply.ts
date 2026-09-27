// Supply routes (REC-03): offers, properties, projects, sightings, second sources, property photos.
import { requireStaff } from '@11e/auth';
import type { operations } from '@11e/contracts/records';
import type { Service } from '@11e/http';
import type { AppDeps } from '../../deps.js';
import type { Actor } from '../../application/context.js';
import { mustFind } from '../../application/lookup.js';
import { createProject, patchProject } from '../../application/projects.js';
import type { SortKey } from '../../application/queries.js';
import {
  changeOfferStage,
  checkDuplicates,
  createOffer,
  createPropertyUseCase,
  patchOffer,
  patchProperty,
  putOfferPhotos,
  resolveSecondSource,
} from '../../application/supply.js';
import type { Dto, PartyInputDto } from '../../application/supply.js';
import { listPhotos } from '../../application/photos.js';
import {
  candidateDto,
  offerDto,
  photoDto,
  projectDto,
  propertyDto,
  secondSourceDto,
  sightingDto,
} from './presenters.js';
import { actorOf, guard, ifMatchVersion, isoKey, json, page, pageOf, withIdempotency, wrap } from './support.js';

type Ops = operations;

export function supplyViews(deps: AppDeps) {
  const { app } = deps;
  return {
    offers: (actor: Actor, ids: string[]) => app.uow.run(actor, async (tx) => (await tx.q.offerViews(ids)).map(offerDto)),
    properties: (actor: Actor, ids: string[]) => app.uow.run(actor, async (tx) => (await tx.q.propertyViews(ids)).map(propertyDto)),
    projects: (actor: Actor, ids: string[]) => app.uow.run(actor, async (tx) => (await tx.q.projectViews(ids)).map(projectDto)),
  };
}

export function registerSupplyRoutes(svc: Service<Ops>, deps: AppDeps): void {
  const { app } = deps;
  const views = supplyViews(deps);
  const since = (s: string | undefined) => (s ? new Date(s) : undefined);
  const expand = (actor: Actor, id: string | undefined) =>
    id ? app.uow.run(actor, (tx) => tx.q.micromarketDescendants([id])) : Promise.resolve(undefined);

  // --- offers ---------------------------------------------------------------------------------------------
  svc.op(
    'listOffers',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const sort = (query.sort ?? '-updatedAt') as SortKey;
      const micromarketIds = await expand(actor, query.micromarketId);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listOffers(
          {
            dealType: query.dealType,
            market: query.market,
            segment: query.segment,
            propertyType: query.propertyType,
            micromarketIds,
            locality: query.locality,
            city: query.city,
            outsideLaunchArea: query.outsideLaunchArea,
            bhkMin: query.bhkMin,
            bhkMax: query.bhkMax,
            areaSqftMin: query.areaSqftMin,
            areaSqftMax: query.areaSqftMax,
            priceInrMin: query.priceInrMin,
            priceInrMax: query.priceInrMax,
            sourceType: query.sourceType,
            ownerUserId: query.ownerUserId,
            needsReview: query.needsReview,
            updatedSince: since(query.updatedSince),
            recordStage: query.recordStage,
            publicationLevel: query.publicationLevel,
            tenancyStatus: query.tenancyStatus,
            saleMode: query.saleMode,
            furnishing: query.furnishing,
            possessionStatus: query.possessionStatus,
            propertyId: query.propertyId,
            projectId: query.projectId,
            sourcedForDemandId: query.sourcedForDemandId,
            hasPriceGap: query.hasPriceGap,
            code: query.code,
          },
          sort,
          { after, limit: limit + 1 },
        ),
      );
      const key = sort.includes('created') ? 'created_at' : 'updated_at';
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r[key]), id: r.id }), (items) => views.offers(actor, items.map((i) => i.id))));
    }),
  );

  svc.op(
    'createOffer',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const id = await createOffer(app, actor, {
          propertyId: body.propertyId,
          offer: body.offer as Dto,
          recordStage: body.recordStage,
          sourceType: body.sourceType,
        });
        const [dto] = await views.offers(actor, [id]);
        return { status: 201, body: dto };
      });
    }),
  );

  svc.op(
    'getOffer',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const id = await guard(() => app.uow.run(actor, async (tx) => (await mustFind(tx, 'offers', params.idOrCode)).id));
      const [dto] = await views.offers(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'patchOffer',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      const id = await guard(() => patchOffer(app, actor, params.idOrCode, body as Dto, ifMatchVersion(c)));
      const [dto] = await views.offers(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'changeOfferRecordStage',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const id = await changeOfferStage(app, actor, params.idOrCode, body.to, ifMatchVersion(c));
        const [dto] = await views.offers(actor, [id]);
        return { status: 200, body: dto };
      });
    }),
  );

  svc.op(
    'putOfferPhotos',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      const id = await guard(() => putOfferPhotos(app, actor, params.idOrCode, body.photoIds, ifMatchVersion(c)));
      const [dto] = await views.offers(actor, [id]);
      return json(c, dto);
    }),
  );

  // --- properties -----------------------------------------------------------------------------------------
  svc.op(
    'listProperties',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const micromarketIds = await expand(actor, query.micromarketId);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listProperties(
          {
            segment: query.segment,
            propertyType: query.propertyType,
            micromarketIds,
            locality: query.locality,
            city: query.city,
            outsideLaunchArea: query.outsideLaunchArea,
            buildingName: query.buildingName,
            projectId: query.projectId,
            code: query.code,
            updatedSince: since(query.updatedSince),
          },
          { after, limit: limit + 1 },
        ),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r.updated_at), id: r.id }), (items) => views.properties(actor, items.map((i) => i.id))));
    }),
  );

  svc.op(
    'createProperty',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      requireStaff(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const r = await createPropertyUseCase(
          app,
          actor,
          {
            property: body.property as Dto,
            offers: body.offers as Dto[],
            parties: body.parties as PartyInputDto[] | undefined,
            sourceType: body.sourceType,
            sourceDetail: body.sourceDetail,
            sideEvidence: body.sideEvidence,
            confirmNewDespiteCandidates: body.confirmNewDespiteCandidates,
          },
          candidateDto,
        );
        const [property] = await views.properties(actor, [r.propertyId]);
        return { status: 201, body: { property, offers: await views.offers(actor, r.offerIds) } };
      });
    }),
  );

  svc.op(
    'checkPropertyDuplicates',
    wrap(async (c, { body }) => {
      const r = await guard(() =>
        checkDuplicates(app, actorOf(c), { property: body.property as Dto, phones: body.phones, dealType: body.dealType }),
      );
      return json(c, { candidates: r.candidates.slice(0, 10).map(candidateDto), decision: r.decision });
    }),
  );

  svc.op(
    'getProperty',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const id = await guard(() => app.uow.run(actor, async (tx) => (await mustFind(tx, 'properties', params.idOrCode)).id));
      const [dto] = await views.properties(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'patchProperty',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      const id = await guard(() => patchProperty(app, actor, params.idOrCode, body as Dto, ifMatchVersion(c)));
      const [dto] = await views.properties(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'listPropertySightings',
    wrap(async (c, { params, query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const { rows, codes } = await guard(() =>
        app.uow.run(actor, async (tx) => {
          const property = await mustFind(tx, 'properties', params.idOrCode);
          const offers = await tx.store.find('offers', { property_id: property.id }, { limit: 100 });
          const rows = await tx.q.listSightings(
            [{ type: 'property', id: property.id }, ...offers.map((o) => ({ type: 'offer', id: o.id }))],
            { after, limit: limit + 1 },
          );
          const ads = await tx.store.getMany('source_ads', rows.map((r) => r.source_ad_id).filter((x): x is string => !!x));
          return { rows, codes: new Map(ads.map((a) => [a.id, a.code])) };
        }),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: r.seen_on, id: r.id }), (items) => items.map((s) => sightingDto(s, codes))));
    }),
  );

  svc.op(
    'listSecondSources',
    wrap(async (c, { params, query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await guard(() =>
        app.uow.run(actor, async (tx) => {
          const property = await mustFind(tx, 'properties', params.idOrCode);
          return tx.q.listSecondSources({ propertyId: property.id, status: query.status, priceGap: query.priceGap }, { after, limit: limit + 1 });
        }),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: r.seen_on, id: r.id }), (items) => items.map(secondSourceDto)));
    }),
  );

  svc.op(
    'listPropertyPhotos',
    wrap(async (c, { params, query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const { rows, urls } = await guard(() => listPhotos(app, actor, params.idOrCode, { after, limit: limit + 1 }));
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r.created_at), id: r.id }), (items) => items.map((p) => photoDto(p, urls.get(p.id) ?? null))));
    }),
  );

  svc.op(
    'listPriceGaps',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listSecondSources({ status: query.status, priceGap: query.priceGap }, { after, limit: limit + 1 }),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: r.seen_on, id: r.id }), (items) => items.map(secondSourceDto)));
    }),
  );

  svc.op(
    'resolveSecondSource',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        await resolveSecondSource(app, actor, params.id, body.action);
        const row = await app.uow.run(actor, (tx) => tx.store.get('second_sources', params.id));
        return { status: 200, body: row ? secondSourceDto(row) : {} };
      });
    }),
  );

  // --- projects -------------------------------------------------------------------------------------------
  svc.op(
    'listProjects',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const micromarketIds = await expand(actor, query.micromarketId);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listProjects(
          {
            micromarketIds,
            locality: query.locality,
            city: query.city,
            outsideLaunchArea: query.outsideLaunchArea,
            developerPersonId: query.developerPersonId,
            hasRera: query.hasRera,
            code: query.code,
            updatedSince: since(query.updatedSince),
          },
          { after, limit: limit + 1 },
        ),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r.updated_at), id: r.id }), (items) => views.projects(actor, items.map((i) => i.id))));
    }),
  );

  svc.op(
    'createProject',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const id = await createProject(app, actor, body as Dto);
        const [dto] = await views.projects(actor, [id]);
        return { status: 201, body: dto };
      });
    }),
  );

  svc.op(
    'getProject',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const id = await guard(() => app.uow.run(actor, async (tx) => (await mustFind(tx, 'projects', params.idOrCode)).id));
      const [dto] = await views.projects(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'patchProject',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      const id = await guard(() => patchProject(app, actor, params.idOrCode, body as Dto, ifMatchVersion(c)));
      const [dto] = await views.projects(actor, [id]);
      return json(c, dto);
    }),
  );
}
