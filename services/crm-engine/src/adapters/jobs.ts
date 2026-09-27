// Scheduled jobs (infra/schedules.yaml). Contract enum: full-rescore, micromarket-refresh, projection-reconcile.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
