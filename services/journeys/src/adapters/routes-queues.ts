// Queues and capacities (contract tags Queues): My queue, sections, Manager views, bulk reassign, capacities.
import type { operations } from '@11e/contracts/journeys';
import type { Service } from '@11e/http';
import { HttpError } from '@11e/http';
import { isSection } from '../domain/queue.js';
import type { Section } from '../domain/queue.js';
import { notFoundErr } from '../application/errors.js';
import { getCapacity, putCapacity, queueSummary, reassign, sectionPage, toCapacity, userKnown } from '../application/queues.js';
import { encodeCursor } from '@11e/http';
import type { Http } from './http.js';

function section(s: string): Section {
  if (!isSection(s)) throw new HttpError(404, 'unknown-section');
  return s;
}

export function registerQueueRoutes(svc: Service<operations>, http: Http): void {
  svc.op('getMyQueue', async (c) => {
    const p = http.staff(c);
    return c.json(await http.tx(c, (tx) => queueSummary(tx, p.userId, p.role)));
  });

  svc.op('listMyQueueSection', async (c, { params, query }) => {
    const p = http.staff(c);
    const after = http.cursor(c, query.cursor);
    const r = await http.tx(c, (tx) =>
      sectionPage(tx, p.userId, section(params.section), after, http.limit(query.limit), query.plannedOnly === true),
    );
    return c.json({ items: r.items, nextCursor: r.next ? encodeCursor(r.next) : null } as never);
  });

  svc.op('getUserQueue', async (c, { params }) => {
    http.staff(c, ['Admin', 'Manager']);
    const body = await http.tx(c, async (tx) => {
      const known = await userKnown(tx, params.userId);
      if (!known) throw notFoundErr('user');
      return queueSummary(tx, params.userId, known.role);
    });
    return c.json(body);
  });

  svc.op('listUserQueueSection', async (c, { params, query }) => {
    http.staff(c, ['Admin', 'Manager']);
    const after = http.cursor(c, query.cursor);
    const r = await http.tx(c, (tx) => sectionPage(tx, params.userId, section(params.section), after, http.limit(query.limit), false));
    return c.json({ items: r.items, nextCursor: r.next ? encodeCursor(r.next) : null } as never);
  });

  svc.op('reassignQueueItems', async (c, { body }) => {
    const p = http.staff(c, ['Admin', 'Manager']);
    return http.post(c, body, 200, (tx) => reassign(tx, p, body.queueItemIds, body.assigneeUserId));
  });

  svc.op('listCapacities', async (c, { query }) => {
    http.staff(c, ['Admin', 'Manager']);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const rows = await http.tx(c, (tx) => tx.q.listCapacities(query.team, after, limit + 1));
    const page = http.page(rows, limit, (r) => ({ id: r.user_id }));
    return c.json({ items: page.items.map(toCapacity), nextCursor: page.nextCursor });
  });

  svc.op('getCapacity', async (c, { params }) => {
    const p = http.staff(c);
    return c.json(await http.tx(c, (tx) => getCapacity(tx, p, params.userId)));
  });

  svc.op('putCapacity', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => putCapacity(tx, p, params.userId, body, expected)));
  });
}
