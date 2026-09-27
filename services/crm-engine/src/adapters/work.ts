// Private work queue q_crm_engine_rescore (LLD §4.5): dirty subjects (deduped by rescore_pending) and job
// continuations. Each subject is re-scored in its own transaction; the claim of the dedupe row commits with it.
import type { WorkHandler } from '@11e/outbox';
import { processDirtySubject } from '../application/pipeline.js';
import type { AppDeps } from '../deps.js';
import type { CrmEngineDb } from './db.js';
import { pgUnitOfWork } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RescoreMessage =
  | {
      kind: 'subject';
      tenantId: string;
      subjectType: 'offer' | 'demand';
      subjectId: string;
      correlationId?: string;
    }
  | { kind: 'job'; job: string; tenantId: string | null; correlationId?: string };

export function parseRescoreMessage(payload: unknown): RescoreMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const m = payload as Record<string, unknown>;
  if (
    m['kind'] === 'subject' &&
    typeof m['tenantId'] === 'string' &&
    UUID.test(m['tenantId']) &&
    (m['subjectType'] === 'offer' || m['subjectType'] === 'demand') &&
    typeof m['subjectId'] === 'string' &&
    UUID.test(m['subjectId'])
  )
    return m as RescoreMessage;
  if (m['kind'] === 'job' && typeof m['job'] === 'string') return m as RescoreMessage;
  return null;
}

/** Statement budget for one subject re-score (a candidate set of ≤ 5,000 rows plus bounded upserts). */
export const RESCORE_STATEMENT_TIMEOUT_MS = 30_000;

export function workHandlers(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  jobContinuation: (job: string, tenantId: string | null) => Promise<void> = async () => undefined,
): Record<string, WorkHandler<CrmEngineDb>> {
  const uow = pgUnitOfWork(deps.db, () => deps.clock.now());
  return {
    q_crm_engine_rescore: async (payload) => {
      const msg = parseRescoreMessage(payload);
      if (!msg) return; // malformed: dropped (nothing to retry)
      if (msg.kind === 'job') return jobContinuation(msg.job, msg.tenantId);
      await uow.run(
        msg.correlationId ?? `rescore-${msg.subjectId}`,
        (store) => processDirtySubject(store, deps.clock, msg.tenantId, msg.subjectType, msg.subjectId),
        { statementTimeoutMs: RESCORE_STATEMENT_TIMEOUT_MS },
      );
    },
  };
}
