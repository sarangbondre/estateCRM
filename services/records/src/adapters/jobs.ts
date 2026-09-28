// Scheduled jobs (infra/schedules.yaml). Contract enum: activate-vocabulary, recompute-launch-area,
// resolve-pending-repeats, retention-purge, expire-idempotency-keys, reconcile-counters.
// Each run is bounded (time budget + batch sizes) and reports `remaining` so the scheduler can continue.
import { randomUUID } from 'node:crypto';
import { expireIdempotencyKeys } from '@11e/db';
import type { JobResult } from '@11e/http';
import { purgeProcessedEvents, purgePublishedOutbox } from '@11e/outbox';
import { reconcileCountersStep, retentionPurgeStep } from '../application/maintenance.js';
import { SCHEMA } from '../config.js';
import { systemActor, tenantsOf } from '../application/context.js';
import { resolvePendingRepeats } from '../application/ingest.js';
import { activateVocabulary } from '../application/reference.js';
import { recomputeLaunchAreaStep } from '../application/recompute.js';
import type { AppDeps } from '../deps.js';

const BUDGET_MS = 45_000;

/** Runs `step` per tenant until it reports no more work or the time budget is spent. */
async function perTenant(
  deps: AppDeps,
  step: (tenantId: string, correlationId: string) => Promise<{ processed: number; more: boolean }>,
): Promise<JobResult> {
  const started = Date.now();
  const correlationId = `job-${randomUUID()}`;
  let processed = 0;
  let remaining = 0;
  for (const tenantId of await tenantsOf(deps.app)) {
    for (;;) {
      if (Date.now() - started > BUDGET_MS) {
        remaining++;
        break;
      }
      const r = await step(tenantId, correlationId);
      processed += r.processed;
      if (!r.more) break;
    }
  }
  return { processed, remaining };
}

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  const { app } = deps;
  return {
    'activate-vocabulary': () =>
      perTenant(deps, async (tenantId, cid) => {
        const r = await activateVocabulary(app, systemActor(tenantId, cid));
        return { processed: r.activated ? 1 : 0, more: false };
      }),
    'resolve-pending-repeats': () =>
      perTenant(deps, (tenantId, cid) => resolvePendingRepeats(app, systemActor(tenantId, cid))),
    'recompute-launch-area': () =>
      perTenant(deps, (tenantId, cid) => recomputeLaunchAreaStep(app, systemActor(tenantId, cid))),
    'retention-purge': async () => {
      const r = await perTenant(deps, (tenantId, cid) => retentionPurgeStep(app, systemActor(tenantId, cid)));
      // Technical retention (conventions §6): processed_events 30 days, published outbox rows 7 days.
      const queue = { db: deps.db, schema: SCHEMA };
      const technical = (await purgeProcessedEvents(queue, 30)) + (await purgePublishedOutbox(queue, 7));
      return { processed: r.processed + technical, remaining: r.remaining ?? 0 };
    },
    'expire-idempotency-keys': async () => {
      const n = await expireIdempotencyKeys(deps.db);
      return { processed: n, remaining: n >= 5000 ? 1 : 0 };
    },
    'reconcile-counters': () => perTenant(deps, (tenantId, cid) => reconcileCountersStep(app, systemActor(tenantId, cid))),
  };
}

/** One recompute step per tenant with a queued/running launch-area recompute (called after each q_records drain). */
export async function advanceQueuedRecompute(deps: AppDeps): Promise<void> {
  for (const tenantId of await tenantsOf(deps.app)) {
    await recomputeLaunchAreaStep(deps.app, systemActor(tenantId, `recompute-${randomUUID()}`));
  }
}
