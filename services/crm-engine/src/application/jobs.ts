// Scheduled jobs (contract jobs enum, infra/schedules.yaml, LLD §4.5 "nightly", §4.8, §7): bounded batches with a
// cursor in job_runs; when the 50 s budget runs out the job queues its own continuation on q_crm_engine_rescore, so it
// finishes without waiting for the next pg_cron call.
import { addDays, istDate } from '../domain/dates.js';
import { Hierarchy } from '../domain/micromarket.js';
import type { MmSourceNode } from '../domain/micromarket.js';
import { onDemandChange, onOfferCommercialChange, onOfferLifeChange } from './propagation.js';
import type { Clock, MicromarketSource, Store, SubjectStateSource, UnitOfWork } from './ports.js';
import { weightsFor } from './pipeline.js';

export interface JobDeps {
  uow: UnitOfWork;
  clock: Clock;
  micromarkets: MicromarketSource;
  subjectStates: SubjectStateSource;
  /** Wall-clock budget per call (default 50 s, the platform function limit is 60 s). */
  budgetMs?: number;
}

export interface JobOutcome {
  processed: number;
  remaining: number;
  cursor?: string;
}

export const FULL_RESCORE = 'full-rescore';
export const FULL_RESCORE_ALL = 'full-rescore-all';
export const MICROMARKET_REFRESH = 'micromarket-refresh';
export const PROJECTION_RECONCILE = 'projection-reconcile';

const BATCH = 1000;
const RECOMPUTE_BATCH = 200;
/** Time-sensitive demands: move_in_by within this many days (the timing factor moves with the date). */
export const TIME_SENSITIVE_DAYS = 90;

type State = { cursor: string | null; processed: number; done: boolean };

function isSundayIst(now: Date): boolean {
  return new Date(now.getTime() + 330 * 60_000).getUTCDay() === 0;
}

async function forTenants(
  deps: JobDeps,
  tenantId: string | null,
  job: string,
  step: (
    tenant: string,
    deadline: number,
  ) => Promise<{ processed: number; done: boolean; cursor: string | null }>,
): Promise<JobOutcome> {
  const deadline = Date.now() + (deps.budgetMs ?? 50_000);
  const tenants = tenantId ? [tenantId] : await deps.uow.run(`job-${job}`, (s) => s.mx.tenants());
  let processed = 0;
  let remaining = 0;
  let cursor: string | undefined;
  for (const t of tenants) {
    if (Date.now() >= deadline) {
      remaining++;
      await deps.uow.run(`job-${job}`, (s) => s.rescore.enqueueJob(job, t));
      continue;
    }
    const r = await step(t, deadline);
    processed += r.processed;
    if (!r.done) {
      remaining++;
      if (r.cursor) cursor = r.cursor;
      await deps.uow.run(`job-${job}`, (s) => s.rescore.enqueueJob(job, t));
    }
  }
  return { processed, remaining, ...(cursor ? { cursor: cursor.slice(0, 200) } : {}) };
}

/**
 * full-rescore (03:00 IST): time-sensitive live demands nightly, every live demand on Sundays and after a weights
 * change (`full-rescore-all`, keyed by weights version). Demands are marked dirty in bulk; the re-score drain does
 * the scoring (deduped per subject).
 */
export async function runFullRescore(
  deps: JobDeps,
  tenantId: string | null,
  job: string = FULL_RESCORE,
): Promise<JobOutcome> {
  const now = deps.clock.now();
  const today = istDate(now);
  const all = job === FULL_RESCORE_ALL || isSundayIst(now);
  return forTenants(deps, tenantId, job, async (t, deadline) => {
    const key =
      job === FULL_RESCORE_ALL
        ? `${FULL_RESCORE_ALL}@w${await deps.uow.run('job', async (s) => (await weightsFor(s, t)).version)}`
        : all
          ? `${FULL_RESCORE}:all`
          : FULL_RESCORE;
    let state: State = (await deps.uow.run('job', (s) => s.jobs.get(key, today, t))) ?? {
      cursor: null,
      processed: 0,
      done: false,
    };
    let processed = 0;
    while (!state.done && Date.now() < deadline) {
      state = await deps.uow.run(`job-${key}`, async (s) => {
        const ids = all
          ? await s.mx.demandIdsAfter(t, state.cursor, BATCH, true)
          : await s.mx.timeSensitiveDemandIds(t, addDays(today, TIME_SENSITIVE_DAYS), state.cursor, BATCH);
        await s.rescore.markDirtyMany(t, 'demand', ids, key);
        const next: State = {
          cursor: ids.at(-1) ?? state.cursor,
          processed: state.processed + ids.length,
          done: ids.length < BATCH,
        };
        await s.jobs.save(key, today, t, next);
        processed += ids.length;
        return next;
      });
    }
    return { processed, done: state.done, cursor: state.cursor };
  });
}

function sameTree(h: Hierarchy, nodes: readonly MmSourceNode[]): boolean {
  if (h.size !== nodes.length) return false;
  const fresh = Hierarchy.fromSource(nodes);
  for (const n of fresh.nodes.values()) {
    const o = h.node(n.key);
    if (
      !o ||
      o.level !== n.level ||
      o.parentKey !== n.parentKey ||
      o.inLaunchArea !== n.inLaunchArea ||
      o.nameKeys.join('|') !== n.nameKeys.join('|') ||
      [...o.adjacentKeys].sort().join('|') !== [...n.adjacentKeys].sort().join('|')
    )
      return false;
  }
  return true;
}

/**
 * micromarket-refresh (R-13, LLD §4.8): reload the hierarchy and adjacency from records, then recompute offer
 * mm_path and demand mm_expanded in keyset batches; changed subjects are marked dirty and a full re-score follows.
 * records unreachable → the job fails and keeps the previous copy (retried by the next call).
 */
export async function runMicromarketRefresh(deps: JobDeps, tenantId: string | null): Promise<JobOutcome> {
  const today = istDate(deps.clock.now());
  return forTenants(deps, tenantId, MICROMARKET_REFRESH, async (t, deadline) => {
    let state: State = (await deps.uow.run('job', (s) => s.jobs.get(MICROMARKET_REFRESH, today, t))) ?? {
      cursor: null,
      processed: 0,
      done: false,
    };
    if (state.done) return { processed: 0, done: true, cursor: null };
    let processed = 0;
    if (state.cursor === null) {
      const nodes = await deps.micromarkets.fetchAll(t);
      state = await deps.uow.run('job-micromarket-refresh', async (s) => {
        const current = await s.hierarchy.load(t);
        const changed = !sameTree(current, nodes);
        if (changed) await s.hierarchy.replace(t, nodes, (await s.hierarchy.version(t)) + 1);
        const next: State = changed
          ? { cursor: 'o:', processed: 0, done: false }
          : { cursor: 'unchanged', processed: 0, done: true };
        await s.jobs.save(MICROMARKET_REFRESH, today, t, next);
        return next;
      });
    }
    while (!state.done && Date.now() < deadline) {
      state = await deps.uow.run('job-micromarket-refresh', (s) => recomputeBatch(s, t, today, state));
      processed += RECOMPUTE_BATCH;
    }
    return { processed, done: state.done, cursor: state.cursor };
  });
}

async function recomputeBatch(s: Store, t: string, today: string, state: State): Promise<State> {
  const h = await s.hierarchy.load(t);
  const [phase, after] = [(state.cursor ?? 'o:').slice(0, 1), (state.cursor ?? 'o:').slice(2) || null];
  let next: State;
  if (phase === 'o') {
    const ids = await s.mx.offerIdsAfter(t, after, RECOMPUTE_BATCH);
    for (const o of await s.mx.getOffers(t, ids)) {
      const mmPath = h.offerPath(o.micromarket, o.locality);
      if (mmPath.join('|') === o.mmPath.join('|')) continue;
      await s.mx.saveOffer({ ...o, mmPath });
      await s.rescore.markDirty(t, 'offer', o.id, MICROMARKET_REFRESH);
    }
    next = {
      cursor: ids.length < RECOMPUTE_BATCH ? 'd:' : `o:${ids.at(-1) as string}`,
      processed: state.processed + ids.length,
      done: false,
    };
  } else {
    const ids = await s.mx.demandIdsAfter(t, after, RECOMPUTE_BATCH, false);
    for (const d of await s.mx.getDemands(t, ids)) {
      const mmExpanded = h.demandExpanded(d.micromarkets, d.localities);
      if (mmExpanded.join('|') === d.mmExpanded.join('|')) continue;
      await s.mx.saveDemand({ ...d, mmExpanded });
    }
    const done = ids.length < RECOMPUTE_BATCH;
    next = {
      cursor: done ? 'done' : `d:${ids.at(-1) as string}`,
      processed: state.processed + ids.length,
      done,
    };
    if (done) await s.rescore.enqueueJob(FULL_RESCORE_ALL, t);
  }
  await s.jobs.save(MICROMARKET_REFRESH, today, t, next);
  return next;
}

/** A new micromarket release: restart today's refresh for the tenant (the event handler queues the job). */
export async function resetMicromarketRefresh(store: Store, clock: Clock, tenantId: string): Promise<void> {
  await store.jobs.save(MICROMARKET_REFRESH, istDate(clock.now()), tenantId, {
    cursor: null,
    processed: 0,
    done: false,
  });
}

/** Retention windows (LLD §7). */
export const RETENTION = {
  closedMatchesDays: 730,
  feedbackDays: 730,
  exclusionsDays: 90,
  runsDays: 30,
  mergedDays: 30,
};

/**
 * projection-reconcile (Sunday 04:00 IST): compare the journeys-owned axes (life stage, Commercial status, exit)
 * with journeys' GET /internal/v1/subject-states and repair gaps (with the same match effects as the events), then
 * apply the retention windows of LLD §7 in bounded batches.
 */
export async function runReconcile(deps: JobDeps, tenantId: string | null): Promise<JobOutcome> {
  const now = deps.clock.now();
  const today = istDate(now);
  return forTenants(deps, tenantId, PROJECTION_RECONCILE, async (t, deadline) => {
    let state: State = (await deps.uow.run('job', (s) => s.jobs.get(PROJECTION_RECONCILE, today, t))) ?? {
      cursor: null,
      processed: 0,
      done: false,
    };
    let processed = 0;
    while (!state.done && Date.now() < deadline) {
      const cursor = state.cursor ?? 'offer:';
      const phase = cursor.slice(0, cursor.indexOf(':'));
      const pageCursor = cursor.slice(cursor.indexOf(':') + 1) || null;
      if (phase === 'offer' || phase === 'demand') {
        const page = await deps.subjectStates.page(t, phase, pageCursor);
        state = await deps.uow.run('job-reconcile', async (s) => {
          for (const st of page.items) await repairSubject(s, deps.clock, t, st);
          const nextCursor = page.nextCursor
            ? `${phase}:${page.nextCursor}`
            : phase === 'offer'
              ? 'demand:'
              : 'retention:';
          const next: State = {
            cursor: nextCursor,
            processed: state.processed + page.items.length,
            done: false,
          };
          await s.jobs.save(PROJECTION_RECONCILE, today, t, next);
          return next;
        });
        processed += page.items.length;
      } else {
        state = await deps.uow.run('job-reconcile', async (s) => {
          const day = 86_400_000;
          const removed =
            (await s.retention.closedMatches(
              t,
              new Date(now.getTime() - RETENTION.closedMatchesDays * day),
              5000,
            )) +
            (await s.retention.feedback(t, new Date(now.getTime() - RETENTION.feedbackDays * day), 5000)) +
            (await s.retention.exclusions(
              t,
              new Date(now.getTime() - RETENTION.exclusionsDays * day),
              5000,
            )) +
            (await s.retention.runs(t, new Date(now.getTime() - RETENTION.runsDays * day), 5000)) +
            (await s.retention.mergedProjection(
              t,
              new Date(now.getTime() - RETENTION.mergedDays * day),
              5000,
            )) +
            (await s.retention.technical(now));
          const next: State = {
            cursor: removed > 0 ? 'retention:' : 'done',
            processed: state.processed + removed,
            done: removed === 0,
          };
          await s.jobs.save(PROJECTION_RECONCILE, today, t, next);
          processed += removed;
          return next;
        });
      }
    }
    return { processed, done: state.done, cursor: state.cursor };
  });
}

async function repairSubject(
  s: Store,
  clock: Clock,
  tenantId: string,
  st: {
    subjectType: 'offer' | 'demand';
    subjectId: string;
    lifeStage: string;
    commercialStatus: string;
    exit: string | null;
    version: number;
  },
): Promise<void> {
  void clock;
  if (st.subjectType === 'offer') {
    const o = await s.mx.getOffer(tenantId, st.subjectId);
    if (!o) return;
    const life = st.version > o.lifeVersion && st.lifeStage !== o.lifeStage;
    const commercial = st.version > o.commercialVersion && st.commercialStatus !== o.commercialStatus;
    if (!life && !commercial) return;
    const after = {
      ...o,
      ...(life ? { lifeStage: st.lifeStage, lifeVersion: st.version } : {}),
      ...(commercial ? { commercialStatus: st.commercialStatus, commercialVersion: st.version } : {}),
    };
    await s.mx.saveOffer(after);
    if (life) await onOfferLifeChange(s, { before: o, after });
    if (commercial) await onOfferCommercialChange(s, { before: o, after });
    await s.rescore.markDirty(tenantId, 'offer', o.id, PROJECTION_RECONCILE);
  } else {
    const d = await s.mx.getDemand(tenantId, st.subjectId);
    if (!d) return;
    const life = st.version > d.lifeVersion && st.lifeStage !== d.lifeStage;
    const status =
      st.version > d.statusVersion &&
      (st.commercialStatus !== d.commercialStatus || (st.exit ?? null) !== d.exitType);
    if (!life && !status) return;
    const after = {
      ...d,
      ...(life ? { lifeStage: st.lifeStage, lifeVersion: st.version } : {}),
      ...(status
        ? { commercialStatus: st.commercialStatus, exitType: st.exit ?? null, statusVersion: st.version }
        : {}),
    };
    await s.mx.saveDemand(after);
    await onDemandChange(s, { before: d, after });
    await s.rescore.markDirty(tenantId, 'demand', d.id, PROJECTION_RECONCILE);
  }
}
