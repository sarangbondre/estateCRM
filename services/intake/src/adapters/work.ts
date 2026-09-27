// Private work queues: q_intake_inspect, q_intake_split, q_intake_chunks, q_intake_finalize (ADR-0005).
// Each handler dedupes on its own work key (the upload status / chunk lease), so a redelivered message is harmless.
import type { WorkHandler } from '@11e/outbox';
import { runInspection } from '../application/inspection.js';
import type { InspectMessage } from '../application/inspection.js';
import type { AppDeps } from '../deps.js';
import type { IntakeDb } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the common message shape; a malformed message throws and ends in the DLQ after 5 reads. */
export function uploadMessage(payload: unknown): InspectMessage {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p['tenantId'] !== 'string' || !UUID.test(p['tenantId']))
    throw new Error('bad work message: tenantId');
  if (typeof p['uploadId'] !== 'string' || !UUID.test(p['uploadId']))
    throw new Error('bad work message: uploadId');
  return {
    tenantId: p['tenantId'],
    uploadId: p['uploadId'],
    correlationId: typeof p['correlationId'] === 'string' ? p['correlationId'] : p['uploadId'],
  };
}

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<IntakeDb>> {
  const { app } = deps;
  return {
    q_intake_inspect: (payload) => runInspection(app, app.sheets, uploadMessage(payload)),
  };
}
