// Scheduled jobs (infra/schedules.yaml). Contract enum: life-curve-nightly, demand-gap-refresh, rank-refresh,
// lease-renewal-scan, dormant-revisit, follow-up-reminders, queue-counts-flush, retention-purge.
import type { JobResult } from '@11e/http';
import { allJobs } from '../application/jobs.js';
import type { AppDeps } from '../deps.js';
import { createTxRunner } from './store.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  const runner = createTxRunner(deps.db, () => deps.clock.now());
  const all = allJobs({
    runner,
    clock: deps.clock,
    storage: deps.integrations.storage,
    ...(deps.jobBudgetMs !== undefined ? { budgetMs: deps.jobBudgetMs } : {}),
  });
  const out: Record<string, () => Promise<JobResult>> = {};
  for (const [name, run] of Object.entries(all)) {
    out[name] = async () => {
      const r = await run();
      return { processed: r.processed, remaining: r.remaining };
    };
  }
  return out;
}
