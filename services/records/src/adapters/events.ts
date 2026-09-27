// Event consumers for q_records (contracts/asyncapi/events.yaml x-consumers: records). Handlers run inside the
// drain transaction together with processed_events dedupe (libs/outbox); stale journeys/listings events are dropped
// by version (inbound_versions / exit_version / publication_version). Unknown event types are dead-lettered.
import type { EventHandlers } from '@11e/outbox';
import { systemActor } from '../application/context.js';
import { ingestBatch } from '../application/ingest.js';
import type { AppDeps } from '../deps.js';
import { bindTx } from './db/uow.js';
import type { RecordsDb } from './db/schema.js';

export function eventHandlers(deps: AppDeps): EventHandlers<RecordsDb> {
  const { app } = deps;
  return {
    'rows.classified.v1': async (event, { trx }) => {
      const actor = systemActor(event.tenantId, event.correlationId);
      const tx = bindTx(trx, actor);
      const { uploadId, batchNo } = event.data;
      await ingestBatch(app, actor, event.data, {
        alreadyApplied: async () => (await tx.store.find('upload_batches', { upload_id: uploadId, batch_no: batchNo }, { limit: 1 })).length > 0,
        markApplied: async (rows) => {
          await tx.store.insertIgnore('upload_batches', {
            id: app.ids.next(),
            upload_id: uploadId,
            batch_no: batchNo,
            status: 'applied',
            rows_applied: rows,
            applied_at: new Date(),
          });
        },
      });
    },
  };
}
