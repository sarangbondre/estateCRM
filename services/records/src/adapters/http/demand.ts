// Demand, people, quick add, enquiries and source ads routes (REC-04, reads of REC-05 lineage).
import type { operations } from '@11e/contracts/records';
import type { Service } from '@11e/http';
import type { AppDeps } from '../../deps.js';
import type { Actor } from '../../application/context.js';
import { addTouch, changeDemandStage, createDemand, patchDemand } from '../../application/demands.js';
import { mustFind } from '../../application/lookup.js';
import { createPerson, flagPerson, patchPerson } from '../../application/people.js';
import type { PersonInput } from '../../application/people.js';
import { quickAdd, quickAddLookup } from '../../application/quickadd.js';
import type { SortKey } from '../../application/queries.js';
import type { Dto } from '../../application/supply.js';
import { candidateDto, demandDto, enquiryDto, personDto, sourceAdDto, touchDto } from './presenters.js';
import { supplyViews } from './supply.js';
import { actorOf, guard, ifMatchVersion, isoKey, json, page, pageOf, withIdempotency, wrap } from './support.js';

type Ops = operations;

export function demandViews(deps: AppDeps) {
  const { app } = deps;
  return {
    demands: (actor: Actor, ids: string[]) => app.uow.run(actor, async (tx) => (await tx.q.demandViews(ids)).map(demandDto)),
    people: (actor: Actor, ids: string[]) => app.uow.run(actor, async (tx) => (await tx.q.personViews(ids)).map(personDto)),
  };
}

export function registerDemandRoutes(svc: Service<Ops>, deps: AppDeps): void {
  const { app } = deps;
  const views = demandViews(deps);
  const supply = supplyViews(deps);

  svc.op(
    'listDemands',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const sort = (query.sort ?? '-updatedAt') as SortKey;
      const micromarketIds = query.micromarketId
        ? await app.uow.run(actor, (tx) => tx.q.micromarketDescendants([query.micromarketId as string]))
        : undefined;
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listDemands(
          {
            dealType: query.dealType,
            market: query.market,
            segment: query.segment,
            propertyType: query.propertyType,
            micromarketIds,
            locality: query.locality,
            outsideLaunchArea: query.outsideLaunchArea,
            sourceType: query.sourceType,
            ownerUserId: query.ownerUserId,
            needsReview: query.needsReview,
            updatedSince: query.updatedSince ? new Date(query.updatedSince) : undefined,
            recordStage: query.recordStage,
            personId: query.personId,
            budgetInrMin: query.budgetInrMin,
            budgetInrMax: query.budgetInrMax,
            areaSqftMin: query.areaSqftMin,
            areaSqftMax: query.areaSqftMax,
            code: query.code,
          },
          sort,
          { after, limit: limit + 1 },
        ),
      );
      const key = sort.includes('created') ? 'created_at' : 'updated_at';
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r[key]), id: r.id }), (items) => views.demands(actor, items.map((i) => i.id))));
    }),
  );

  svc.op(
    'createDemand',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const id = await createDemand(app, actor, body as Dto);
        const [dto] = await views.demands(actor, [id]);
        return { status: 201, body: dto };
      });
    }),
  );

  svc.op(
    'getDemand',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const id = await guard(() => app.uow.run(actor, async (tx) => (await mustFind(tx, 'demands', params.idOrCode)).id));
      const [dto] = await views.demands(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'patchDemand',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      const id = await guard(() => patchDemand(app, actor, params.idOrCode, body as Dto, ifMatchVersion(c)));
      const [dto] = await views.demands(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'changeDemandRecordStage',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const id = await changeDemandStage(app, actor, params.idOrCode, (body as { to: string }).to, ifMatchVersion(c));
        const [dto] = await views.demands(actor, [id]);
        return { status: 200, body: dto };
      });
    }),
  );

  svc.op(
    'listTouches',
    wrap(async (c, { params, query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await guard(() =>
        app.uow.run(actor, async (tx) => tx.q.listTouches((await mustFind(tx, 'demands', params.idOrCode)).id, { after, limit: limit + 1 })),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r.occurred_at), id: r.id }), (items) => items.map(touchDto)));
    }),
  );

  svc.op(
    'addTouch',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const touch = await addTouch(app, actor, params.idOrCode, body);
        return { status: 201, body: touchDto(touch) };
      });
    }),
  );

  // --- people ---------------------------------------------------------------------------------------------
  svc.op(
    'listPeople',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listPeople(
          { partyType: query.partyType, participantRole: query.participantRole, flag: query.flag, companyName: query.companyName, code: query.code },
          { after, limit: limit + 1 },
        ),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r.updated_at), id: r.id }), (items) => views.people(actor, items.map((i) => i.id))));
    }),
  );

  svc.op(
    'createPerson',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const r = await app.uow.run(actor, (tx) => createPerson(app, tx, body.person as PersonInput, { onExisting: 'error' }));
        const [dto] = await views.people(actor, [r.person.id]);
        return { status: 201, body: dto };
      });
    }),
  );

  svc.op(
    'getPerson',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const id = await guard(() => app.uow.run(actor, async (tx) => (await mustFind(tx, 'persons', params.idOrCode)).id));
      const [dto] = await views.people(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'patchPerson',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      const id = await guard(async () => {
        const target = await app.uow.run(actor, async (tx) => (await mustFind(tx, 'persons', params.idOrCode)).id);
        return patchPerson(app, actor, target, body as PersonInput, ifMatchVersion(c));
      });
      const [dto] = await views.people(actor, [id]);
      return json(c, dto);
    }),
  );

  svc.op(
    'flagPerson',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const target = await app.uow.run(actor, async (tx) => (await mustFind(tx, 'persons', params.idOrCode)).id);
        await flagPerson(app, actor, target, body.flag, body.action ?? 'add', body.reason);
        const [dto] = await views.people(actor, [target]);
        return { status: 200, body: dto };
      });
    }),
  );

  // --- quick add ------------------------------------------------------------------------------------------
  svc.op(
    'quickAddLookup',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      const r = await guard(() => quickAddLookup(app, actor, body));
      const people = await Promise.all(
        r.people.map(async (p) => ({
          person: (await views.people(actor, [p.personId]))[0],
          openDemands: await views.demands(actor, p.openDemandIds),
          offers: (await supply.offers(actor, p.offerIds)).map((o) => ({
            id: o.id,
            code: o.code,
            dealType: o.dealType,
            market: o.market,
            label: o.label,
            recordStage: o.recordStage,
            publicationLevel: o.publicationLevel,
          })),
        })),
      );
      return json(c, { people, normalised: r.normalised });
    }),
  );

  svc.op(
    'quickAdd',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const r = await quickAdd(
          app,
          actor,
          {
            ...body,
            demand: body.demand as Dto | null | undefined,
            property: body.property as Dto | null | undefined,
            offers: body.offers as Dto[] | undefined,
          },
          candidateDto,
        );
        const [person] = await views.people(actor, [r.personId]);
        const [demand] = r.demandId ? await views.demands(actor, [r.demandId]) : [];
        const [property] = r.propertyId ? await supply.properties(actor, [r.propertyId]) : [];
        return {
          status: r.outcome === 'touch_added' ? 200 : 201,
          body: {
            outcome: r.outcome,
            person,
            demand: demand ?? null,
            touch: r.touch ? touchDto(r.touch) : null,
            property: property ?? null,
            offers: await supply.offers(actor, r.offerIds),
            mergeCandidateIds: r.mergeCandidateIds,
          },
        };
      });
    }),
  );

  // --- enquiries, source ads ------------------------------------------------------------------------------
  svc.op(
    'listEnquiries',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listEnquiries(
          {
            offerId: query.offerId,
            projectId: query.projectId,
            demandId: query.demandId,
            campaignRef: query.campaignRef,
            receivedSince: query.receivedSince ? new Date(query.receivedSince) : undefined,
          },
          { after, limit: limit + 1 },
        ),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: isoKey(r.received_at), id: r.id }), (items) => items.map(enquiryDto)));
    }),
  );

  svc.op(
    'getEnquiry',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const row = await guard(() => app.uow.run(actor, (tx) => mustFind(tx, 'enquiries', params.idOrCode)));
      return json(c, enquiryDto(row));
    }),
  );

  svc.op(
    'listSourceAds',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listSourceAds(
          { sourceName: query.sourceName, sourceDate: query.sourceDate, externalRef: query.externalRef, hasSplits: query.hasSplits },
          { after, limit: limit + 1 },
        ),
      );
      const key = query.sourceName !== undefined ? 'source_date' : 'created_at';
      return json(
        c,
        await pageOf(
          rows,
          limit,
          (r) => ({ k: key === 'source_date' ? r.source_date : isoKey(r.created_at), id: r.id }),
          async (items) => (await app.uow.run(actor, (tx) => tx.q.sourceAdViews(items.map((i) => i.id)))).map(sourceAdDto),
        ),
      );
    }),
  );

  svc.op(
    'getSourceAd',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const [dto] = await guard(() =>
        app.uow.run(actor, async (tx) => (await tx.q.sourceAdViews([(await mustFind(tx, 'source_ads', params.idOrCode)).id])).map(sourceAdDto)),
      );
      return json(c, dto);
    }),
  );
}
