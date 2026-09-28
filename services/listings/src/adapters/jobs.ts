// Scheduled jobs (infra/schedules.yaml). Contract enum: ceiling-sweep, projection-refresh, change-feed-prune,
// idempotency-prune, rate-limit-prune, api-key-expire. Each call runs one bounded batch; `remaining` > 0 → the scheduler
// may call again.
import type { JobResult } from '@11e/http';
import { withSpan } from '@11e/observability';
import {
  apiKeyExpire,
  ceilingSweep,
  changeFeedPrune,
  idempotencyPrune,
  projectionRefresh,
  rateLimitPrune,
} from '../application/jobs.js';
import type { JobOutcome } from '../application/jobs.js';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  const { services: s, maintenance: m, obs } = deps;
  const run = (name: string, fn: () => Promise<JobOutcome>) => async (): Promise<JobResult> => {
    const r = await withSpan(`job ${name}`, fn);
    for (const hit of r.auditHits ?? []) {
      // M8 output audit: a served payload matched a blocking pattern. Alarm (never the matched text).
      obs.logger.error(
        { code: 'm8-output-audit-hit', tenantId: hit.tenantId },
        `public item ${hit.publicId}: ${hit.kinds.join(',')}`,
      );
    }
    obs.logger.info({ code: `job-${name}`, count: r.processed }, 'job batch');
    return { processed: r.processed, remaining: r.remaining };
  };
  return {
    'ceiling-sweep': run('ceiling-sweep', () => ceilingSweep(s, m)),
    'projection-refresh': run('projection-refresh', () => projectionRefresh(s, m)),
    'change-feed-prune': run('change-feed-prune', () => changeFeedPrune(s, m)),
    'idempotency-prune': run('idempotency-prune', () => idempotencyPrune(m)),
    'rate-limit-prune': run('rate-limit-prune', () => rateLimitPrune(s, m)),
    'api-key-expire': run('api-key-expire', () => apiKeyExpire(s, m)),
  };
}
