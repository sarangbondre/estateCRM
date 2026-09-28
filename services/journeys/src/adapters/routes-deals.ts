// Site visits, deals and lease renewals (contract tags Site visits, Deals).
import type { operations } from '@11e/contracts/journeys';
import type { Service } from '@11e/http';
import { cancelDeal, dealByIdOrCode, dealView, leaseRenewalView, logFollowUp, openDeal, updateDeal } from '../application/deals.js';
import { completeVisit, scheduleVisit, updateVisit, visitByIdOrCode, visitView } from '../application/visits.js';
import type { Http } from './http.js';

export function registerDealRoutes(svc: Service<operations>, http: Http): void {
  svc.op('scheduleSiteVisit', async (c, { body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent', 'Supply agent']);
    return http.post(c, body, 201, (tx) => scheduleVisit(tx, p, body));
  });

  svc.op('listSiteVisits', async (c, { query }) => {
    http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const rows = await http.tx(c, (tx) =>
      tx.q.listSiteVisits(
        { demandId: query.demandId, offerId: query.offerId, attendeeUserId: query.attendeeUserId, status: query.status, from: query.from, to: query.to },
        after,
        limit + 1,
      ),
    );
    const page = http.page(rows, limit, (r) => ({ k: r.scheduled_at.toISOString(), id: r.id }));
    return c.json({ items: page.items.map(visitView), nextCursor: page.nextCursor });
  });

  svc.op('getSiteVisit', async (c, { params }) => {
    http.staff(c);
    return c.json(visitView(await http.tx(c, (tx) => visitByIdOrCode(tx, params.idOrCode))));
  });

  svc.op('updateSiteVisit', async (c, { params, body }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent', 'Supply agent']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => updateVisit(tx, params.idOrCode, body, expected)));
  });

  svc.op('completeSiteVisit', async (c, { params, body }) => {
    http.staff(c, ['Admin', 'Manager', 'Demand agent', 'Supply agent']);
    return http.post(c, body, 200, (tx) => completeVisit(tx, params.idOrCode, body));
  });

  svc.op('openDeal', async (c, { body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 201, (tx) => openDeal(tx, p, body));
  });

  svc.op('listDeals', async (c, { query }) => {
    http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const open = !query.stage || (query.stage !== 'Closed' && query.stage !== 'Cancelled');
    const body = await http.tx(c, async (tx) => {
      const rows = await tx.q.listDeals(
        { stage: query.stage, demandId: query.demandId, offerId: query.offerId, ownerUserId: query.ownerUserId, followUpDue: query.followUpDue === true },
        tx.today,
        after,
        limit + 1,
      );
      const page = http.page(rows, limit, (r) => (open ? { k: r.follow_up_date, id: r.id } : { k: r.updated_at.toISOString(), id: r.id }));
      return { items: await Promise.all(page.items.map((r) => dealView(tx, r))), nextCursor: page.nextCursor };
    });
    return c.json(body);
  });

  svc.op('getDeal', async (c, { params }) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => dealView(tx, await dealByIdOrCode(tx, params.idOrCode))));
  });

  svc.op('updateDeal', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => updateDeal(tx, p, params.idOrCode, body, expected)));
  });

  svc.op('cancelDeal', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent']);
    return http.post(c, body, 200, (tx) => cancelDeal(tx, p, params.idOrCode, body));
  });

  svc.op('logDealFollowUp', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Demand agent', 'Supply agent']);
    return http.post(c, body, 200, (tx) => logFollowUp(tx, p, params.idOrCode, body));
  });

  svc.op('listLeaseRenewals', async (c, { query }) => {
    http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const rows = await http.tx(c, (tx) => tx.q.listLeaseRenewals({ status: query.status, dueBefore: query.dueBefore }, after, limit + 1));
    const page = http.page(rows, limit, (r) => ({ k: r.due_on, id: r.id }));
    return c.json({ items: page.items.map(leaseRenewalView), nextCursor: page.nextCursor });
  });
}
