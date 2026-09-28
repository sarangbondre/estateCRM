// The platform endpoints every backend service exposes to pg_cron (ADR-0003, F-15):
//   POST /internal/v1/relay            → relayOutbox
//   POST /internal/v1/drain/{queue}    → the service's drain for that queue
//   POST /internal/v1/jobs/{name}      → a scheduled job, single-flight through a lease row (409 while running)
// Auth (cron secret) comes from the contract via libs/auth; this module only wires handlers.
import type { Kysely } from 'kysely';
import { relayOutbox } from '@11e/outbox';
import type { DrainResult, EventRoutes, QueueContext, RelayResult } from '@11e/outbox';
import type { Service } from './app.js';
import { HttpError } from './errors.js';

export interface JobResult {
  processed: number;
  remaining?: number | null;
  /** Resume point for batched jobs ('batch' response style). */
  cursor?: string;
}

/**
 * The approved contracts use three response shapes for these endpoints (fixed per service):
 * - 'summary' (intake, records): { processed, remaining, durationMs }
 * - 'batch' (journeys, crm-engine): relay { claimed, published, lagSeconds }, drain { queue, read, applied, duplicates,
 *   failed, movedToDlq }, job { job, runId, processed, done, cursor?, startedAt }
 * - 'compact' (web, listings, insight): { processed, failed?, deadLettered?, more }
 */
export type PlatformResponseStyle = 'summary' | 'batch' | 'compact';

export interface JobLeasesTable {
  name: string;
  run_id: string;
  leased_until: Date;
  last_started_at: Date;
  last_finished_at: Date | null;
}

export interface PlatformEndpointsOptions<DB> {
  responseStyle: PlatformResponseStyle;
  queue: QueueContext<DB>;
  /** event-topology.json `routes`. */
  routes: EventRoutes;
  /** One drain per owned queue (event queue + work queues). */
  drains: Record<string, () => Promise<DrainResult>>;
  jobs: Record<string, () => Promise<JobResult>>;
  /** Lease longer than the 60 s function limit, so a killed run frees the job soon. Default 90 s. */
  jobLeaseSec?: number;
  onRelay?: (result: RelayResult) => void;
  onDrain?: (queue: string, result: DrainResult) => void;
}

export function registerPlatformEndpoints<Ops, DB>(
  svc: Service<Ops>,
  options: PlatformEndpointsOptions<DB>,
): void {
  const leaseSec = options.jobLeaseSec ?? 90;
  const leases = options.queue.db as unknown as Kysely<{ job_leases: JobLeasesTable }>;

  svc.opAt('POST', '/internal/v1/relay', async (c) => {
    const r = await relayOutbox(options.queue, { routes: options.routes });
    options.onRelay?.(r);
    switch (options.responseStyle) {
      case 'batch':
        return c.json({
          claimed: r.processed + r.unroutable,
          published: r.processed,
          ...(r.oldestPendingAgeSec !== null ? { lagSeconds: r.oldestPendingAgeSec } : {}),
        });
      case 'compact':
        return c.json({ processed: r.processed, more: r.remaining > 0 });
      default:
        return c.json({ processed: r.processed, remaining: r.remaining, durationMs: r.durationMs });
    }
  });

  svc.opAt('POST', '/internal/v1/drain/{queue}', async (c) => {
    const queue = c.req.param('queue') ?? '';
    const drain = options.drains[queue];
    if (!drain) throw new HttpError(404, 'not-found', { detail: `no drain for ${queue}` });
    const r = await drain();
    options.onDrain?.(queue, r);
    switch (options.responseStyle) {
      case 'batch':
        return c.json({
          queue,
          read: r.processed + r.duplicates + r.failed + r.deadLettered,
          applied: r.processed,
          duplicates: r.duplicates,
          failed: r.failed,
          movedToDlq: r.deadLettered,
        });
      case 'compact':
        return c.json({
          processed: r.processed + r.duplicates,
          failed: r.failed,
          deadLettered: r.deadLettered,
          more: (r.remaining ?? 0) > 0,
        });
      default:
        return c.json({
          processed: r.processed + r.duplicates,
          remaining: r.remaining,
          durationMs: r.durationMs,
        });
    }
  });

  svc.opAt('POST', '/internal/v1/jobs/{name}', async (c) => {
    const name = c.req.param('name') ?? '';
    const job = options.jobs[name];
    if (!job) throw new HttpError(404, 'not-found', { detail: `job ${name} is not implemented` });
    const started = Date.now();
    const runId = crypto.randomUUID();
    const now = new Date();
    const until = new Date(now.getTime() + leaseSec * 1000);
    const claimed = await leases
      .insertInto('job_leases')
      .values({ name, run_id: runId, leased_until: until, last_started_at: now, last_finished_at: null })
      .onConflict((oc) =>
        oc
          .column('name')
          .doUpdateSet({ run_id: runId, leased_until: until, last_started_at: now })
          .where('job_leases.leased_until', '<', now),
      )
      .returning('run_id')
      .executeTakeFirst();
    if (!claimed) throw new HttpError(409, 'conflict', { detail: `job ${name} is already running` });
    try {
      const r = await job();
      switch (options.responseStyle) {
        case 'batch':
          return c.json({
            job: name,
            runId,
            processed: r.processed,
            done: !r.remaining,
            ...(r.cursor ? { cursor: r.cursor } : {}),
            startedAt: now.toISOString(),
          });
        case 'compact':
          return c.json({ processed: r.processed, more: (r.remaining ?? 0) > 0 });
        default:
          return c.json({
            processed: r.processed,
            remaining: r.remaining ?? null,
            durationMs: Date.now() - started,
          });
      }
    } finally {
      await leases
        .updateTable('job_leases')
        .set({ leased_until: new Date(0), last_finished_at: new Date() }) // fully released: a run starting in the same ms can claim it
        .where('name', '=', name)
        .where('run_id', '=', runId)
        .execute();
    }
  });
}
