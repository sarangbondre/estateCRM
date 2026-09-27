// Scheduled jobs (infra/schedules.yaml). Contract enum: activate-vocabulary, recompute-launch-area, resolve-pending-repeats, retention-purge, expire-idempotency-keys, reconcile-counters.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
