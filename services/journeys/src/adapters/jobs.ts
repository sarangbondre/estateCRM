// Scheduled jobs (infra/schedules.yaml). Contract enum: life-curve-nightly, demand-gap-refresh, rank-refresh, lease-renewal-scan, dormant-revisit, follow-up-reminders, queue-counts-flush, retention-purge.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
