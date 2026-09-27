// Scheduled jobs (infra/schedules.yaml). Contract enum: export-expire, conversation-purge, rollup-reconcile, vocabulary-refresh, idempotency-prune, hf-credit-reset.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
