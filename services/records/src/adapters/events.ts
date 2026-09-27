// Event consumers for q_records (contracts/asyncapi/events.yaml x-consumers: records). Handlers run inside the
// drain transaction together with processed_events dedupe (libs/outbox); stale journeys/listings events are dropped
// by version (inbound_versions / exit_version / publication_version). Unknown event types are dead-lettered.
import type { EventHandlers } from '@11e/outbox';
import { systemActor } from '../application/context.js';
import { ingestBatch } from '../application/ingest.js';
import {
  onCallLogged,
  onDealCancelled,
  onDealClosed,
  onDemandExited,
  onDemandReactivated,
  onLeaseRenewalDue,
  onOfferConfirmed,
  onOfferRetired,
  onPublicationChanged,
  onReviewResolved,
  onSiteVisitCompleted,
} from '../application/reactions.js';
import type { AppDeps } from '../deps.js';
import { bindTx } from './db/uow.js';
import type { RecordsDb } from './db/schema.js';

export function eventHandlers(deps: AppDeps): EventHandlers<RecordsDb> {
  const { app } = deps;
  const txOf = (trx: Parameters<typeof bindTx>[0], e: { tenantId: string; correlationId: string }) =>
    bindTx(trx, systemActor(e.tenantId, e.correlationId));
  const inbound = (e: { aggregateId: string; aggregateVersion: number }) => ({ aggregateId: e.aggregateId, aggregateVersion: e.aggregateVersion });
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
    'review_item.resolved.v1': (e, { trx }) => onReviewResolved(app, txOf(trx, e), e.data, inbound(e)),
    'offer.confirmed.v1': (e, { trx }) => onOfferConfirmed(txOf(trx, e), e.data),
    'site_visit.completed.v1': (e, { trx }) => onSiteVisitCompleted(txOf(trx, e), e.data),
    'call.logged.v1': (e, { trx }) => onCallLogged(txOf(trx, e), e.data),
    'demand.exited.v1': (e, { trx }) => onDemandExited(app, txOf(trx, e), e.data, inbound(e)),
    'demand.reactivated.v1': (e, { trx }) => onDemandReactivated(txOf(trx, e), e.data, inbound(e)),
    'deal.closed.v1': (e, { trx }) => onDealClosed(app, txOf(trx, e), e.data),
    'deal.cancelled.v1': (e, { trx }) => onDealCancelled(txOf(trx, e), e.data),
    'offer.retired.v1': (e, { trx }) => onOfferRetired(app, txOf(trx, e), e.data),
    'lease_renewal.due.v1': (e, { trx }) => onLeaseRenewalDue(app, txOf(trx, e), e.data),
    'publication.changed.v1': (e, { trx }) => onPublicationChanged(txOf(trx, e), e.data, inbound(e)),
  };
}
