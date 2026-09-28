// Reactions to journeys / listings / intake events (REC-10, records LLD §5.2, §4.15, §4.16). Each handler runs in
// the drain transaction (exactly-once effects with processed_events); stale events are dropped by version; automatic
// changes use the system actor (R-7) and bump the retention anchor of linked people (NFR-18).
import type { EventDataMap } from '@11e/contracts/events';
import { liftOfferStage } from '../domain/record-stage.js';
import { routeRow } from '../domain/routing.js';
import { SYSTEM_USER_ID } from './context.js';
import type { App } from './context.js';
import { agg, bumpDemandsUpdated, bumpOffersUpdated, emitOffersCreated, emitStageChanged } from './emit.js';
import { recreateFromSnapshot, reclassify } from './review.js';
import type { MarketDataRow, OfferRow, VoidReason } from './model.js';
import { setFlag, touchPeople } from './people.js';
import type { Tx } from './ports.js';
import { voidSubject } from './voiding.js';

type Data<T extends keyof EventDataMap> = EventDataMap[T];
export interface Inbound {
  aggregateId: string;
  aggregateVersion: number;
}

/** inbound_versions (conventions §5): true when this version is newer than the last applied one. */
export async function acceptVersion(tx: Tx, type: string, id: string, version: number): Promise<boolean> {
  const [row] = await tx.store.find('inbound_versions', { aggregate_type: type, aggregate_id: id }, { limit: 1, lock: true });
  if (row && version <= row.last_version) return false;
  if (row) await tx.store.updateWhere('inbound_versions', { aggregate_type: type, aggregate_id: id }, { last_version: version, updated_at: tx.now });
  else await tx.store.insert('inbound_versions', { aggregate_type: type, aggregate_id: id, last_version: version });
  return true;
}

async function offerPeople(tx: Tx, offer: OfferRow): Promise<string[]> {
  const parties = await tx.store.findIn('record_parties', 'subject_id', [offer.id, offer.property_id]);
  return parties.map((p) => p.person_id);
}

/** Record stage ≥ Contacted (forward only): record_stage_changed + updated when it moves. */
async function liftToContacted(tx: Tx, offerId: string): Promise<void> {
  const offer = await tx.store.get('offers', offerId, { lock: true });
  if (!offer || offer.status !== 'active') return;
  await touchPeople(tx, await offerPeople(tx, offer));
  const to = liftOfferStage(offer.record_stage, 'Contacted');
  if (to === offer.record_stage) return;
  await tx.store.update('offers', offer.id, { record_stage: to });
  const property = await tx.store.get('properties', offer.property_id);
  await emitStageChanged(tx, offer.id, offer.record_stage, to, SYSTEM_USER_ID, property?.has_real_photos ?? false);
  await bumpOffersUpdated(tx, [offer.id]);
}

export async function onOfferConfirmed(tx: Tx, data: Data<'offer.confirmed.v1'>) {
  await liftToContacted(tx, data.offerId);
}

export async function onSiteVisitCompleted(tx: Tx, data: Data<'site_visit.completed.v1'>) {
  for (const id of data.offerIds) await liftToContacted(tx, id);
  const demand = await tx.store.get('demands', data.demandId);
  if (demand) await touchPeople(tx, [demand.person_id]);
}

export async function onCallLogged(tx: Tx, data: Data<'call.logged.v1'>) {
  if (data.personId) {
    const person = await tx.store.get('persons', data.personId, { lock: true });
    if (person && person.status === 'active') {
      await touchPeople(tx, [person.id]);
      if (data.personUnreachable) await setFlag(tx, (await tx.store.get('persons', person.id))!, 'unreachable', 'add', 'call not answered');
    }
  }
  if (data.subjectType === 'offer' && data.outcome === 'confirmed') await liftToContacted(tx, data.subjectId);
}

async function recordMarketData(app: App, tx: Tx, point: Omit<MarketDataRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>) {
  const id = app.ids.next();
  const inserted = await tx.store.insertIgnore('market_data_points', { id, ...point });
  if (!inserted) return null;
  // market_data.recorded.v1 knows closed_by_us / closed_elsewhere / reported only (see report: lost_competing).
  if (point.source !== 'lost_competing') {
    await tx.events.emit('market_data.recorded.v1', agg('market_data', id, 1), {
      marketDataId: id,
      kind: point.source,
      ...(point.segment ? { segment: point.segment } : {}),
      ...(point.deal_type ? { dealType: point.deal_type } : {}),
      ...(point.micromarket_id ? { micromarket: point.micromarket_id } : {}),
      ...((point.price_inr ?? point.rent_monthly_inr) !== null ? { priceInr: (point.price_inr ?? point.rent_monthly_inr) as number } : {}),
      ...(point.area_sqft !== null ? { areaSqft: point.area_sqft } : {}),
      recordedOn: point.observed_on,
    });
  }
  return id;
}

async function pointFromOffer(tx: Tx, offerId: string) {
  const offer = await tx.store.get('offers', offerId);
  const property = offer ? await tx.store.get('properties', offer.property_id) : undefined;
  return { offer, property };
}

export async function onDemandExited(app: App, tx: Tx, data: Data<'demand.exited.v1'>, inbound: Inbound) {
  const demand = await tx.store.get('demands', data.demandId, { lock: true });
  if (!demand || inbound.aggregateVersion <= demand.exit_version) return;
  await tx.store.update('demands', demand.id, { exit_state: data.exit, exit_version: inbound.aggregateVersion });
  const personId = data.personId ?? demand.person_id;
  if (data.flagPerson && personId) {
    const person = await tx.store.get('persons', personId, { lock: true });
    if (person && person.status === 'active') await setFlag(tx, person, 'invalid', 'add', data.reason ? 'demand exited' : undefined);
  }
  if (data.competingPriceInr !== undefined && data.exit === 'Lost') {
    await recordMarketData(app, tx, {
      property_id: null,
      offer_id: null,
      deal_id: null,
      demand_id: demand.id,
      micromarket_id: demand.micromarket_ids[0] ?? null,
      locality: demand.localities[0] ?? null,
      deal_type: demand.deal_types[0] ?? null,
      segment: demand.segment,
      property_type: demand.property_types[0] ?? null,
      area_basis: demand.area_basis,
      source: 'lost_competing',
      notes: data.competingTerms ?? null,
      price_inr: demand.deal_types[0] === 'Lease' ? null : data.competingPriceInr,
      rent_monthly_inr: demand.deal_types[0] === 'Lease' ? data.competingPriceInr : null,
      area_sqft: demand.area_sqft_min,
      observed_on: tx.now.toISOString().slice(0, 10),
      voided_at: null,
    });
  }
  await touchPeople(tx, [personId]);
}

export async function onDemandReactivated(tx: Tx, data: Data<'demand.reactivated.v1'>, inbound: Inbound) {
  const demand = await tx.store.get('demands', data.demandId, { lock: true });
  if (!demand || inbound.aggregateVersion <= demand.exit_version) return;
  await tx.store.update('demands', demand.id, { exit_state: null, exit_version: inbound.aggregateVersion });
  await touchPeople(tx, [demand.person_id]);
}

export async function onDealClosed(app: App, tx: Tx, data: Data<'deal.closed.v1'>) {
  // A cancellation that arrived first wins (HLD §7 compensation).
  const [cancelled] = await tx.store.find('inbound_versions', { aggregate_type: 'deal_cancelled', aggregate_id: data.dealId }, { limit: 1 });
  if (cancelled) return;
  const closedAt = new Date(data.closedAt);
  const { offer, property } = await pointFromOffer(tx, data.offerId);
  if (offer) await tx.store.update('offers', offer.id, { closed_at: closedAt });
  const demand = await tx.store.get('demands', data.demandId);
  if (demand) await tx.store.update('demands', demand.id, { closed_at: closedAt });
  const dealType = data.dealType ?? offer?.deal_type ?? null;
  const lease = dealType === 'Lease';
  await recordMarketData(app, tx, {
    property_id: property?.id ?? null,
    offer_id: offer?.id ?? null,
    deal_id: data.dealId,
    demand_id: null,
    micromarket_id: property?.micromarket_id ?? null,
    locality: property?.locality ?? null,
    deal_type: dealType,
    segment: property?.segment ?? null,
    property_type: property?.property_types[0] ?? null,
    area_basis: property?.area_basis ?? null,
    source: 'closed_by_us',
    notes: null,
    price_inr: lease ? null : (data.closingPriceInr ?? null),
    rent_monthly_inr: lease ? (data.closingPriceInr ?? null) : null,
    area_sqft: property?.area_sqft_min ?? null,
    observed_on: data.closedAt.slice(0, 10),
    voided_at: null,
  });
  await touchPeople(tx, [demand?.person_id, ...(offer ? await offerPeople(tx, offer) : [])]);
}

export async function onDealCancelled(tx: Tx, data: Data<'deal.cancelled.v1'>) {
  await tx.store.insertIgnore('inbound_versions', { aggregate_type: 'deal_cancelled', aggregate_id: data.dealId, last_version: 1 });
  await tx.store.updateWhere('market_data_points', { deal_id: data.dealId, source: 'closed_by_us' }, { voided_at: tx.now });
  const offer = await tx.store.get('offers', data.offerId);
  if (offer?.closed_at) await tx.store.update('offers', offer.id, { closed_at: null });
  const demand = await tx.store.get('demands', data.demandId);
  if (demand?.closed_at) await tx.store.update('demands', demand.id, { closed_at: null });
}

export async function onOfferRetired(app: App, tx: Tx, data: Data<'offer.retired.v1'>) {
  const { offer, property } = await pointFromOffer(tx, data.offerId);
  if (!offer) return;
  if (!offer.retired_at) await tx.store.update('offers', offer.id, { retired_at: tx.now, retired_reason: data.reason });
  if (data.knownPriceInr !== undefined) {
    const lease = offer.deal_type === 'Lease';
    await recordMarketData(app, tx, {
      property_id: property?.id ?? null,
      offer_id: offer.id,
      deal_id: null,
      demand_id: null,
      micromarket_id: property?.micromarket_id ?? null,
      locality: property?.locality ?? null,
      deal_type: offer.deal_type,
      segment: property?.segment ?? null,
      property_type: property?.property_types[0] ?? null,
      area_basis: property?.area_basis ?? null,
      source: 'closed_elsewhere',
      notes: null,
      price_inr: lease ? null : data.knownPriceInr,
      rent_monthly_inr: lease ? data.knownPriceInr : null,
      area_sqft: property?.area_sqft_min ?? null,
      observed_on: tx.now.toISOString().slice(0, 10),
      voided_at: null,
    });
  }
  await touchPeople(tx, await offerPeople(tx, offer));
}

/** R-19: the Upcoming offer (a copy of the previous Lease offer, Available From, Contacted). One-shot. */
export async function onLeaseRenewalDue(app: App, tx: Tx, data: Data<'lease_renewal.due.v1'>) {
  const prev = await tx.store.get('offers', data.previousOfferId);
  if (!prev || prev.property_id !== data.propertyId) return;
  const [existing] = await tx.store.find('offers', { renewal_of_offer_id: prev.id, possession_date: data.availableFrom }, { limit: 1 });
  if (existing) return;
  const code = await tx.codes.next('INV', 5);
  const offer: OfferRow = {
    ...prev,
    id: app.ids.next(),
    code,
    possession_status: 'Available From',
    possession_date: data.availableFrom,
    possession_date_start: data.availableFrom,
    record_stage: 'Contacted',
    publication_level: 'Private',
    publication_version: 0,
    renewal_of_offer_id: prev.id,
    closed_at: null,
    retired_at: null,
    retired_reason: null,
    status: 'active',
    void_reason: null,
    merged_into_id: null,
    enquiry_count: 0,
    sighting_count: 0,
    second_source_count: 0,
    has_price_gap: false,
    times_seen: 1,
    staff_edited_fields: [],
    created_at: tx.now,
    updated_at: tx.now,
    version: 1,
  };
  await tx.store.insert('offers', offer);
  await emitOffersCreated(tx, [offer.id]);
  await touchPeople(tx, await offerPeople(tx, prev));
}

/** Cache of the publication level (listings owns it), newer versions only. G-R9: demand_post uses the demand id. */
export async function onPublicationChanged(tx: Tx, data: Data<'publication.changed.v1'>, inbound: Inbound) {
  const table = data.subjectType === 'offer' ? 'offers' : data.subjectType === 'project' ? 'projects' : 'demands';
  const row = (await tx.store.get(table, data.subjectId, { lock: true })) as { id: string; publication_version: number } | undefined;
  if (!row || inbound.aggregateVersion <= row.publication_version) return;
  await tx.store.update(table, row.id, { publication_level: data.to, publication_version: inbound.aggregateVersion } as never);
}

/** §4.16: set/confirm apply the final classification (a changed kind voids and recreates); discard voids. */
export async function onReviewResolved(app: App, tx: Tx, data: Data<'review_item.resolved.v1'>, inbound: Inbound) {
  if (!(await acceptVersion(tx, 'review_item', data.reviewItemId, inbound.aggregateVersion))) return;
  let rec = (await tx.store.find('ingested_records', { external_source: 'extractor', external_ref: data.externalRef }, { limit: 1 }))[0];
  rec ??= (await tx.store.find('ingested_records', { external_source: 'upload', external_ref: data.externalRef }, { limit: 1 }))[0];
  if (!rec) return;
  if (data.action === 'discard') {
    await voidSubject(tx, rec, 'duplicate_discarded');
    return;
  }
  const next = routeRow({ recordScope: data.recordScope ?? rec.record_scope, side: data.side ?? null });
  if (rec.primary_subject_type === 'unrouted') {
    await recreateFromSnapshot(app, tx, rec, data);
    return;
  }
  const kind = next.kind === 'supply' ? 'offer' : next.kind === 'demand' ? 'demand' : next.kind === 'desk' ? 'desk_item' : next.kind === 'network' ? 'person' : 'unrouted';
  if (kind !== rec.primary_subject_type) {
    const scopeChanged = (data.recordScope ?? rec.record_scope) !== rec.record_scope;
    const reason: VoidReason = scopeChanged ? 'scope_changed' : 'side_changed';
    await reclassify(app, tx, rec, data, kind, reason);
    return;
  }
  // Same kind: the final classification replaces the extractor's and the review flag clears.
  if (rec.primary_subject_type === 'offer' && rec.property_id) {
    const property = await tx.store.get('properties', rec.property_id, { lock: true });
    if (property) {
      await tx.store.update('properties', property.id, {
        ...(data.segment !== undefined ? { segment: data.segment } : {}),
        ...(data.propertyTypes !== undefined ? { property_types: data.propertyTypes } : {}),
        version: property.version + 1,
      });
    }
    const offers = await tx.store.find('offers', { property_id: rec.property_id, status: 'active' }, { limit: 20 });
    for (const o of offers) {
      await tx.store.update('offers', o.id, {
        needs_review: false,
        review_reason: null,
        review_reason_code: null,
        ...(data.market !== undefined && o.deal_type === 'Sale' ? { market: data.market } : {}),
      });
    }
    await bumpOffersUpdated(tx, offers.map((o) => o.id));
  } else if (rec.primary_subject_type === 'demand' && rec.primary_subject_id) {
    await tx.store.update('demands', rec.primary_subject_id, {
      needs_review: false,
      review_reason: null,
      review_reason_code: null,
      ...(data.dealTypes !== undefined ? { deal_types: data.dealTypes } : {}),
      ...(data.market !== undefined ? { market: data.market } : {}),
      ...(data.segment !== undefined ? { segment: data.segment } : {}),
      ...(data.propertyTypes !== undefined ? { property_types: data.propertyTypes } : {}),
    });
    await bumpDemandsUpdated(tx, [rec.primary_subject_id]);
  }
}
