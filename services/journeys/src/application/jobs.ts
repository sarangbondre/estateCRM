// Scheduled jobs (LLD §4.1.5, §4.3, §4.7, §7; contract runJob enum). Each call works in bounded batches (one
// transaction per batch) until its time budget is used, and reports `remaining` so pg_cron calls again next minute.
import { addDays, addMonths, istDate } from '../domain/dates.js';
import { DEMAND_SECTIONS, SUPPLY_SECTIONS } from '../domain/queue.js';
import { refreshCurve } from './curve.js';
import { rederiveOffer } from './derive.js';
import { notify } from './notify.js';
import type { Clock, FileStoragePort, Tx, TxRunner } from './ports.js';
import type { Position } from './queries.js';
import { openItem, rankOffer, resolveAssignee } from './queue-ops.js';
import { REARM_DATE, REARM_JOB } from './settings.js';

export interface JobOutcome {
  processed: number;
  remaining: number;
}

export interface JobDeps {
  runner: TxRunner;
  clock: Clock;
  storage: FileStoragePort;
  /** Per-call time budget (50 s under the 55 s function limit). */
  budgetMs?: number;
  batchSize?: number;
}

const JOB_TX_TIMEOUT = 30_000;

async function perTenant(
  deps: JobDeps,
  job: string,
  batch: (tx: Tx) => Promise<{ processed: number; more: boolean }>,
): Promise<JobOutcome> {
  const started = Date.now();
  const budget = deps.budgetMs ?? 50_000;
  let processed = 0;
  for (const tenant of await deps.runner.tenants()) {
    for (;;) {
      if (Date.now() - started > budget) return { processed, remaining: 1 };
      const r = await deps.runner.run(tenant, { correlationId: `job:${job}`, statementTimeoutMs: JOB_TX_TIMEOUT }, batch);
      processed += r.processed;
      if (!r.more) break;
    }
  }
  return { processed, remaining: 0 };
}

/**
 * life-curve-nightly (02:00 IST): only rows whose stage can change today (`next_change_on ≤ today`), batches of 1,000
 * in keyset order; stage actions and events in the same transaction; Upcoming → Available on the availability date.
 */
export function lifeCurveNightly(deps: JobDeps) {
  const size = deps.batchSize ?? 1000;
  return perTenant(deps, 'life-curve-nightly', async (tx) => {
    // New thresholds first re-arm the curves of the changed categories (bounded batches), then they are evaluated below.
    const rearm = await tx.q.jobCursor(REARM_JOB, REARM_DATE);
    if (rearm && !rearm.done && rearm.cursor) {
      const c = JSON.parse(rearm.cursor) as { keys: string[]; after: string | null };
      const last = await tx.q.rearmCurves(c.keys, c.after, tx.today, 10_000);
      await tx.q.saveJobCursor(REARM_JOB, REARM_DATE, last ? JSON.stringify({ keys: c.keys, after: last }) : null, 0, !last, tx.now);
      return { processed: 0, more: true };
    }
    const rows = await tx.q.dueCurves(tx.today, size);
    for (const row of rows) {
      const { row: after } = await refreshCurve(tx, row, {});
      if (after.next_change_on && after.next_change_on <= tx.today)
        await tx.rows.update('life_curve', row.id, { next_change_on: addDays(tx.today, 1) });
      if (row.subject_type === 'offer' && row.clock_starts_on) {
        const oj = await tx.rows.get('offer_journey', row.subject_id);
        if (oj?.commercial_status === 'Upcoming') await rederiveOffer(tx, row.subject_id, { reason: 'available_from_reached' });
      }
    }
    await tx.q.saveJobCursor('life-curve-nightly', tx.today, null, rows.length, rows.length < size, tx.now);
    return { processed: rows.length, more: rows.length === size };
  });
}

/** demand-gap-refresh (02:45 IST): open demand vs matching supply per cell, source quality; ranks re-computed after. */
export function demandGapRefresh(deps: JobDeps) {
  return perTenant(deps, 'demand-gap-refresh', async (tx) => {
    const done = await tx.q.jobCursor('demand-gap-refresh', tx.today);
    if (done?.done) return { processed: 0, more: false };
    const cells = await tx.q.recomputeDemandGap(tx.now, tx.today);
    const sources = await tx.q.recomputeSourceQuality(tx.now, addDays(tx.today, -90));
    await tx.q.markRankDirty({ all: true });
    await tx.q.saveJobCursor('demand-gap-refresh', tx.today, null, cells + sources, true, tx.now);
    return { processed: cells + sources, more: false };
  });
}

/** rank-refresh (every 5 min): recompute Should call ranks of dirty items. */
export function rankRefresh(deps: JobDeps) {
  const size = Math.min(deps.batchSize ?? 500, 500);
  return perTenant(deps, 'rank-refresh', async (tx) => {
    const items = await tx.q.dirtyRankItems(size);
    const offers = new Map((await tx.rows.getMany('offer_view', items.map((i) => i.offer_id).filter((x): x is string => !!x))).map((o) => [o.id, o]));
    for (const item of items) {
      const offer = item.offer_id ? offers.get(item.offer_id) : undefined;
      if (!offer) {
        await tx.rows.update('queue_items', item.id, { rank_dirty: false });
        continue;
      }
      const curve = await tx.q.curveBySubject('offer', offer.id);
      const boost =
        item.reason === 'stale_public' ? 'stale_public' : curve?.stage === 'Ageing' && item.reason !== 'new_capture' ? 'ageing' : 'none';
      const r = await rankOffer(tx, offer, boost);
      await tx.rows.update('queue_items', item.id, {
        rank_score: r.score,
        rank_factors: r.factors as unknown as Record<string, number>,
        rank_dirty: false,
      });
    }
    return { processed: items.length, more: items.length === size };
  });
}

/** lease-renewal-scan (05:00 IST): lease_renewal.due.v1 for renewals with due_on ≤ today (records creates the Upcoming offer). */
export function leaseRenewalScan(deps: JobDeps) {
  return perTenant(deps, 'lease-renewal-scan', async (tx) => {
    const due = await tx.q.dueLeaseRenewals(tx.today, 200);
    for (const r of due) {
      await tx.events.emit(
        'lease_renewal.due.v1',
        { type: 'lease_renewal', id: r.id },
        { propertyId: r.property_id, previousOfferId: r.offer_id, availableFrom: r.available_from },
      );
      await tx.rows.update('lease_renewals', r.id, { status: 'emitted', emitted_at: tx.now });
    }
    return { processed: due.length, more: due.length === 200 };
  });
}

/** dormant-revisit (06:00 IST): Dormant demands with revisit_date ≤ today go to dormant_revisits. */
export function dormantRevisit(deps: JobDeps) {
  return perTenant(deps, 'dormant-revisit', async (tx) => {
    const saved = await tx.q.jobCursor('dormant-revisit', tx.today);
    if (saved?.done) return { processed: 0, more: false };
    const after = saved?.cursor ? (JSON.parse(saved.cursor) as Position) : undefined;
    const due = await tx.q.dueDormantRevisits(tx.today, after, 200);
    for (const d of due) {
      if (await tx.q.openItemFor('dormant_revisits', 'demand', d.id)) continue;
      const view = await tx.rows.get('demand_view', d.id);
      if (!view || view.voided) continue;
      await openItem(tx, {
        section: 'dormant_revisits',
        subjectType: 'demand',
        subjectId: d.id,
        subjectCode: view.code,
        demandId: d.id,
        assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
        reason: 'revisit',
        dueAt: new Date(`${d.revisit_date}T00:00:00+05:30`),
      });
      await notify(tx, view.owner_user_id, {
        kind: 'dormant_revisit',
        title: `Dormant revisit due: ${view.code}`,
        subject: { type: 'demand', id: view.id, code: view.code },
      });
    }
    const last = due.at(-1);
    await tx.q.saveJobCursor('dormant-revisit', tx.today, last ? JSON.stringify({ k: last.revisit_date, id: last.id }) : null, due.length, due.length < 200, tx.now);
    return { processed: due.length, more: due.length === 200 };
  });
}

/** follow-up-reminders (08:00 IST): overdue deals (deal.updated.v1 overdue=true once) and SRQs notify their owners. */
export function followUpReminders(deps: JobDeps) {
  return perTenant(deps, 'follow-up-reminders', async (tx) => {
    const saved = await tx.q.jobCursor('follow-up-reminders', tx.today);
    if (saved?.done) return { processed: 0, more: false };
    const cursor = saved?.cursor ? (JSON.parse(saved.cursor) as { deals?: Position; srqs?: Position; phase: 'deals' | 'srqs' }) : { phase: 'deals' as const };
    const yesterday = addDays(tx.today, -1);
    if (cursor.phase === 'deals') {
      const deals = await tx.q.overdueDeals(tx.today, cursor.deals, 200);
      for (const d of deals) {
        if (d.follow_up_date === yesterday) {
          await tx.events.emit(
            'deal.updated.v1',
            { type: 'deal', id: d.id },
            { dealId: d.id, stage: d.stage, followUpDate: d.follow_up_date, overdue: true },
          );
        }
        await notify(tx, d.owner_user_id ?? d.created_by, {
          kind: 'deal_follow_up_overdue',
          title: `Follow-up overdue on ${d.code}`,
          subject: { type: 'deal', id: d.id, code: d.code },
          dedupeKey: `deal_overdue:${d.id}`,
        });
      }
      const last = deals.at(-1);
      const next = deals.length === 200 && last ? { phase: 'deals', deals: { k: last.follow_up_date, id: last.id } } : { phase: 'srqs' };
      await tx.q.saveJobCursor('follow-up-reminders', tx.today, JSON.stringify(next), deals.length, false, tx.now);
      return { processed: deals.length, more: true };
    }
    const srqs = await tx.q.overdueSourcingRequests(tx.today, cursor.srqs, 200);
    for (const s of srqs) {
      for (const user of new Set([s.assignee_user_id, s.requested_by])) {
        await notify(tx, user, {
          kind: 'srq_assigned',
          title: `Sourcing request ${s.code} is overdue`,
          subject: { type: 'sourcing_request', id: s.id, code: s.code },
          dedupeKey: `srq_overdue:${s.id}`,
        });
      }
    }
    const last = srqs.at(-1);
    const more = srqs.length === 200;
    await tx.q.saveJobCursor(
      'follow-up-reminders',
      tx.today,
      more && last ? JSON.stringify({ phase: 'srqs', srqs: { k: last.due_date, id: last.id } }) : null,
      srqs.length,
      !more,
      tx.now,
    );
    return { processed: srqs.length, more };
  });
}

const SECTIONS = [...SUPPLY_SECTIONS, ...DEMAND_SECTIONS];

/** queue-counts-flush (every minute): one queue.counts_changed.v1 per user whose counters changed (≤ 1/min, R-18). */
export function queueCountsFlush(deps: JobDeps) {
  return perTenant(deps, 'queue-counts-flush', async (tx) => {
    const users = await tx.q.changedCounterUsers(200);
    for (const userId of users) {
      const counters = await tx.q.countersOf(userId);
      const counts: Record<string, number> = {};
      for (const s of SECTIONS) counts[s] = 0;
      for (const c of counters) counts[c.section] = c.open_count;
      await tx.events.emit('queue.counts_changed.v1', { type: 'user', id: userId }, { userId, counts });
      await tx.q.markCountersEmitted(userId, tx.now);
    }
    return { processed: users.length, more: users.length === 200 };
  });
}

/** retention-purge (Sunday 03:30 IST): NFR-18, R-15 (LLD §7). */
export function retentionPurge(deps: JobDeps) {
  return perTenant(deps, 'retention-purge', async (tx) => {
    const d90 = new Date(tx.now.getTime() - 90 * 86_400_000);
    const m24 = new Date(`${addMonths(istDate(tx.now), -24)}T00:00:00+05:30`);
    let n = 0;
    n += (await tx.q.purgeBefore('notifications', d90, 1000)).count;
    n += (await tx.q.purgeBefore('link_opens', d90, 1000)).count;
    n += (await tx.q.purgeBefore('pii_notes', m24, 1000)).count;
    const snaps = await tx.q.purgeBefore('snapshots', m24, 200);
    if (snaps.paths.length) await deps.storage.remove(snaps.paths);
    n += snaps.count;
    return { processed: n, more: n >= 1000 };
  });
}

export type JobName =
  | 'life-curve-nightly'
  | 'demand-gap-refresh'
  | 'rank-refresh'
  | 'lease-renewal-scan'
  | 'dormant-revisit'
  | 'follow-up-reminders'
  | 'queue-counts-flush'
  | 'retention-purge';

export function allJobs(deps: JobDeps): Record<JobName, () => Promise<JobOutcome>> {
  return {
    'life-curve-nightly': () => lifeCurveNightly(deps),
    'demand-gap-refresh': () => demandGapRefresh(deps),
    'rank-refresh': () => rankRefresh(deps),
    'lease-renewal-scan': () => leaseRenewalScan(deps),
    'dormant-revisit': () => dormantRevisit(deps),
    'follow-up-reminders': () => followUpReminders(deps),
    'queue-counts-flush': () => queueCountsFlush(deps),
    'retention-purge': () => retentionPurge(deps),
  };
}
