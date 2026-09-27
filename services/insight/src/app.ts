// insight HTTP app: contract-driven routes, auth, observability and the platform endpoints (F-SVC scaffold).
import topology from '@11e/contracts/event-topology.json' with { type: 'json' };
import spec from '@11e/contracts/openapi/insight.json' with { type: 'json' };
import type { operations } from '@11e/contracts/insight';
import { checkDbReady, sql } from '@11e/db';
import { createService, registerPlatformEndpoints } from '@11e/http';
import type { OpenApiDoc, Service } from '@11e/http';
import { drainEvents, drainWork } from '@11e/outbox';
import type { DrainResult } from '@11e/outbox';
import { EXPECTED_MIGRATION, SCHEMA, SERVICE } from './config.js';
import type { AppDeps } from './deps.js';
import { eventHandlers } from './adapters/events.js';
import { jobs } from './adapters/jobs.js';
import { registerRoutes } from './adapters/routes.js';
import { registerChatRoutes } from './adapters/routesChat.js';
import { workHandlers } from './adapters/work.js';
import { wire } from './adapters/wiring.js';

export type { AppDeps } from './deps.js';

const EVENT_QUEUE = 'q_insight';
const WORK_QUEUES: readonly string[] = ['q_insight_exports'];

export function buildApp(deps: AppDeps): Service<operations> {
  const { db, obs } = deps;
  const wired = wire(deps);
  const svc = createService<operations>({
    service: SERVICE,
    spec: spec as unknown as OpenApiDoc,
    ready: async () => {
      const r = await checkDbReady(db, EXPECTED_MIGRATION);
      // The model being unavailable is not "not ready": the keyword fallback answers (LLD §4.2).
      const exhausted = r.ok ? await sql<{ n: number }>`select count(*)::int as n from hf_usage
          where credits_exhausted_until > now() and day >= current_date - 40`.execute(db).then((x) => (x.rows[0]?.n ?? 0) > 0, () => false) : false;
      const model = deps.planner?.model && !exhausted ? 'ok' : 'degraded';
      return { ok: r.ok, checks: { db: r.ok ? 'ok' : (r.reason ?? 'down'), model } };
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
    if (handler) drains[q] = () => drainWork(queue, { queue: q, handler, onError: obs.drainHooks.onError });
  }
  registerPlatformEndpoints(svc, {
    responseStyle: 'compact',
    queue,
    routes: topology.routes,
    drains,
    jobs: jobs(deps, wired),
    onRelay: (r) => obs.onRelay(r),
    onDrain: obs.drainHooks.onResult,
  });
  registerRoutes(svc, deps, wired);
  registerChatRoutes(svc, deps, wired);
  return svc;
}
