// ApplyEvent (LLD §4.10): one handler per subscribed event (the 64 insight routes of event-topology.json). Each runs in
// the drain transaction with the processed_events dedupe. Ordering: an event whose aggregateVersion is ≤ the version
// already applied for its stream is ignored (still counted as processed). Additive events (counts, touches, calls,
// row statistics) have no stream: eventId dedupe is enough and out-of-order delivery doesn't matter for sums.
// Events for an unknown aggregate create a stub row (id only) that later events fill.
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { istDay } from '../domain/dates.js';
import { stableUuid } from '../domain/ids.js';
import { blankDemand, blankOffer } from '../domain/readmodel/defaults.js';
import {
  DEAL_STATUS,
  MATCH_STATUS,
  VERIFIED_STAGES,
  demandFacts,
  offerFacts,
  offerPrices,
  rowStatKey,
} from '../domain/readmodel/mapping.js';
import { demandDims, factDims, offerDims, rollupMoves } from '../domain/readmodel/rollupKeys.js';
import type { FactDims } from '../domain/readmodel/rollupKeys.js';
import type { DemandRow, OfferRow } from '../domain/readmodel/rows.js';
import type { ReadModelStore } from './ports.js';

export interface Incoming<T extends EventType = EventType> {
  eventId: string;
  eventType: T;
  occurredAt: string;
  producer: string;
  aggregateId: string;
  aggregateVersion: number;
  data: EventDataMap[T];
}

export type Handler<T extends EventType> = (s: ReadModelStore, e: Incoming<T>) => Promise<void>;
type HandlerMap = { [T in EventType]?: Handler<T> };

// ---------------------------------------------------------------------------------------------------- helpers

/** Streams that are snapshots of the same columns share one version counter (per aggregate). */
const STREAM: Partial<Record<EventType, string>> = {
  'offer.created.v1': 'offer.facts',
  'offer.updated.v1': 'offer.facts',
  'offer.price_changed.v1': 'offer.facts',
  'offer.record_stage_changed.v1': 'offer.facts',
  'offer.voided.v1': 'offer.facts',
  'demand.created.v1': 'demand.facts',
  'demand.updated.v1': 'demand.facts',
  'demand.voided.v1': 'demand.facts',
  'project.created.v1': 'project.facts',
  'project.updated.v1': 'project.facts',
  'match.suggested.v1': 'match.status',
  'match.confirmed.v1': 'match.status',
  'match.rejected.v1': 'match.status',
  'match.closed.v1': 'match.status',
  'match.reopened.v1': 'match.status',
  'desk_item.updated.v1': 'desk_item.state',
  'sourcing_request.updated.v1': 'sourcing_request.state',
  'deal.updated.v1': 'deal.progress',
  'lifecycle.stage_changed.v1': 'lifecycle',
  'offer.commercial_status_changed.v1': 'offer.commercial',
  'demand.status_changed.v1': 'demand.status',
  'publication.changed.v1': 'publication',
  'queue.counts_changed.v1': 'queue.counts',
  'user.changed.v1': 'user',
};

/** True when the event is newer than what its stream has applied (and records it); false = stale, skip. */
async function fresh(s: ReadModelStore, e: Incoming, key = e.aggregateId): Promise<boolean> {
  const stream = STREAM[e.eventType] ?? e.eventType;
  const applied = await s.version(key, stream);
  if (applied !== null && e.aggregateVersion <= applied) return false;
  await s.setVersion(key, stream, e.aggregateVersion);
  return true;
}

const day = (e: Incoming) => istDay(new Date(e.occurredAt));

async function fact(s: ReadModelStore, e: Incoming, metric: string, dims: Partial<FactDims>, delta = 1) {
  await s.fact(day(e), metric, factDims(dims), delta);
}

/** Upserts an offer and moves its rollup tuple. Returns the row after the change. */
export async function saveOffer(s: ReadModelStore, id: string, patch: Partial<OfferRow>): Promise<OfferRow> {
  const before = await s.get('rm_offer', id);
  const after: OfferRow = { ...(before ?? blankOffer(id)), ...patch, id };
  await s.upsert('rm_offer', id, patch);
  for (const m of rollupMoves(offerDims(before), offerDims(after))) await s.offerRollup(m.dims, m.delta);
  return after;
}

export async function saveDemand(s: ReadModelStore, id: string, patch: Partial<DemandRow>): Promise<DemandRow> {
  const before = await s.get('rm_demand', id);
  const after: DemandRow = { ...(before ?? blankDemand(id)), ...patch, id };
  await s.upsert('rm_demand', id, patch);
  for (const m of rollupMoves(demandDims(before), demandDims(after))) await s.demandRollup(m.dims, m.delta);
  return after;
}

async function bumpOffers(s: ReadModelStore, ids: readonly string[], column: 'match_suggested_count' | 'match_confirmed_count') {
  for (const id of ids) {
    const row = await s.get('rm_offer', id);
    await saveOffer(s, id, { [column]: (row?.[column] ?? 0) + 1 });
  }
}

const offerFactDims = (o: OfferRow): Partial<FactDims> => ({
  segment: o.segment,
  deal_type: o.deal_type,
  market: o.market,
  source_type: o.source_type,
  owner_user_id: o.owner_user_id,
  micromarket: o.micromarket,
});
const demandFactDims = (d: DemandRow): Partial<FactDims> => ({
  segment: d.segment,
  deal_type: d.deal_type_primary,
  market: d.market,
  source_type: d.source_type,
  owner_user_id: d.owner_user_id,
  micromarket: d.micromarkets[0] ?? null,
});

// ---------------------------------------------------------------------------------------------------- handlers

export const handlers: HandlerMap = {
  // ---------------------------------------------------------------- intake
  'upload.started.v1': async (s, e) => {
    const d = e.data;
    const existing = await s.get('rm_upload', d.uploadId);
    await s.upsert('rm_upload', d.uploadId, {
      code: d.code,
      mode: d.mode,
      source_type: d.sourceType ?? null,
      source_detail: d.sourceDetail ?? null,
      row_count: d.rowCount,
      anonymised: d.anonymised ?? false,
      uploaded_by: d.uploadedBy,
      started_at: e.occurredAt,
      ...(existing ? {} : { status: 'running' }),
    });
  },
  'rows.classified.v1': async (s, e) => {
    const d = e.data;
    const buckets = new Map<string, { scope: string | null; side: string | null; reason: string | null; review: boolean; source: string | null; repeat: boolean; count: number }>();
    for (const r of d.rows) {
      const b = {
        scope: r.recordScope ?? null,
        side: r.side ?? null,
        reason: r.reviewReasonCode ?? null,
        review: r.needsReview ?? false,
        source: r.sourceName ?? null,
        repeat: !!r.possibleRepeatOf,
      };
      const key = rowStatKey([d.uploadId, b.scope, b.side, b.reason, b.review, b.source, b.repeat]);
      const cur = buckets.get(key);
      if (cur) cur.count++;
      else buckets.set(key, { ...b, count: 1 });
    }
    for (const [key, b] of buckets) {
      const id = stableUuid(key);
      const row = await s.get('rm_row_stat', id);
      await s.upsert('rm_row_stat', id, {
        upload_id: d.uploadId,
        record_scope: b.scope,
        side: b.side,
        review_reason_code: b.reason,
        needs_review: b.review,
        source_name: b.source,
        possible_repeat: b.repeat,
        count: (row?.count ?? 0) + b.count,
      });
    }
  },
  'upload.completed.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_upload', d.uploadId, {
      code: d.code,
      source_type: d.sourceType ?? null,
      source_detail: d.sourceDetail ?? null,
      uploaded_by: d.uploadedBy,
      row_count: d.counts.read,
      accepted: d.counts.accepted,
      rejected: d.counts.rejected,
      needs_review: d.counts.needsReview,
      unchanged: d.counts.unchanged ?? null,
      rejection_reasons: d.rejectionReasons ?? {},
      status: 'completed',
      finished_at: e.occurredAt,
    });
    await fact(s, e, 'upload_rows_accepted', { source_type: d.sourceType ?? null }, d.counts.accepted);
    await fact(s, e, 'upload_rows_rejected', { source_type: d.sourceType ?? null }, d.counts.rejected);
  },
  'upload.failed.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_upload', d.uploadId, {
      code: d.code,
      uploaded_by: d.uploadedBy,
      status: 'failed',
      fail_reason: d.reason,
      finished_at: e.occurredAt,
    });
  },
  'review_item.created.v1': async (s, e) => {
    const d = e.data;
    const existing = await s.get('rm_review_item', d.reviewItemId);
    await s.upsert('rm_review_item', d.reviewItemId, {
      upload_id: d.uploadId,
      reason_code: d.reasonCode,
      detail_code: d.detailCode ?? null,
      ...(existing ? {} : { status: 'open' }),
    });
  },
  'review_item.resolved.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_review_item', d.reviewItemId, {
      upload_id: d.uploadId,
      status: 'resolved',
      action: d.action,
      resolved_by: d.resolvedBy ?? null,
      resolved_at: e.occurredAt,
    });
  },

  // ---------------------------------------------------------------- records: offers and demands
  'offer.created.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const before = await s.get('rm_offer', e.data.offerId);
    const after = await saveOffer(s, e.data.offerId, {
      ...offerFacts(e.data),
      ...(before?.created_at_src ? {} : { created_at_src: e.occurredAt }),
      ...(before?.commercial_status ? {} : { commercial_status: 'Available' }),
      ...(before?.publication_level ? {} : { publication_level: 'Private' }),
    });
    if (!before?.code) await fact(s, e, 'offer_created', offerFactDims(after));
  },
  'offer.updated.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const before = await s.get('rm_offer', e.data.offerId);
    await saveOffer(s, e.data.offerId, {
      ...offerFacts(e.data),
      ...(before?.created_at_src ? {} : { created_at_src: e.occurredAt }),
    });
  },
  'offer.price_changed.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await saveOffer(s, e.data.offerId, offerPrices(e.data.current));
  },
  'offer.record_stage_changed.v1': async (s, e) => {
    const d = e.data;
    const before = await s.get('rm_offer', d.offerId);
    const firstVerification = VERIFIED_STAGES.includes(d.to) && !before?.verified_at;
    const patch: Partial<OfferRow> = firstVerification
      ? { verified_at: e.occurredAt, verified_by: d.changedBy ?? null }
      : {};
    // Verification is monotonic ("the first time"): recorded even when a newer facts snapshot was applied already.
    if (await fresh(s, e)) {
      patch.record_stage = d.to;
      if (d.hasRealPhotos !== undefined) patch.has_real_photos = d.hasRealPhotos;
    }
    if (!Object.keys(patch).length) return;
    const after = await saveOffer(s, d.offerId, patch);
    if (firstVerification)
      await fact(s, e, 'offer_verified', { ...offerFactDims(after), owner_user_id: d.changedBy ?? null });
  },
  'offer.voided.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await saveOffer(s, e.data.offerId, { void_reason: e.data.reason });
  },
  'demand.created.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const before = await s.get('rm_demand', e.data.demandId);
    const after = await saveDemand(s, e.data.demandId, {
      ...demandFacts(e.data),
      ...(before?.created_at_src ? {} : { created_at_src: e.occurredAt }),
      // First touch gets the credit (C7): the source type is set once.
      ...(before?.source_type ? {} : { source_type: e.data.sourceType ?? null }),
      ...(before?.commercial_status ? {} : { commercial_status: 'New' }),
    });
    if (!before?.code) await fact(s, e, 'demand_created', demandFactDims(after));
  },
  'demand.updated.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const before = await s.get('rm_demand', e.data.demandId);
    await saveDemand(s, e.data.demandId, {
      ...demandFacts(e.data),
      ...(before?.created_at_src ? {} : { created_at_src: e.occurredAt }),
      ...(before?.source_type ? {} : { source_type: e.data.sourceType ?? null }),
    });
  },
  'demand.touch_added.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_touch', d.touchId, {
      demand_id: d.demandId,
      source_type: d.sourceType,
      capture_mode: d.captureMode ?? null,
      is_first_touch: d.isFirstTouch,
      occurred_at: e.occurredAt,
    });
    const before = await s.get('rm_demand', d.demandId);
    await saveDemand(s, d.demandId, {
      touch_count: (before?.touch_count ?? 0) + 1,
      ...(d.isFirstTouch && !before?.source_type ? { source_type: d.sourceType } : {}),
    });
  },
  'enquiry.received.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_enquiry', d.enquiryId, {
      code: d.code,
      offer_id: d.offerId ?? null,
      project_id: d.projectId ?? null,
      demand_id: d.demandId ?? null,
      campaign_ref: d.campaignRef ?? null,
      received_at: d.receivedAt ?? e.occurredAt,
    });
    if (d.offerId) {
      const o = await s.get('rm_offer', d.offerId);
      await saveOffer(s, d.offerId, { enquiry_count: (o?.enquiry_count ?? 0) + 1 });
    }
  },
  'demand.voided.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await saveDemand(s, e.data.demandId, { void_reason: e.data.reason });
  },

  // ---------------------------------------------------------------- records: merges and people
  'records.merged.v1': async (s, e) => {
    const d = e.data;
    if (d.aggregateType === 'offer') {
      for (const id of d.mergedIds) await saveOffer(s, id, { merged_into_id: d.survivorId });
    } else if (d.aggregateType === 'demand') {
      for (const id of d.mergedIds) await saveDemand(s, id, { merged_into_id: d.survivorId });
    }
    await fact(s, e, 'records_merged', { reason: d.aggregateType }, d.mergedIds.length);
  },
  'records.merge_undone.v1': async (s, e) => {
    const d = e.data;
    if (d.aggregateType === 'offer') {
      for (const id of d.restoredIds) await saveOffer(s, id, { merged_into_id: null });
    } else if (d.aggregateType === 'demand') {
      for (const id of d.restoredIds) await saveDemand(s, id, { merged_into_id: null });
    }
  },
  'person.flagged.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_person_flag', stableUuid(`${d.personId}|${d.flag}`), {
      person_id: d.personId,
      flag: d.flag,
      active: true,
      occurred_at: e.occurredAt,
    });
  },
  'person.flag_removed.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_person_flag', stableUuid(`${d.personId}|${d.flag}`), {
      person_id: d.personId,
      flag: d.flag,
      active: false,
      occurred_at: e.occurredAt,
    });
  },

  // ---------------------------------------------------------------- records: reference data
  'watchlist_item.created.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_watchlist_item', d.watchlistItemId, {
      code: d.code,
      signal_type: d.signalType,
      deadline_date: d.deadlineDate ?? null,
    });
    await fact(s, e, 'watchlist_created', { reason: d.signalType });
  },
  'vocabulary.released.v1': async (s) => {
    await s.requestReferenceRefresh('vocabulary');
  },
  'micromarkets.updated.v1': async (s) => {
    await s.requestReferenceRefresh('micromarkets');
  },

  // ---------------------------------------------------------------- records: photos and projects
  'photo.added.v1': async (s, e) => {
    for (const id of await s.offerIdsOfProperty(e.data.propertyId)) {
      const o = await s.get('rm_offer', id);
      await saveOffer(s, id, {
        photo_count: (o?.photo_count ?? 0) + 1,
        ...(e.data.isReal ? { has_real_photos: true } : {}),
      });
    }
  },
  'photo.removed.v1': async (s, e) => {
    for (const id of await s.offerIdsOfProperty(e.data.propertyId)) {
      const o = await s.get('rm_offer', id);
      await saveOffer(s, id, { photo_count: Math.max(0, (o?.photo_count ?? 0) - 1) });
    }
  },
  'project.created.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const d = e.data;
    await s.upsert('rm_project', d.projectId, {
      code: d.code,
      name: d.name,
      rera_number: d.reraNumber ?? null,
      locality: d.locality ?? null,
      micromarket: d.micromarket ?? null,
      city: d.city ?? null,
      possession_date: d.possessionDate ?? null,
      offer_ids: d.offerIds ?? [],
    });
  },
  'project.updated.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const d = e.data;
    await s.upsert('rm_project', d.projectId, {
      code: d.code,
      name: d.name,
      rera_number: d.reraNumber ?? null,
      locality: d.locality ?? null,
      micromarket: d.micromarket ?? null,
      city: d.city ?? null,
      possession_date: d.possessionDate ?? null,
      offer_ids: d.offerIds ?? [],
    });
  },
  'price_sheet.applied.v1': async (s, e) => {
    const p = await s.get('rm_project', e.data.projectId);
    if (p?.latest_sheet_date && p.latest_sheet_date >= e.data.sheetDate) return;
    await s.upsert('rm_project', e.data.projectId, { latest_sheet_date: e.data.sheetDate });
  },

  // ---------------------------------------------------------------- records: desks, review, market data
  'desk_item.created.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_desk_item', d.deskItemId, {
      code: d.code,
      record_scope: d.recordScope,
      deal_types: d.dealTypes ?? [],
      side: d.side ?? null,
      sector: d.sector ?? null,
      participant_role: d.participantRole ?? null,
      linked_property_id: d.linkedPropertyId ?? null,
    });
  },
  'desk_item.updated.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await s.upsert('rm_desk_item', e.data.deskItemId, {
      status: e.data.status,
      assignee_user_id: e.data.assigneeUserId ?? null,
    });
  },
  'merge_candidate.raised.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_merge_candidate', d.candidateId, {
      kind: d.kind,
      aggregate_type: d.aggregateType ?? null,
      raised_at: e.occurredAt,
    });
  },
  'market_data.recorded.v1': async (s, e) => {
    const d = e.data;
    // Our own closes come from deal.closed.v1 (source closed_by_us); counting them twice would skew the stats.
    if (d.kind === 'closed_by_us') return;
    const lease = d.dealType === 'Lease';
    await s.upsert('rm_market_price', d.marketDataId, {
      source: d.kind,
      deal_type: d.dealType ?? null,
      segment: d.segment ?? null,
      micromarket: d.micromarket ?? null,
      area_sqft: d.areaSqft ?? null,
      price_inr: lease ? null : (d.priceInr ?? null),
      rent_monthly_inr: lease ? (d.priceInr ?? null) : null,
      occurred_at: d.recordedOn ?? e.occurredAt,
    });
  },

  // ---------------------------------------------------------------- journeys: life curve and status
  'offer.confirmed.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await saveOffer(s, e.data.offerId, { last_confirmed_at: e.data.confirmedAt, confirmed_how: e.data.how });
  },
  'demand.confirmed.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await saveDemand(s, e.data.demandId, { last_confirmed_at: e.data.confirmedAt });
  },
  'lifecycle.stage_changed.v1': async (s, e) => {
    const d = e.data;
    if (!(await fresh(s, e, d.subjectId))) return;
    if (d.subjectType === 'offer') await saveOffer(s, d.subjectId, { life_stage: d.to, life_day: d.day });
    else await saveDemand(s, d.subjectId, { life_stage: d.to, life_day: d.day });
  },
  'offer.commercial_status_changed.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const d = e.data;
    await saveOffer(s, d.offerId, {
      commercial_status: d.to,
      ...(d.to === 'Closed' ? { closed_at: e.occurredAt } : {}),
    });
  },
  'demand.qualified.v1': async (s, e) => {
    const before = await s.get('rm_demand', e.data.demandId);
    if (before?.qualified_at) return;
    const after = await saveDemand(s, e.data.demandId, { qualified_at: e.occurredAt });
    await fact(s, e, 'demand_qualified', demandFactDims(after));
  },
  'demand.status_changed.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const d = e.data;
    const before = await s.get('rm_demand', d.demandId);
    const sourcing =
      d.to === 'Sourcing' ? { sourcing_since: before?.sourcing_since ?? e.occurredAt } : { sourcing_since: null };
    await saveDemand(s, d.demandId, { commercial_status: d.to, ...sourcing });
  },
  'demand.exited.v1': async (s, e) => {
    const d = e.data;
    const after = await saveDemand(s, d.demandId, {
      exit_type: d.exit,
      exit_reason: d.reason ?? null,
      revisit_date: d.revisitDate ?? null,
    });
    await fact(s, e, `demand_exit_${d.exit.toLowerCase()}`, { ...demandFactDims(after), reason: d.reason ?? null });
    if (d.competingPriceInr !== undefined) {
      const lease = after.deal_type_primary === 'Lease';
      await s.upsert('rm_market_price', stableUuid(`competing|${e.eventId}`), {
        source: 'reported',
        deal_type: after.deal_type_primary,
        segment: after.segment,
        property_type_primary: after.property_type_primary,
        micromarket: after.micromarkets[0] ?? null,
        locality: after.localities[0] ?? null,
        area_sqft: after.area_sqft_max ?? after.area_sqft_min,
        price_inr: lease ? null : d.competingPriceInr,
        rent_monthly_inr: lease ? d.competingPriceInr : null,
        occurred_at: e.occurredAt,
      });
    }
  },
  'demand.reactivated.v1': async (s, e) => {
    await saveDemand(s, e.data.demandId, { exit_type: null, exit_reason: null, revisit_date: null });
  },
  'demand.sourcing_started.v1': async (s, e) => {
    const before = await s.get('rm_demand', e.data.demandId);
    if (before?.sourcing_since) return;
    await saveDemand(s, e.data.demandId, { sourcing_since: e.occurredAt });
  },

  // ---------------------------------------------------------------- journeys: sourcing, proposals, visits
  'sourcing_request.created.v1': async (s, e) => {
    const d = e.data;
    const existing = await s.get('rm_sourcing_request', d.sourcingRequestId);
    await s.upsert('rm_sourcing_request', d.sourcingRequestId, {
      code: d.code,
      demand_id: d.demandId,
      assignee_user_id: d.assigneeUserId,
      due_date: d.dueDate ?? null,
      priority: d.priority ?? null,
      ...(existing ? {} : { status: 'open' }),
    });
  },
  'sourcing_request.updated.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await s.upsert('rm_sourcing_request', e.data.sourcingRequestId, { status: e.data.status });
  },
  'proposal.sent.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_proposal', d.proposalId, { demand_id: d.demandId, match_ids: d.matchIds, sent_at: e.occurredAt });
  },
  'proposal.feedback_recorded.v1': async (s, e) => {
    const d = e.data;
    const p = await s.get('rm_proposal', d.proposalId);
    const feedback = { ...(p?.feedback ?? {}) };
    for (const f of d.feedback) feedback[f.matchId] = f.verdict;
    await s.upsert('rm_proposal', d.proposalId, { demand_id: d.demandId, feedback });
  },
  'site_visit.scheduled.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_site_visit', d.visitId, {
      demand_id: d.demandId,
      offer_ids: d.offerIds,
      scheduled_for: d.scheduledFor,
    });
  },
  'site_visit.completed.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_site_visit', d.visitId, {
      demand_id: d.demandId,
      offer_ids: d.offerIds,
      preferred_offer_id: d.preferredOfferId ?? null,
      completed_at: e.occurredAt,
    });
  },

  // ---------------------------------------------------------------- journeys: deals and offers
  'deal.opened.v1': async (s, e) => {
    const d = e.data;
    const [offer, demand, existing] = await Promise.all([
      s.get('rm_offer', d.offerId),
      s.get('rm_demand', d.demandId),
      s.get('rm_deal', d.dealId),
    ]);
    await s.upsert('rm_deal', d.dealId, {
      code: d.code,
      demand_id: d.demandId,
      offer_id: d.offerId,
      opened_at: e.occurredAt,
      ...(existing ? {} : { status: DEAL_STATUS.open }),
      owner_user_id: demand?.owner_user_id ?? null,
      deal_type: offer?.deal_type ?? demand?.deal_type_primary ?? null,
      segment: offer?.segment ?? null,
      property_type_primary: offer?.property_type_primary ?? null,
      micromarket: offer?.micromarket ?? null,
      locality: offer?.locality ?? null,
      area_sqft: offer?.area_sqft_max ?? offer?.area_sqft_min ?? null,
    });
    await fact(s, e, 'deal_opened', {
      segment: offer?.segment ?? null,
      deal_type: offer?.deal_type ?? null,
      owner_user_id: demand?.owner_user_id ?? null,
      micromarket: offer?.micromarket ?? null,
    });
  },
  'deal.updated.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const d = e.data;
    await s.upsert('rm_deal', d.dealId, { stage: d.stage, follow_up_date: d.followUpDate, overdue: d.overdue ?? false });
  },
  'deal.closed.v1': async (s, e) => {
    const d = e.data;
    const [offer, deal] = await Promise.all([s.get('rm_offer', d.offerId), s.get('rm_deal', d.dealId)]);
    const dealType = d.dealType ?? deal?.deal_type ?? offer?.deal_type ?? null;
    await s.upsert('rm_deal', d.dealId, {
      demand_id: d.demandId,
      offer_id: d.offerId,
      status: DEAL_STATUS.closed,
      closed_at: d.closedAt,
      closing_price_inr: d.closingPriceInr ?? null,
      deal_type: dealType,
      lease_months: d.leaseMonths ?? null,
      units_booked: d.unitsBooked ?? null,
      ...(deal?.segment ? {} : { segment: offer?.segment ?? null, micromarket: offer?.micromarket ?? null }),
    });
    await saveOffer(s, d.offerId, { closed_at: d.closedAt, closing_price_inr: d.closingPriceInr ?? null });
    if (d.closingPriceInr !== undefined) {
      const lease = dealType === 'Lease';
      await s.upsert('rm_market_price', d.dealId, {
        source: 'closed_by_us',
        offer_id: d.offerId,
        deal_type: dealType,
        segment: offer?.segment ?? null,
        property_type_primary: offer?.property_type_primary ?? null,
        micromarket: offer?.micromarket ?? null,
        locality: offer?.locality ?? null,
        area_sqft: offer?.area_sqft_max ?? offer?.area_sqft_min ?? null,
        price_inr: lease ? null : d.closingPriceInr,
        rent_monthly_inr: lease ? d.closingPriceInr : null,
        occurred_at: d.closedAt,
        void: false,
      });
    }
    await fact(s, e, 'deal_closed', {
      segment: offer?.segment ?? null,
      deal_type: dealType,
      owner_user_id: deal?.owner_user_id ?? null,
      micromarket: offer?.micromarket ?? null,
    });
  },
  'deal.cancelled.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_deal', d.dealId, {
      demand_id: d.demandId,
      offer_id: d.offerId,
      status: DEAL_STATUS.cancelled,
      cancel_reason: d.reason,
    });
    const price = await s.get('rm_market_price', d.dealId);
    if (price) await s.upsert('rm_market_price', d.dealId, { void: true });
  },
  'offer.retired.v1': async (s, e) => {
    const d = e.data;
    const after = await saveOffer(s, d.offerId, { retired_reason: d.reason });
    if (d.knownPriceInr !== undefined) {
      const lease = after.deal_type === 'Lease';
      await s.upsert('rm_market_price', d.offerId, {
        source: 'retired_known',
        offer_id: d.offerId,
        deal_type: after.deal_type,
        segment: after.segment,
        property_type_primary: after.property_type_primary,
        micromarket: after.micromarket,
        locality: after.locality,
        area_sqft: after.area_sqft_max ?? after.area_sqft_min,
        price_inr: lease ? null : d.knownPriceInr,
        rent_monthly_inr: lease ? d.knownPriceInr : null,
        occurred_at: e.occurredAt,
      });
    }
  },

  // ---------------------------------------------------------------- journeys: tasks, calls, queues
  'watchlist_task.completed.v1': async (s, e) => {
    await s.upsert('rm_watchlist_item', e.data.watchlistItemId, { task_open: false });
  },
  'call.logged.v1': async (s, e) => {
    const d = e.data;
    await s.upsert('rm_call', d.callId, {
      subject_type: d.subjectType,
      subject_id: d.subjectId,
      outcome: d.outcome,
      attempt: d.attempt ?? null,
      person_unreachable: d.personUnreachable ?? false,
      called_by: d.calledBy ?? null,
      occurred_at: e.occurredAt,
    });
    await fact(s, e, 'calls_logged', { owner_user_id: d.calledBy ?? null, reason: d.outcome });
  },
  'queue.counts_changed.v1': async (s, e) => {
    if (!(await fresh(s, e, e.data.userId))) return;
    await s.queueCounts(e.data.userId, e.data.counts);
  },

  // ---------------------------------------------------------------- crm-engine: matches
  'match.suggested.v1': async (s, e) => {
    const d = e.data;
    const before = await s.get('rm_match', d.matchId);
    if (await fresh(s, e)) {
      await s.upsert('rm_match', d.matchId, {
        code: d.code,
        demand_id: d.demandId,
        offer_ids: d.offerIds,
        is_bundle: d.isBundle ?? d.offerIds.length > 1,
        score: d.score,
        flags: d.flags ?? [],
        status: MATCH_STATUS.suggested,
        suggested_at: e.occurredAt,
      });
    } else {
      await s.upsert('rm_match', d.matchId, { code: d.code, offer_ids: d.offerIds, suggested_at: e.occurredAt });
    }
    if (before?.suggested_at) return; // counts once per match
    await bumpOffers(s, d.offerIds, 'match_suggested_count');
    const dm = await s.get('rm_demand', d.demandId);
    const after = await saveDemand(s, d.demandId, { match_suggested_count: (dm?.match_suggested_count ?? 0) + 1 });
    await fact(s, e, 'match_suggested', demandFactDims(after));
  },
  'match.confirmed.v1': async (s, e) => {
    const d = e.data;
    const before = await s.get('rm_match', d.matchId);
    if (await fresh(s, e))
      await s.upsert('rm_match', d.matchId, {
        demand_id: d.demandId,
        offer_ids: d.offerIds,
        status: MATCH_STATUS.confirmed,
        confirmed_at: before?.confirmed_at ?? e.occurredAt,
      });
    else if (!before?.confirmed_at) await s.upsert('rm_match', d.matchId, { confirmed_at: e.occurredAt });
    if (before?.confirmed_at) return; // counts once per match
    await bumpOffers(s, d.offerIds, 'match_confirmed_count');
    const dm = await s.get('rm_demand', d.demandId);
    const after = await saveDemand(s, d.demandId, { match_confirmed_count: (dm?.match_confirmed_count ?? 0) + 1 });
    await fact(s, e, 'match_confirmed', demandFactDims(after));
  },
  'match.rejected.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await s.upsert('rm_match', e.data.matchId, {
      demand_id: e.data.demandId,
      status: MATCH_STATUS.rejected,
      reject_reason: e.data.reason,
    });
  },
  'match.closed.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await s.upsert('rm_match', e.data.matchId, {
      demand_id: e.data.demandId,
      status: MATCH_STATUS.closed,
      close_reason: e.data.reason,
      closed_at: e.occurredAt,
    });
  },
  'match.flagged.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    const m = await s.get('rm_match', e.data.matchId);
    const flags = new Set(m?.flags ?? []);
    if (e.data.cleared) flags.delete(e.data.flag);
    else flags.add(e.data.flag);
    await s.upsert('rm_match', e.data.matchId, { flags: [...flags].sort() });
  },
  'match.reopened.v1': async (s, e) => {
    if (!(await fresh(s, e))) return;
    await s.upsert('rm_match', e.data.matchId, {
      demand_id: e.data.demandId,
      status: MATCH_STATUS.suggested,
      close_reason: null,
      closed_at: null,
    });
  },
  'demand.matching_completed.v1': async (s, e) => {
    const d = e.data;
    const before = await s.get('rm_demand', d.demandId);
    if (before?.last_matching_at && before.last_matching_at >= e.occurredAt) return;
    await saveDemand(s, d.demandId, {
      last_matching_at: e.occurredAt,
      last_match_count: d.matchCount + (d.bundleCount ?? 0),
    });
  },

  // ---------------------------------------------------------------- listings, web
  'publication.changed.v1': async (s, e) => {
    const d = e.data;
    if (d.subjectType === 'project') return; // projects have no publication column in the read model
    if (!(await fresh(s, e, d.subjectId))) return;
    if (d.subjectType === 'offer') {
      const after = await saveOffer(s, d.subjectId, { publication_level: d.to, public_id: d.publicId ?? null });
      if (d.to === 'Public' && d.from !== 'Public') await fact(s, e, 'offer_published_public', offerFactDims(after));
    } else {
      await saveDemand(s, d.subjectId, { publication_level: d.to });
    }
  },
  'user.changed.v1': async (s, e) => {
    if (!(await fresh(s, e, e.data.userId))) return;
    // Role and active only: the display name is staff PII and is not stored (LLD §5.2).
    await s.user(e.data.userId, e.data.role, e.data.active);
  },
};

/** Applies one event (the drain calls it inside its transaction). Unknown types are not handled here. */
export async function applyEvent(s: ReadModelStore, e: Incoming, now: Date): Promise<void> {
  const h = handlers[e.eventType] as Handler<EventType> | undefined;
  if (!h) return;
  await h(s, e);
  await s.applied(new Date(e.occurredAt), now);
}

export const HANDLED_EVENTS = Object.keys(handlers) as EventType[];
