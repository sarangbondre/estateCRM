// Direct effects of lifecycle, commercial, deal and merge events on matches (LLD §4.6, §4.7). They run in the event
// handler's transaction so Stale/Expired/Closed effects land within the drain cycle (NFR-9); the re-score pipeline
// then re-ranks the affected demands ("those demands return to matching", BRD §7).
import { isOpen, reconfirmFlags, closeReasonForOfferClosed, STATUS_PRECEDENCE } from '../domain/lifecycle.js';
import { offerSetKeyOf } from '../domain/bundles.js';
import type { CloseReason, MatchStatus } from '../domain/types.js';
import { ProjectionGapError } from './projection.js';
import type { Change, EventMeta } from './projection.js';
import { queueDemandRun } from './pipeline.js';
import type { Clock, DemandRecord, MatchRecord, OfferRecord, Store } from './ports.js';

const OPEN: MatchStatus[] = ['Suggested', 'Confirmed'];
const LIMIT = 2000;

async function closeMatch(
  store: Store,
  m: MatchRecord,
  reason: CloseReason,
  closedByDealId: string | null = m.closedByDealId,
): Promise<MatchRecord> {
  const saved = await store.matches.update({
    ...m,
    status: 'Closed',
    closedReason: reason,
    priorStatus: isOpen(m.status) ? m.status : m.priorStatus,
    closedByDealId,
    rank: null,
  });
  await store.events.publish({ type: 'match.closed.v1', match: saved, reason });
  return saved;
}

/** Closes every open match containing the offer; the affected demands re-run (freed top-N slots). */
export async function closeOpenForOffer(
  store: Store,
  tenantId: string,
  offerId: string,
  reason: CloseReason,
  closedByDealId: string | null = null,
): Promise<number> {
  const open = await store.matches.listForOffer(tenantId, offerId, OPEN, LIMIT);
  for (const m of open) {
    await closeMatch(store, m, reason, closedByDealId);
    await store.rescore.markDirty(tenantId, 'demand', m.demandId, `match.closed:${reason}`);
  }
  return open.length;
}

/** Closes every open match of a demand. */
export async function closeOpenForDemand(
  store: Store,
  tenantId: string,
  demandId: string,
  reason: CloseReason,
  closedByDealId: string | null = null,
): Promise<number> {
  const open = (await store.matches.listForDemand(tenantId, demandId, LIMIT)).filter((m) => isOpen(m.status));
  for (const m of open) await closeMatch(store, m, reason, closedByDealId);
  return open.length;
}

/** reconfirm flag on open matches containing the offer (any member Stale → flag). */
export async function refreshReconfirm(store: Store, tenantId: string, offerId: string): Promise<void> {
  const open = await store.matches.listForOffer(tenantId, offerId, OPEN, LIMIT);
  if (!open.length) return;
  const members = await store.mx.getOffers(tenantId, [...new Set(open.flatMap((m) => m.offerIds))]);
  const stale = new Set(members.filter((o) => o.lifeStage === 'Stale').map((o) => o.id));
  for (const m of open) {
    const next = reconfirmFlags(
      m.flags,
      m.offerIds.some((id) => stale.has(id)),
    );
    if (next.length === m.flags.length && next.every((f) => m.flags.includes(f))) continue;
    const saved = await store.matches.update({ ...m, flags: next });
    const raised = next.includes('reconfirm');
    await store.events.publish({
      type: 'match.flagged.v1',
      match: saved,
      flag: 'reconfirm',
      cleared: !raised,
    });
  }
}

// --- offer axes --------------------------------------------------------------------------------------------------------

/** lifecycle.stage_changed.v1 / offer.confirmed.v1 for an offer: reconfirm flag and Expired closes (§4.6). */
export async function onOfferLifeChange(store: Store, change: Change<OfferRecord> | null): Promise<void> {
  if (!change) return;
  const { before, after } = change;
  if (after.lifeStage === 'Expired' && before.lifeStage !== 'Expired') {
    await closeOpenForOffer(store, after.tenantId, after.id, 'offer_expired');
    return;
  }
  if ((before.lifeStage === 'Stale') !== (after.lifeStage === 'Stale'))
    await refreshReconfirm(store, after.tenantId, after.id);
}

/** offer.commercial_status_changed.v1 / offer.retired.v1 (§4.6). */
export async function onOfferCommercialChange(
  store: Store,
  change: Change<OfferRecord> | null,
): Promise<void> {
  if (!change) return;
  const { before, after } = change;
  if (after.commercialStatus === before.commercialStatus) return;
  if (after.commercialStatus === 'Closed') {
    const deal = await store.deals.latestClosedForOffer(after.tenantId, after.id);
    const open = await store.matches.listForOffer(after.tenantId, after.id, OPEN, LIMIT);
    for (const m of open) {
      const own = deal && m.demandId === deal.demandId;
      await closeMatch(
        store,
        m,
        own ? 'deal_closed' : closeReasonForOfferClosed(after.dealType),
        deal?.id ?? null,
      );
      if (!own) await store.rescore.markDirty(after.tenantId, 'demand', m.demandId, 'offer.closed');
    }
  } else if (after.commercialStatus === 'Inactive') {
    await closeOpenForOffer(store, after.tenantId, after.id, 'offer_retired');
  }
}

export async function onOfferVoided(store: Store, offer: OfferRecord | null): Promise<void> {
  if (offer) await closeOpenForOffer(store, offer.tenantId, offer.id, 'voided');
}

// --- demand axes -------------------------------------------------------------------------------------------------------

/** demand.status_changed.v1 / demand.exited.v1 / lifecycle (Expired, Paused) (§4.6). */
export async function onDemandChange(store: Store, change: Change<DemandRecord> | null): Promise<void> {
  if (!change) return;
  const { before, after } = change;
  if (after.exitType && !before.exitType) {
    await closeOpenForDemand(store, after.tenantId, after.id, 'demand_exited');
  } else if (after.commercialStatus === 'Closed' && before.commercialStatus !== 'Closed') {
    const deal = await store.deals.latestClosedForDemand(after.tenantId, after.id);
    await closeOpenForDemand(store, after.tenantId, after.id, 'demand_closed', deal?.id ?? null);
  } else if (
    (after.lifeStage === 'Expired' || after.lifeStage === 'Paused') &&
    before.lifeStage !== after.lifeStage
  ) {
    const reason = after.lifeStage === 'Expired' ? 'demand_expired' : 'demand_paused';
    await closeOpenForDemand(store, after.tenantId, after.id, reason);
  }
}

export async function onDemandVoided(store: Store, demand: DemandRecord | null): Promise<void> {
  if (demand) await closeOpenForDemand(store, demand.tenantId, demand.id, 'voided');
}

/** demand.qualified.v1: inventory check — a priority demand-side run ending with demand.matching_completed.v1. */
export async function onDemandQualified(
  store: Store,
  clock: Clock,
  meta: EventMeta,
  demandId: string,
): Promise<void> {
  const d = await store.mx.getDemand(meta.tenantId, demandId);
  if (!d) throw new ProjectionGapError(`demand ${demandId} not projected yet`);
  if (!d.qualified) await store.mx.saveDemand({ ...d, qualified: true });
  await queueDemandRun(store, clock, meta.tenantId, demandId, 'demand.qualified', null);
}

// --- deals and engagement -----------------------------------------------------------------------------------------------

async function pairMatches(
  store: Store,
  tenantId: string,
  demandId: string,
  offerId: string,
): Promise<MatchRecord[]> {
  return (await store.matches.listForOffer(tenantId, offerId, null, LIMIT)).filter(
    (m) => m.demandId === demandId,
  );
}

/** deal.opened.v1: the pair's matches are "in deal" (reject guard, match-in-deal). */
export async function onDealOpened(
  store: Store,
  tenantId: string,
  e: { dealId: string; demandId: string; offerId: string },
): Promise<void> {
  await store.deals.upsert({
    id: e.dealId,
    tenantId,
    demandId: e.demandId,
    offerId: e.offerId,
    status: 'open',
    unitsBooked: null,
    closedAt: null,
  });
  for (const m of await pairMatches(store, tenantId, e.demandId, e.offerId))
    if (isOpen(m.status) && m.openDealId !== e.dealId)
      await store.matches.update({ ...m, openDealId: e.dealId });
}

/**
 * deal.closed.v1: the deal's own match closes `deal_closed`; matches already closed by the offer close get the
 * deal id (compensation). A multi-unit project offer stays live, so only the deal's own match closes (§4.6).
 */
export async function onDealClosed(
  store: Store,
  tenantId: string,
  e: { dealId: string; demandId: string; offerId: string; closedAt: string; unitsBooked?: number },
): Promise<void> {
  await store.deals.upsert({
    id: e.dealId,
    tenantId,
    demandId: e.demandId,
    offerId: e.offerId,
    status: 'closed',
    unitsBooked: e.unitsBooked ?? null,
    closedAt: new Date(e.closedAt),
  });
  for (const m of await pairMatches(store, tenantId, e.demandId, e.offerId)) {
    if (isOpen(m.status)) await closeMatch(store, { ...m, openDealId: null }, 'deal_closed', e.dealId);
    else if (
      m.status === 'Closed' &&
      m.closedReason !== 'deal_closed' &&
      (m.closedReason === 'leased_to_another_client' ||
        m.closedReason === 'sold_to_another_client' ||
        m.closedReason === 'demand_closed')
    )
      await closeMatch(store, m, 'deal_closed', e.dealId); // the offer/demand close arrived first: correct the reason
  }
  const others = await store.matches.listForOffer(tenantId, e.offerId, ['Closed'], LIMIT);
  for (const m of others)
    if (
      m.demandId !== e.demandId &&
      !m.closedByDealId &&
      (m.closedReason === 'leased_to_another_client' || m.closedReason === 'sold_to_another_client')
    )
      await store.matches.update({ ...m, closedByDealId: e.dealId });
  const demandOthers = (await store.matches.listForDemand(tenantId, e.demandId, LIMIT)).filter(
    (m) => m.status === 'Closed' && m.closedReason === 'demand_closed' && !m.closedByDealId,
  );
  for (const m of demandOthers) await store.matches.update({ ...m, closedByDealId: e.dealId });
}

/**
 * deal.cancelled.v1 (compensation, HLD §7): matches closed by the deal reopen as Suggested (JB-4); the deal's own
 * match returns to Confirmed.
 */
export async function onDealCancelled(
  store: Store,
  tenantId: string,
  e: { dealId: string; demandId: string; offerId: string },
): Promise<void> {
  const deal = await store.deals.get(tenantId, e.dealId);
  await store.deals.upsert({
    id: e.dealId,
    tenantId,
    demandId: e.demandId,
    offerId: e.offerId,
    status: 'cancelled',
    unitsBooked: deal?.unitsBooked ?? null,
    closedAt: deal?.closedAt ?? null,
  });
  for (const m of await store.matches.listClosedByDeal(tenantId, e.dealId, LIMIT)) {
    if (m.status !== 'Closed') continue;
    const own = m.demandId === e.demandId && m.offerIds.includes(e.offerId);
    const saved = await store.matches.update({
      ...m,
      status: own ? 'Confirmed' : 'Suggested',
      closedReason: null,
      closedByDealId: null,
      priorStatus: null,
      openDealId: null,
    });
    await store.events.publish({ type: 'match.reopened.v1', match: saved, reason: 'deal_cancelled' });
    await store.rescore.markDirty(tenantId, 'demand', m.demandId, 'deal.cancelled');
  }
  for (const m of await pairMatches(store, tenantId, e.demandId, e.offerId))
    if (m.openDealId === e.dealId) await store.matches.update({ ...m, openDealId: null });
}

/** proposal.sent.v1 (M6 funnel). */
export async function onProposalSent(
  store: Store,
  tenantId: string,
  matchIds: readonly string[],
  at: Date,
): Promise<void> {
  for (const m of await store.matches.getMany(tenantId, matchIds.slice(0, 100)))
    if (!m.proposalSentAt) await store.matches.update({ ...m, proposalSentAt: at });
}

/** site_visit.completed.v1 (M6 funnel): the demand's matches containing the visited offers. */
export async function onSiteVisit(
  store: Store,
  tenantId: string,
  demandId: string,
  offerIds: readonly string[],
  at: Date,
): Promise<void> {
  const visited = new Set(offerIds);
  for (const m of await store.matches.listForDemand(tenantId, demandId, LIMIT))
    if (!m.visitedAt && m.offerIds.some((id) => visited.has(id)))
      await store.matches.update({ ...m, visitedAt: at });
}

// --- merges (§4.7) ------------------------------------------------------------------------------------------------------

const withKey = (m: MatchRecord, offerIds: string[], demandId: string): MatchRecord => ({
  ...m,
  offerIds: [...new Set(offerIds)].sort(),
  offerSetKey: offerSetKeyOf([...new Set(offerIds)]),
  demandId,
});

/** Re-keys the matches of a merged subject onto the survivor; collisions keep the highest status. */
async function rekey(
  store: Store,
  tenantId: string,
  mergeId: string,
  moved: MatchRecord[],
  map: (m: MatchRecord) => MatchRecord,
): Promise<void> {
  for (const m of moved) {
    await store.mergeLog.record(tenantId, mergeId, 'matches', m.id, m);
    const target = map(m);
    const clash = await store.matches.byPair(tenantId, target.demandId, target.offerSetKey);
    if (!clash || clash.id === m.id) {
      await store.matches.update(target);
      continue;
    }
    // Two matches collapse onto the same (demand, offer set): keep the higher status, close the other `merged`.
    const keepMoved = STATUS_PRECEDENCE[m.status] > STATUS_PRECEDENCE[clash.status];
    const loser = keepMoved ? clash : m;
    if (keepMoved) await store.mergeLog.record(tenantId, mergeId, 'matches', clash.id, clash);
    const parked = { ...loser, offerSetKey: `${loser.offerSetKey}#merged-${loser.id}` };
    if (isOpen(loser.status)) await closeMatch(store, parked, 'merged');
    else await store.matches.update(parked);
    if (keepMoved) await store.matches.update(target);
  }
}

/** records.merged.v1 for offers or demands. */
export async function onRecordsMerged(
  store: Store,
  tenantId: string,
  e: { mergeId: string; aggregateType: string; survivorId: string; mergedIds: string[] },
): Promise<void> {
  const merged = e.mergedIds.filter((id) => id !== e.survivorId).slice(0, 100);
  if (e.aggregateType === 'offer') {
    for (const id of merged) {
      const o = await store.mx.getOffer(tenantId, id);
      if (o && !o.mergedInto) {
        await store.mergeLog.record(tenantId, e.mergeId, 'offer_mx', id, { mergedInto: null });
        await store.mx.saveOffer({ ...o, mergedInto: e.survivorId });
      }
      const matches = await store.matches.listForOffer(tenantId, id, null, LIMIT);
      await rekey(store, tenantId, e.mergeId, matches, (m) =>
        withKey(
          m,
          m.offerIds.map((x) => (x === id ? e.survivorId : x)),
          m.demandId,
        ),
      );
      for (const m of matches)
        await store.rescore.markDirty(tenantId, 'demand', m.demandId, 'records.merged');
    }
    await store.rescore.markDirty(tenantId, 'offer', e.survivorId, 'records.merged');
  } else if (e.aggregateType === 'demand') {
    for (const id of merged) {
      const d = await store.mx.getDemand(tenantId, id);
      if (d && !d.mergedInto) {
        await store.mergeLog.record(tenantId, e.mergeId, 'demand_mx', id, { mergedInto: null });
        await store.mx.saveDemand({ ...d, mergedInto: e.survivorId });
      }
      const matches = await store.matches.listForDemand(tenantId, id, LIMIT);
      await rekey(store, tenantId, e.mergeId, matches, (m) => withKey(m, m.offerIds, e.survivorId));
    }
    await store.rescore.markDirty(tenantId, 'demand', e.survivorId, 'records.merged');
  }
}

/** records.merge_undone.v1: restore from merge_log; matches closed by the merge reopen (merge_undone). */
export async function onMergeUndone(
  store: Store,
  tenantId: string,
  e: { mergeId: string; aggregateType: string; restoredIds: string[] },
): Promise<void> {
  const entries = await store.mergeLog.entries(tenantId, e.mergeId, 5000);
  const dirtyDemands = new Set<string>();
  for (const entry of entries) {
    if (entry.table === 'offer_mx') {
      const o = await store.mx.getOffer(tenantId, entry.rowId);
      if (o) {
        await store.mx.saveOffer({ ...o, mergedInto: null });
        await store.rescore.markDirty(tenantId, 'offer', o.id, 'records.merge_undone');
      }
    } else if (entry.table === 'demand_mx') {
      const d = await store.mx.getDemand(tenantId, entry.rowId);
      if (d) {
        await store.mx.saveDemand({ ...d, mergedInto: null });
        dirtyDemands.add(d.id);
      }
    }
  }
  for (const entry of entries) {
    if (entry.table !== 'matches') continue;
    const before = entry.before as MatchRecord;
    const current = (await store.matches.getMany(tenantId, [entry.rowId]))[0];
    if (!current) continue;
    const clash = await store.matches.byPair(tenantId, before.demandId, before.offerSetKey);
    if (clash && clash.id !== current.id) continue; // the pair was matched again since: keep the newer match
    const restored = await store.matches.update({
      ...current,
      demandId: before.demandId,
      offerIds: before.offerIds,
      offerSetKey: before.offerSetKey,
      status: current.closedReason === 'merged' ? before.status : current.status,
      closedReason: current.closedReason === 'merged' ? before.closedReason : current.closedReason,
      priorStatus: current.closedReason === 'merged' ? before.priorStatus : current.priorStatus,
    });
    if (current.closedReason === 'merged' && isOpen(restored.status))
      await store.events.publish({ type: 'match.reopened.v1', match: restored, reason: 'merge_undone' });
    dirtyDemands.add(restored.demandId);
  }
  for (const id of dirtyDemands)
    await store.rescore.markDirty(tenantId, 'demand', id, 'records.merge_undone');
  await store.mergeLog.markUndone(tenantId, e.mergeId);
}
