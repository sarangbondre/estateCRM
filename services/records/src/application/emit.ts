// Event helpers: aggregateVersion = the row version after the change (records LLD §5.1), facts from fresh views.
import type { EventDataMap } from '@11e/contracts/events';
import { demandFacts, offerFacts, priceSnapshot, projectFacts } from './facts.js';
import type { OfferRow } from './model.js';
import type { Tx } from './ports.js';

/** Emits offer.created.v1 for offers inserted at version 1. */
export async function emitOffersCreated(tx: Tx, offerIds: readonly string[]): Promise<void> {
  for (const v of await tx.q.offerViews(offerIds)) {
    await tx.events.emit('offer.created.v1', agg('offer', v.offer.id, v.offer.version), offerFacts(v));
  }
}

/**
 * Bumps each offer's version and emits offer.updated.v1 with the full current facts. Use after a change to the offer,
 * its property or its project (the offer facts include them).
 */
export async function bumpOffersUpdated(tx: Tx, offerIds: readonly string[]): Promise<void> {
  const ids = [...new Set(offerIds)];
  if (!ids.length) return;
  const rows = await tx.store.getMany('offers', ids);
  for (const o of rows) await tx.store.update('offers', o.id, { version: o.version + 1 });
  for (const v of await tx.q.offerViews(ids)) {
    if (v.offer.status === 'voided') continue;
    await tx.events.emit('offer.updated.v1', agg('offer', v.offer.id, v.offer.version), offerFacts(v));
  }
}

/** Emits offer.updated.v1 for offers whose version the caller already bumped. */
export async function emitOffersUpdated(tx: Tx, offerIds: readonly string[]): Promise<void> {
  for (const v of await tx.q.offerViews([...new Set(offerIds)])) {
    await tx.events.emit('offer.updated.v1', agg('offer', v.offer.id, v.offer.version), offerFacts(v));
  }
}

/** Active offers of these properties. */
export async function activeOfferIdsOf(tx: Tx, propertyIds: readonly string[]): Promise<string[]> {
  const offers = await tx.store.findIn('offers', 'property_id', propertyIds, { status: 'active' });
  return offers.map((o) => o.id);
}

/**
 * Emits offer.price_changed.v1 when a price field differs between `before` and the stored row. Every event on an
 * aggregate gets its own version (the row version is bumped per event), so consumers that drop versions they have
 * already applied never lose the following offer.updated.v1.
 */
export async function emitPriceChanged(
  tx: Tx,
  before: OfferRow,
  cause: EventDataMap['offer.price_changed.v1']['cause'],
): Promise<boolean> {
  const after = await tx.store.get('offers', before.id);
  if (!after) return false;
  const prev = priceSnapshot(before);
  const cur = priceSnapshot(after);
  if (JSON.stringify(prev) === JSON.stringify(cur)) return false;
  const version = after.version + 1;
  await tx.store.update('offers', after.id, { version });
  await tx.events.emit('offer.price_changed.v1', agg('offer', after.id, version), {
    offerId: after.id,
    previous: prev,
    current: cur,
    ...(cause ? { cause } : {}),
  });
  return true;
}

/** Bumps the offer version and emits offer.record_stage_changed.v1. */
export async function emitStageChanged(tx: Tx, offerId: string, from: string, to: string, changedBy: string, hasRealPhotos: boolean) {
  const row = await tx.store.get('offers', offerId);
  if (!row) return;
  const version = row.version + 1;
  await tx.store.update('offers', offerId, { version });
  await tx.events.emit('offer.record_stage_changed.v1', agg('offer', offerId, version), {
    offerId,
    from,
    to,
    hasRealPhotos,
    changedBy,
  });
}

export async function emitDemand(tx: Tx, type: 'demand.created.v1' | 'demand.updated.v1', demandIds: readonly string[]) {
  for (const v of await tx.q.demandViews([...new Set(demandIds)])) {
    await tx.events.emit(type, agg('demand', v.demand.id, v.demand.version), demandFacts(v));
  }
}

/** Bumps each demand's version and emits demand.updated.v1. */
export async function bumpDemandsUpdated(tx: Tx, demandIds: readonly string[]): Promise<void> {
  const ids = [...new Set(demandIds)];
  const rows = await tx.store.getMany('demands', ids);
  for (const d of rows) await tx.store.update('demands', d.id, { version: d.version + 1 });
  await emitDemand(tx, 'demand.updated.v1', ids);
}

export async function emitProject(tx: Tx, type: 'project.created.v1' | 'project.updated.v1', projectId: string) {
  const [v] = await tx.q.projectViews([projectId]);
  if (v) await tx.events.emit(type, agg('project', v.project.id, v.project.version), projectFacts(v));
}

export const agg = (aggregateType: string, aggregateId: string, aggregateVersion: number) => ({
  aggregateType,
  aggregateId,
  aggregateVersion,
});
