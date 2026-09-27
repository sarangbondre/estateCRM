// Scheduled jobs (infra/schedules.yaml; contract enum: export-expire, conversation-purge, rollup-reconcile,
// vocabulary-refresh, idempotency-prune, hf-credit-reset). Bounded batches; `remaining` > 0 asks the scheduler to
// call again.
import { sql } from 'kysely';
import { expireIdempotencyKeys } from '@11e/db';
import type { JobResult } from '@11e/http';
import { purgeProcessedEvents, purgePublishedOutbox } from '@11e/outbox';
import { SCHEMA } from '../config.js';
import type { AppDeps } from '../deps.js';
import { refreshReferenceData } from '../application/reference.js';
import { reconcileRollups } from './reconcile.js';
import type { Wired } from './wiring.js';

export type JobName =
  | 'export-expire'
  | 'conversation-purge'
  | 'rollup-reconcile'
  | 'vocabulary-refresh'
  | 'idempotency-prune'
  | 'hf-credit-reset';

export function jobs(
  deps: AppDeps,
  wired: Wired,
  extra: Partial<Record<JobName, () => Promise<JobResult>>> = {},
): Record<string, () => Promise<JobResult>> {
  const { db } = deps;
  return {
    // Rebuilds each tenant's rollups from the base tables (corrects any drift), within the time budget. Tenants are
    // few (one in Phase 1); a tenant not reached in this call is picked up by the next one (remaining > 0).
    'rollup-reconcile': async () => {
      const budget = Date.now() + (deps.jobBudgetMs ?? 50_000);
      const tenants = await sql<{ tenant_id: string }>`
        select tenant_id from rm_state order by updated_at, tenant_id limit 1000`.execute(db);
      let processed = 0;
      for (const { tenant_id } of tenants.rows) {
        if (Date.now() > budget) break;
        await reconcileRollups(db, tenant_id);
        await sql`update rm_state set updated_at = now() where tenant_id = ${tenant_id}`.execute(db);
        processed++;
      }
      return { processed, remaining: tenants.rows.length - processed };
    },
    // Idempotency keys past their 24 h window, plus the retention of the technical tables (conventions §6).
    'idempotency-prune': async () => {
      const keys = await expireIdempotencyKeys(db, deps.clock.now());
      const events = await purgeProcessedEvents({ db, schema: SCHEMA });
      const outbox = await purgePublishedOutbox({ db, schema: SCHEMA });
      const processed = keys + events + outbox;
      return { processed, remaining: keys >= 5000 || events >= 5000 || outbox >= 5000 ? 1 : 0 };
    },
    // Active vocabulary release + micromarket hierarchy from records after vocabulary.released / micromarkets.updated.
    'vocabulary-refresh': async () => {
      const unavailable = { available: false } as const;
      const r = await refreshReferenceData(
        deps.records ?? { ...unavailable, vocabulary: () => Promise.reject(new Error('n/a')), micromarkets: () => Promise.reject(new Error('n/a')) },
        wired.referenceStore,
        deps.jobBudgetMs ?? 50_000,
      );
      wired.clearCaches();
      return r;
    },
    ...extra,
  } as Record<string, () => Promise<JobResult>>;
}
