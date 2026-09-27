// Scheduled jobs (infra/schedules.yaml). Contract enum: retention-purge, expire-idempotency-keys, reap-chunk-leases, delete-processed-files.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
