// Scheduled jobs (infra/schedules.yaml). Contract enum: retention-purge, expire-idempotency-keys, reap-chunk-leases,
// delete-processed-files. Single-flight per job is handled by libs/http (job_leases → 409 on overlap).
import { expireIdempotencyKeys } from '@11e/db';
import type { JobResult } from '@11e/http';
import { deleteProcessedFiles, reapChunkLeases, retentionPurge } from '../application/jobs.js';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  const { app, db } = deps;
  return {
    'retention-purge': () => retentionPurge(app),
    'expire-idempotency-keys': async () => {
      const processed = await expireIdempotencyKeys(db);
      return { processed, remaining: processed >= 5000 ? 1 : 0 };
    },
    'reap-chunk-leases': () => reapChunkLeases(app),
    'delete-processed-files': () => deleteProcessedFiles(app),
  };
}
