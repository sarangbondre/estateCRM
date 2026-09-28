// Calls, life curves, offer and demand journeys (contract tags Calls, Life curve, Offers, Demands).
import type { operations } from '@11e/contracts/journeys';
import type { Service } from '@11e/http';
import { HttpError } from '@11e/http';
import { callView, logCall } from '../application/calls.js';
import { exitDemandRequest, qualifyDemand, reactivateDemandRequest } from '../application/demands.js';
import { notFoundErr } from '../application/errors.js';
import { retireOfferCore } from '../application/offers.js';
import { demandByIdOrCode, demandJourneyView, lifeCurveView, offerByIdOrCode, offerJourneyView } from '../application/views.js';
import type { Http } from './http.js';

export function registerSubjectRoutes(svc: Service<operations>, http: Http): void {
  svc.op('logCall', async (c, { body }) => {
    const p = http.staff(c);
    return http.post(c, body, 201, (tx) => logCall(tx, p, body));
  });

  svc.op('listCalls', async (c, { query }) => {
    http.staff(c);
    if (!query.subjectId && !query.personId && !query.loggedBy)
      throw new HttpError(400, 'validation-failed', { detail: 'one of subjectId, personId or loggedBy is required' });
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const rows = await http.tx(c, (tx) =>
      tx.q.listCalls(
        {
          ...(query.subjectId ? { subjectId: query.subjectId } : {}),
          ...(query.personId ? { personId: query.personId } : {}),
          ...(query.loggedBy ? { loggedBy: query.loggedBy } : {}),
          ...(query.from ? { from: new Date(`${query.from}T00:00:00+05:30`) } : {}),
          ...(query.to ? { to: new Date(new Date(`${query.to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}),
        },
        after,
        limit + 1,
      ),
    );
    const page = http.page(rows, limit, (r) => ({ k: r.logged_at.toISOString(), id: r.id }));
    return c.json({ items: page.items.map(callView), nextCursor: page.nextCursor });
  });

  svc.op('getLifeCurve', async (c, { params }) => {
    http.staff(c);
    const body = await http.tx(c, async (tx) => {
      const view = params.subjectType === 'offer' ? await offerByIdOrCode(tx, params.subjectId) : await demandByIdOrCode(tx, params.subjectId);
      const curve = await tx.q.curveBySubject(params.subjectType, view.id);
      if (!curve) throw notFoundErr('life curve');
      return lifeCurveView(tx, curve, view.code, view.last_seen_on);
    });
    return c.json(body);
  });

  svc.op('getOfferJourney', async (c, { params }) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => offerJourneyView(tx, await offerByIdOrCode(tx, params.idOrCode))));
  });

  svc.op('retireOffer', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Supply agent']);
    return http.post(c, body, 200, async (tx) => {
      const view = await offerByIdOrCode(tx, params.idOrCode);
      const oj = await retireOfferCore(tx, view.id, body.reason, body.knownPriceInr, p.userId);
      return offerJourneyView(tx, view, oj);
    });
  });

  svc.op('getDemandJourney', async (c, { params }) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => demandJourneyView(tx, await demandByIdOrCode(tx, params.idOrCode))));
  });

  svc.op('qualifyDemand', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 200, async (tx) => demandJourneyView(tx, await qualifyDemand(tx, p.userId, params.idOrCode, body.checklist)));
  });

  svc.op('exitDemand', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 200, async (tx) => demandJourneyView(tx, await exitDemandRequest(tx, p.userId, params.idOrCode, body)));
  });

  svc.op('reactivateDemand', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body ?? null, 200, async (tx) => demandJourneyView(tx, await reactivateDemandRequest(tx, p, params.idOrCode)));
  });
}
