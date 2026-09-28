// journeys HTTP app: contract-driven routes, auth, observability and the platform endpoints (F-SVC scaffold).
import topology from '@11e/contracts/event-topology.json' with { type: 'json' };
import spec from '@11e/contracts/openapi/journeys.json' with { type: 'json' };
import type { operations } from '@11e/contracts/journeys';
import { checkDbReady } from '@11e/db';
import { createService, registerPlatformEndpoints } from '@11e/http';
import type { OpenApiDoc, Service } from '@11e/http';
import { drainEvents, drainWork } from '@11e/outbox';
import type { DrainResult } from '@11e/outbox';
import { EXPECTED_MIGRATION, SCHEMA, SERVICE } from './config.js';
import type { AppDeps } from './deps.js';
import { eventHandlers } from './adapters/events.js';
import { jobs } from './adapters/jobs.js';
import { registerRoutes } from './adapters/routes.js';
import { workHandlers } from './adapters/work.js';

export type { AppDeps } from './deps.js';

const EVENT_QUEUE = 'q_journeys';
const WORK_QUEUES: readonly string[] = ['q_journeys_work'];

export function buildApp(deps: AppDeps): Service<operations> {
  const { db, obs } = deps;
  const svc = createService<operations>({
    service: SERVICE,
    spec: spec as unknown as OpenApiDoc,
    ready: async () => {
      const r = await checkDbReady(db, EXPECTED_MIGRATION);
      return { ok: r.ok, checks: { db: r.ok ? 'ok' : (r.reason ?? 'down') } };
    },
    middleware: [obs.middleware],
    operationMiddleware: [deps.auth],
    onRequestEnd: obs.onRequestEnd,
    onError: obs.onError,
  });

  const queue = { db, schema: SCHEMA };
  const handlers = eventHandlers(deps);
  const work = workHandlers(deps);
  const drains: Record<string, () => Promise<DrainResult>> = {
    [EVENT_QUEUE]: () =>
      drainEvents(queue, {
        queue: EVENT_QUEUE,
        consumer: SERVICE,
        handlers,
        onError: obs.drainHooks.onError,
      }),
  };
  for (const q of WORK_QUEUES) {
    const handler = work[q];
    // Snapshots and PDFs call records/listings/storage: a few items per call, a longer visibility timeout.
    if (handler)
      drains[q] = () =>
        drainWork(queue, { queue: q, handler, batchSize: 5, visibilityTimeoutSec: 120, onError: obs.drainHooks.onError });
  }
  registerPlatformEndpoints(svc, {
    responseStyle: 'batch',
    queue,
    routes: topology.routes,
    drains,
    jobs: jobs(deps),
    onRelay: (r) => obs.onRelay(r),
    onDrain: obs.drainHooks.onResult,
  });
  registerRoutes(svc, deps);
  return svc;
}
