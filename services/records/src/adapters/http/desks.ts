// Desk routes (REC-11) and market data (REC-10).
import type { operations } from '@11e/contracts/records';
import type { Service } from '@11e/http';
import type { AppDeps } from '../../deps.js';
import { findDeskItem, patchDeskItem } from '../../application/desks.js';
import { deskItemDto, marketDataDto, networkItemDto } from './presenters.js';
import { actorOf, guard, ifMatchVersion, isoKey, json, page, pageOf, wrap } from './support.js';

type Ops = operations;

export function registerDeskRoutes(svc: Service<Ops>, deps: AppDeps): void {
  const { app } = deps;

  svc.op(
    'listDeskItems',
    wrap(async (c, { params, query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const filter = {
        archived: query.archived,
        assigneeUserId: query.assigneeUserId,
        sector: query.sector,
        dealType: query.dealType,
        side: query.side,
        deadlineWithinDays: query.deadlineWithinDays,
        today: new Date().toISOString().slice(0, 10),
      };
      if (params.desk === 'network') {
        const rows = await app.uow.run(actor, (tx) => tx.q.listNetwork(filter, { after, limit: limit + 1 }));
        return json(
          c,
          await pageOf(rows, limit, (r) => ({ k: isoKey(r.updated_at), id: r.id }), async (items) =>
            (await app.uow.run(actor, (tx) => tx.q.personViews(items.map((i) => i.id)))).map(networkItemDto),
          ),
        );
      }
      const rows = await app.uow.run(actor, (tx) => tx.q.listDesk(params.desk, filter, { after, limit: limit + 1 }));
      const key = params.desk === 'watchlist' ? (r: (typeof rows)[number]) => r.deadline_date ?? '9999-12-31' : (r: (typeof rows)[number]) => isoKey(r.created_at);
      return json(c, await pageOf(rows, limit, (r) => ({ k: key(r), id: r.id }), (items) => items.map(deskItemDto)));
    }),
  );

  svc.op(
    'getDeskItem',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const found = await guard(() => findDeskItem(app, actor, params.idOrCode));
      if (found.kind === 'item') return json(c, deskItemDto(found.item));
      const [view] = await app.uow.run(actor, (tx) => tx.q.personViews([found.personId]));
      return json(c, view ? networkItemDto(view) : {});
    }),
  );

  svc.op(
    'patchDeskItem',
    wrap(async (c, { params, body }) => {
      const item = await guard(() => patchDeskItem(app, actorOf(c), params.idOrCode, body, ifMatchVersion(c)));
      return json(c, deskItemDto(item));
    }),
  );

  svc.op(
    'listMarketData',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const micromarketIds = query.micromarketId ? await app.uow.run(actor, (tx) => tx.q.micromarketDescendants([query.micromarketId as string])) : undefined;
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listMarketData(
          {
            micromarketIds,
            dealType: query.dealType,
            segment: query.segment,
            source: query.source,
            observedFrom: query.observedFrom,
            observedTo: query.observedTo,
            includeVoided: query.includeVoided,
          },
          { after, limit: limit + 1 },
        ),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: r.observed_on, id: r.id }), (items) => items.map(marketDataDto)));
    }),
  );
}
