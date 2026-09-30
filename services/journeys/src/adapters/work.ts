// Private work queue q_journeys_work: proposal snapshots and PDFs, and imported-note fetches from intake (CR-012), off
// the request path and the drain transaction (CLAUDE.md §3.5). Each handler dedupes on its own state (proposal Preparing /
// pdf queued; one note per upload row), so a redelivered message is a no-op.
import type { WorkHandler } from '@11e/outbox';
import { importNote } from '../application/notes.js';
import type { ImportNoteMessage, WorkMessage } from '../application/ports.js';
import { buildSnapshot, renderPdf } from '../application/proposals.js';
import type { AppDeps } from '../deps.js';
import type { JourneysDb } from './db.js';
import { createTxRunner } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBJECT_TYPES = new Set(['offer', 'demand', 'person', 'property']);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

function parse(payload: unknown): WorkMessage | null {
  const m = payload as Record<string, unknown> | null;
  if (!m || !isUuid(m['tenantId'])) return null;
  const correlationId = typeof m['correlationId'] === 'string' ? m['correlationId'] : 'work';
  if (m['kind'] === 'build_snapshot' || m['kind'] === 'render_pdf') {
    if (!isUuid(m['proposalId'])) return null;
    return { kind: m['kind'], tenantId: m['tenantId'], proposalId: m['proposalId'], correlationId };
  }
  if (m['kind'] === 'import_note') {
    const rowNo = m['rowNo'];
    const subjectType = m['subjectType'];
    if (!isUuid(m['subjectId']) || !isUuid(m['uploadId']) || typeof rowNo !== 'number' || !Number.isInteger(rowNo) || rowNo < 1) return null;
    if (typeof subjectType !== 'string' || !SUBJECT_TYPES.has(subjectType)) return null;
    return {
      kind: 'import_note',
      tenantId: m['tenantId'],
      correlationId,
      subjectType: subjectType as ImportNoteMessage['subjectType'],
      subjectId: m['subjectId'],
      uploadId: m['uploadId'],
      rowNo,
      uploadCode: typeof m['uploadCode'] === 'string' ? m['uploadCode'] : null,
    };
  }
  return null;
}

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<JourneysDb>> {
  const runner = createTxRunner(deps.db, () => deps.clock.now());
  const work = { runner, integrations: deps.integrations };
  return {
    q_journeys_work: async (payload, ctx) => {
      const msg = parse(payload);
      if (!msg) return; // malformed items are dropped (nothing to retry)
      if (msg.kind === 'import_note') await importNote({ runner, uploadNotes: deps.integrations.uploadNotes }, msg, ctx.attempt);
      else if (msg.kind === 'build_snapshot') await buildSnapshot(work, msg, ctx.attempt);
      else await renderPdf(work, msg, ctx.attempt);
    },
  };
}
