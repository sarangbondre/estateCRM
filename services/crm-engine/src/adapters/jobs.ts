// Scheduled jobs (infra/schedules.yaml). Contract enum: full-rescore, micromarket-refresh, projection-reconcile.
// Each call works through bounded batches within a 50 s budget; unfinished work continues via q_crm_engine_rescore.
import type { JobResult } from '@11e/http';
import { withSpan } from '@11e/observability';
import type { JobDeps, JobOutcome } from '../application/jobs.js';
import {
  FULL_RESCORE,
  FULL_RESCORE_ALL,
  MICROMARKET_REFRESH,
  PROJECTION_RECONCILE,
  runFullRescore,
  runMicromarketRefresh,
  runReconcile,
} from '../application/jobs.js';
import type { AppDeps } from '../deps.js';
import { pgUnitOfWork } from './store.js';

export function jobDeps(
  deps: Pick<AppDeps, 'db' | 'clock' | 'micromarkets' | 'subjectStates'>,
  budgetMs?: number,
): JobDeps {
  return {
    uow: pgUnitOfWork(deps.db, () => deps.clock.now()),
    clock: deps.clock,
    micromarkets: deps.micromarkets,
    subjectStates: deps.subjectStates,
    ...(budgetMs !== undefined ? { budgetMs } : {}),
  };
}

const toResult = (o: JobOutcome): JobResult => ({
  processed: o.processed,
  remaining: o.remaining,
  ...(o.cursor ? { cursor: o.cursor } : {}),
});

/** Runs a job (or its continuation) for one tenant or, from the scheduler, for every tenant. */
export function runJob(d: JobDeps, job: string, tenantId: string | null): Promise<JobOutcome> {
  switch (job) {
    case FULL_RESCORE:
    case FULL_RESCORE_ALL:
      return runFullRescore(d, tenantId, job);
    case MICROMARKET_REFRESH:
      return runMicromarketRefresh(d, tenantId);
    case PROJECTION_RECONCILE:
      return runReconcile(d, tenantId);
    default:
      return Promise.resolve({ processed: 0, remaining: 0 });
  }
}

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  const d = jobDeps(deps);
  const traced = (name: string, fn: () => Promise<JobOutcome>) => async () => {
    const started = Date.now();
    const o = await withSpan(`job ${name}`, fn, { 'job.name': name });
    deps.obs.logger.info(
      { code: name, processed: o.processed, remaining: o.remaining, durationMs: Date.now() - started },
      'job batch',
    );
    return toResult(o);
  };
  return {
    [FULL_RESCORE]: traced(FULL_RESCORE, () => runFullRescore(d, null)),
    [MICROMARKET_REFRESH]: traced(MICROMARKET_REFRESH, () => runMicromarketRefresh(d, null)),
    [PROJECTION_RECONCILE]: traced(PROJECTION_RECONCILE, () => runReconcile(d, null)),
  };
}
