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
import { onProposalFeedback } from '../application/feedback.js';
import { resetMicromarketRefresh } from '../application/jobs.js';
import type { Store } from '../application/ports.js';
import {
  onDealCancelled,
  onDealClosed,
  onDealOpened,
  onDemandChange,
  onDemandQualified,
  onDemandVoided,
  onMergeUndone,
  onOfferCommercialChange,
  onOfferLifeChange,
  onOfferVoided,
  onProposalSent,
  onRecordsMerged,
  onSiteVisit,
} from '../application/propagation.js';
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

  const at = (e: EventEnvelope) => new Date(e.occurredAt);
  const onEnv =
    <T extends EventType>(fn: (store: Store, meta: EventMeta, e: EventEnvelope<T>) => Promise<unknown>) =>
    async (e: EventEnvelope<T>, ctx: { trx: Transaction<CrmEngineDb> }) => {
      await fn(createStore(ctx.trx, { correlationId: e.correlationId, now }), metaOf(e), e);
    };

  return {
    // records → projection facts
    'offer.created.v1': on<'offer.created.v1'>(applyOfferFacts),
    'offer.updated.v1': on<'offer.updated.v1'>(applyOfferFacts),
    'offer.price_changed.v1': on<'offer.price_changed.v1'>(applyOfferPriceChanged),
    'price_sheet.applied.v1': on<'price_sheet.applied.v1'>(applyPriceSheet),
    'offer.voided.v1': on<'offer.voided.v1'>(async (s, m, d) =>
      onOfferVoided(s, await applyOfferVoided(s, m, d)),
    ),
    'demand.created.v1': on<'demand.created.v1'>(applyDemandFacts),
    'demand.updated.v1': on<'demand.updated.v1'>(applyDemandFacts),
    'demand.voided.v1': on<'demand.voided.v1'>(async (s, m, d) =>
      onDemandVoided(s, await applyDemandVoided(s, m, d)),
    ),
    'vocabulary.released.v1': on<'vocabulary.released.v1'>(async (s, m, d) => {
      await resetMicromarketRefresh(s, deps.clock, m.tenantId);
      await applyReferenceRelease(s, m, { vocabulary: d }, vocabularyBody);
    }),
    'micromarkets.updated.v1': on<'micromarkets.updated.v1'>(async (s, m, d) => {
      await resetMicromarketRefresh(s, deps.clock, m.tenantId);
      await applyReferenceRelease(s, m, { micromarkets: d }, vocabularyBody);
    }),
    'records.merged.v1': on<'records.merged.v1'>((s, m, d) => onRecordsMerged(s, m.tenantId, d)),
    'records.merge_undone.v1': on<'records.merge_undone.v1'>((s, m, d) => onMergeUndone(s, m.tenantId, d)),
    // journeys → life curve, commercial and status axes (direct effects on matches, LLD §4.6)
    'lifecycle.stage_changed.v1': on<'lifecycle.stage_changed.v1'>(async (s, m, d) =>
      d.subjectType === 'offer'
        ? onOfferLifeChange(s, await applyOfferStage(s, m, d.subjectId, d.to))
        : onDemandChange(s, await applyDemandStage(s, m, d.subjectId, d.to)),
    ),
    'offer.confirmed.v1': on<'offer.confirmed.v1'>(async (s, m, d) =>
      onOfferLifeChange(s, await applyOfferConfirmed(s, m, d)),
    ),
    'offer.commercial_status_changed.v1': on<'offer.commercial_status_changed.v1'>(async (s, m, d) =>
      onOfferCommercialChange(
        s,
        await applyOfferCommercial(s, m, d.offerId, d.to, 'offer.commercial_status_changed'),
      ),
    ),
    'offer.retired.v1': on<'offer.retired.v1'>(async (s, m, d) =>
      onOfferCommercialChange(s, await applyOfferCommercial(s, m, d.offerId, 'Inactive', 'offer.retired')),
    ),
    'demand.confirmed.v1': on<'demand.confirmed.v1'>(applyDemandConfirmed),
    'demand.qualified.v1': on<'demand.qualified.v1'>((s, m, d) =>
      onDemandQualified(s, deps.clock, m, d.demandId),
    ),
    'demand.status_changed.v1': on<'demand.status_changed.v1'>(async (s, m, d) =>
      onDemandChange(
        s,
        await applyDemandStatus(s, m, d.demandId, { commercialStatus: d.to }, 'demand.status_changed'),
      ),
    ),
    'demand.exited.v1': on<'demand.exited.v1'>(async (s, m, d) =>
      onDemandChange(s, await applyDemandStatus(s, m, d.demandId, { exitType: d.exit }, 'demand.exited')),
    ),
    'demand.reactivated.v1': on<'demand.reactivated.v1'>((s, m, d) =>
      applyDemandStatus(s, m, d.demandId, { exitType: null }, 'demand.reactivated'),
    ),
    // journeys → engagement and deals
    'proposal.sent.v1': onEnv<'proposal.sent.v1'>((s, m, e) =>
      onProposalSent(s, m.tenantId, e.data.matchIds, at(e)),
    ),
    'site_visit.completed.v1': onEnv<'site_visit.completed.v1'>((s, m, e) =>
      onSiteVisit(s, m.tenantId, e.data.demandId, e.data.offerIds, at(e)),
    ),
    'deal.opened.v1': on<'deal.opened.v1'>((s, m, d) => onDealOpened(s, m.tenantId, d)),
    'deal.closed.v1': on<'deal.closed.v1'>((s, m, d) => onDealClosed(s, m.tenantId, d)),
    'deal.cancelled.v1': on<'deal.cancelled.v1'>((s, m, d) => onDealCancelled(s, m.tenantId, d)),
    // M6 feedback for weight tuning
    'proposal.feedback_recorded.v1': onEnv<'proposal.feedback_recorded.v1'>((s, m, e) =>
      onProposalFeedback(s, m.tenantId, e.data, at(e)),
    ),
  };
}
