// Private work queue q_journeys_work: proposal snapshots and PDFs, off the request path (CLAUDE.md §3.5). Each
// handler dedupes on the proposal's own state (Preparing / pdf queued), so a redelivered message is a no-op.
import type { WorkHandler } from '@11e/outbox';
import type { WorkMessage } from '../application/ports.js';
import { buildSnapshot, renderPdf } from '../application/proposals.js';
import type { AppDeps } from '../deps.js';
import type { JourneysDb } from './db.js';
import { createTxRunner } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(payload: unknown): WorkMessage | null {
  const m = payload as Partial<WorkMessage> | null;
  if (!m || (m.kind !== 'build_snapshot' && m.kind !== 'render_pdf')) return null;
  if (typeof m.tenantId !== 'string' || !UUID.test(m.tenantId) || typeof m.proposalId !== 'string' || !UUID.test(m.proposalId)) return null;
  return { kind: m.kind, tenantId: m.tenantId, proposalId: m.proposalId, correlationId: typeof m.correlationId === 'string' ? m.correlationId : 'work' };
}

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<JourneysDb>> {
  const runner = createTxRunner(deps.db, () => deps.clock.now());
  const work = { runner, integrations: deps.integrations };
  return {
    q_journeys_work: async (payload, ctx) => {
      const msg = parse(payload);
      if (!msg) return; // malformed items are dropped (nothing to retry)
      if (msg.kind === 'build_snapshot') await buildSnapshot(work, msg, ctx.attempt);
      else await renderPdf(work, msg, ctx.attempt);
    },
  };
}
