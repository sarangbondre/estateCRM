// Notifications, Watchlist tasks, settings and the internal subject-states feed (contract tags Notifications,
// Watchlist tasks, Settings, Internal).
import type { operations } from '@11e/contracts/journeys';
import type { Service } from '@11e/http';
import { putThresholds, putWeights, thresholds, thresholdsView, weights, weightsView } from '../application/settings.js';
import { completeWatchlistTask, markRead, notificationView, updateWatchlistTask, watchlistTaskView } from '../application/tasks.js';
import type { Http } from './http.js';

export function registerSettingsRoutes(svc: Service<operations>, http: Http): void {
  // ------------------------------------------------------------------------------------------------ notifications
  svc.op('listNotifications', async (c, { query }) => {
    const p = http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const rows = await http.tx(c, (tx) => tx.q.listNotifications(p.userId, query.unreadOnly === true, after, limit + 1));
    const page = http.page(rows, limit, (r) => ({ k: r.created_at.toISOString(), id: r.id }));
    return c.json({ items: page.items.map(notificationView), nextCursor: page.nextCursor });
  });

  svc.op('getUnreadCount', async (c) => {
    const p = http.staff(c);
    return c.json({ unread: await http.tx(c, (tx) => tx.q.unreadCount(p.userId)) });
  });

  svc.op('markNotificationsRead', async (c, { body }) => {
    const p = http.staff(c);
    return http.post(c, body, 200, (tx) => markRead(tx, p.userId, body));
  });

  // ------------------------------------------------------------------------------------------- watchlist tasks
  svc.op('listWatchlistTasks', async (c, { query }) => {
    http.staff(c);
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const rows = await http.tx(c, (tx) =>
      tx.q.listWatchlistTasks(
        { status: query.status, assigneeUserId: query.assigneeUserId, deadlineWithinDays: query.deadlineWithinDays },
        tx.today,
        after,
        limit + 1,
      ),
    );
    const page = http.page(rows, limit, (r) => ({ k: r.deadline_date, id: r.id }));
    return c.json({ items: page.items.map(watchlistTaskView), nextCursor: page.nextCursor });
  });

  svc.op('updateWatchlistTask', async (c, { params, body }) => {
    http.staff(c, ['Admin', 'Manager']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => updateWatchlistTask(tx, params.taskId, body, expected)));
  });

  svc.op('completeWatchlistTask', async (c, { params, body }) => {
    const p = http.staff(c, ['Admin', 'Manager', 'Supply agent']);
    return http.post(c, body, 200, (tx) => completeWatchlistTask(tx, p.userId, params.taskId, body));
  });

  // -------------------------------------------------------------------------------------------------- settings
  svc.op('getLifeCurveThresholds', async (c) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => thresholdsView(await thresholds(tx))));
  });

  svc.op('putLifeCurveThresholds', async (c, { body }) => {
    const p = http.staff(c, ['Admin']);
    const expected = http.ifMatch(c);
    return c.json(await http.tx(c, (tx) => putThresholds(tx, p.userId, body, expected)));
  });

  svc.op('getQueueWeights', async (c) => {
    http.staff(c);
    return c.json(await http.tx(c, async (tx) => weightsView(await weights(tx))));
  });

  svc.op('putQueueWeights', async (c, { body }) => {
    const p = http.staff(c, ['Admin']);
    const expected = http.ifMatch(c);
    const values = {
      freshness: body.freshness,
      demandGap: body.demandGap,
      sourceQuality: body.sourceQuality,
      priceBand: body.priceBand,
      ...(body.stalePublicBoost !== undefined ? { stalePublicBoost: body.stalePublicBoost } : {}),
      ...(body.ageingReconfirmBoost !== undefined ? { ageingReconfirmBoost: body.ageingReconfirmBoost } : {}),
      ...(body.freshnessHorizonDays !== undefined ? { freshnessHorizonDays: body.freshnessHorizonDays } : {}),
      ...(body.demandGapCap !== undefined ? { demandGapCap: body.demandGapCap } : {}),
      ...(body.mustCallDueHours !== undefined ? { mustCallDueHours: body.mustCallDueHours } : {}),
      ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
    };
    return c.json(await http.tx(c, (tx) => putWeights(tx, p.userId, values, expected)));
  });

  // ---------------------------------------------------------------------------------------- internal feed (R-2)
  svc.op('listSubjectStates', async (c, { query }) => {
    const limit = http.limit(query.limit);
    const after = http.cursor(c, query.cursor);
    const since = query.updatedSince ? new Date(query.updatedSince) : undefined;
    const rows = await http.tx(c, (tx) => tx.q.subjectStates(query.subjectType, since, after, limit + 1));
    const page = http.page(rows, limit, (r) => ({ k: r.updated_at.toISOString(), id: r.id }));
    return c.json({
      items: page.items.map((r) => ({
        subjectType: query.subjectType,
        subjectId: r.id,
        commercialStatus: r.commercial_status,
        exit: r.exit_type,
        lifeStage: (r.stage ?? 'Fresh') as 'Fresh',
        dayCount: r.day_count ?? 0,
        version: r.version,
        updatedAt: r.updated_at.toISOString(),
      })),
      nextCursor: page.nextCursor,
    });
  });
}
