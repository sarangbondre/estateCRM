// Scheduled jobs (infra/schedules.yaml). Contract enum: ceiling-sweep, projection-refresh, change-feed-prune, idempotency-prune, rate-limit-prune, api-key-expire.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
