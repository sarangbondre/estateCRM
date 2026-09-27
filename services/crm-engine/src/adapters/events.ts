// Event consumers for q_crm_engine (contracts/asyncapi/events.yaml, LLD §5.2). Handlers run inside the drain
// transaction together with processed_events dedupe (libs/outbox); the repositories are bound to that transaction.
import type { EventEnvelope, EventHandlers, EventType } from '@11e/outbox';
import type { Transaction } from '@11e/db';
import { releaseContent, VOCABULARY_RELEASE_ID } from '@11e/vocabulary';
import type { EventMeta } from '../application/projection.js';
import {
  applyDemandConfirmed,
  applyDemandFacts,
  applyDemandStage,
  applyDemandStatus,
  applyDemandVoided,
  applyOfferCommercial,
  applyOfferConfirmed,
  applyOfferFacts,
  applyOfferPriceChanged,
  applyOfferStage,
  applyOfferVoided,
  applyPriceSheet,
  applyReferenceRelease,
} from '../application/projection.js';
import type { Store } from '../application/ports.js';
import type { AppDeps } from '../deps.js';
import type { CrmEngineDb } from './db.js';
import { createStore } from './store.js';

const metaOf = (e: EventEnvelope): EventMeta => ({
  eventId: e.eventId,
  tenantId: e.tenantId,
  aggregateId: e.aggregateId,
  aggregateVersion: e.aggregateVersion,
  occurredAt: e.occurredAt,
  correlationId: e.correlationId,
});

/** The vocabulary body cached for a release (records ships the same content from @11e/vocabulary). */
const vocabularyBody = (version: string) =>
  version === VOCABULARY_RELEASE_ID ? releaseContent() : { version };

export function eventHandlers(deps: Pick<AppDeps, 'clock'>): EventHandlers<CrmEngineDb> {
  const now = () => deps.clock.now();
  const on =
    <T extends EventType>(
      fn: (store: Store, meta: EventMeta, data: EventEnvelope<T>['data']) => Promise<unknown>,
    ) =>
    async (e: EventEnvelope<T>, ctx: { trx: Transaction<CrmEngineDb> }) => {
      await fn(createStore(ctx.trx, { correlationId: e.correlationId, now }), metaOf(e), e.data);
    };
  const ignore = async () => undefined;

  return {
    // records → projection facts
    'offer.created.v1': on<'offer.created.v1'>(applyOfferFacts),
    'offer.updated.v1': on<'offer.updated.v1'>(applyOfferFacts),
    'offer.price_changed.v1': on<'offer.price_changed.v1'>(applyOfferPriceChanged),
    'price_sheet.applied.v1': on<'price_sheet.applied.v1'>(applyPriceSheet),
    'offer.voided.v1': on<'offer.voided.v1'>(applyOfferVoided),
    'demand.created.v1': on<'demand.created.v1'>(applyDemandFacts),
    'demand.updated.v1': on<'demand.updated.v1'>(applyDemandFacts),
    'demand.voided.v1': on<'demand.voided.v1'>(applyDemandVoided),
    'vocabulary.released.v1': on<'vocabulary.released.v1'>((s, m, d) =>
      applyReferenceRelease(s, m, { vocabulary: d }, vocabularyBody),
    ),
    'micromarkets.updated.v1': on<'micromarkets.updated.v1'>((s, m, d) =>
      applyReferenceRelease(s, m, { micromarkets: d }, vocabularyBody),
    ),
    // journeys → life curve, commercial and status axes
    'lifecycle.stage_changed.v1': on<'lifecycle.stage_changed.v1'>((s, m, d) =>
      d.subjectType === 'offer'
        ? applyOfferStage(s, m, d.subjectId, d.to)
        : applyDemandStage(s, m, d.subjectId, d.to),
    ),
    'offer.confirmed.v1': on<'offer.confirmed.v1'>(applyOfferConfirmed),
    'offer.commercial_status_changed.v1': on<'offer.commercial_status_changed.v1'>((s, m, d) =>
      applyOfferCommercial(s, m, d.offerId, d.to, 'offer.commercial_status_changed'),
    ),
    'offer.retired.v1': on<'offer.retired.v1'>((s, m, d) =>
      applyOfferCommercial(s, m, d.offerId, 'Inactive', 'offer.retired'),
    ),
    'demand.confirmed.v1': on<'demand.confirmed.v1'>(applyDemandConfirmed),
    'demand.status_changed.v1': on<'demand.status_changed.v1'>((s, m, d) =>
      applyDemandStatus(s, m, d.demandId, { commercialStatus: d.to }, 'demand.status_changed'),
    ),
    'demand.exited.v1': on<'demand.exited.v1'>((s, m, d) =>
      applyDemandStatus(s, m, d.demandId, { exitType: d.exit }, 'demand.exited'),
    ),
    'demand.reactivated.v1': on<'demand.reactivated.v1'>((s, m, d) =>
      applyDemandStatus(s, m, d.demandId, { exitType: null }, 'demand.reactivated'),
    ),
    // handled by the matching pipeline (ENG-04 / ENG-06)
    'demand.qualified.v1': ignore,
    'records.merged.v1': ignore,
    'records.merge_undone.v1': ignore,
    'proposal.sent.v1': ignore,
    'site_visit.completed.v1': ignore,
    'deal.opened.v1': ignore,
    'deal.closed.v1': ignore,
    'deal.cancelled.v1': ignore,
    'proposal.feedback_recorded.v1': ignore,
  };
}
