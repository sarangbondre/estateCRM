// Offer retirement and R-12 reactivation (C-17, US-18; LLD §4.2.2, §4.4).
import { freezeCurve, unfreezeCurve } from './curve.js';
import { rederiveOffer } from './derive.js';
import { JourneyError, invalidTransition, notFoundErr } from './errors.js';
import { offerCell } from './facts.js';
import type { OfferJourneyRow } from './model.js';
import { audit } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems } from './queue-ops.js';

export type RetireReason = 'already_gone' | 'unwilling' | 'other';

/** Retire → Inactive in one transaction: items closed, curve frozen, offer.retired.v1 + status event + audit. */
export async function retireOfferCore(
  tx: Tx,
  offerId: string,
  reason: RetireReason,
  knownPriceInr: number | null | undefined,
  actor: string,
): Promise<OfferJourneyRow> {
  const oj = await tx.rows.get('offer_journey', offerId, { forUpdate: true });
  if (!oj) throw notFoundErr('offer');
  if (oj.commercial_status === 'Closed' || oj.commercial_status === 'Inactive')
    throw invalidTransition(`a ${oj.commercial_status} offer cannot be retired`);
  if ((await tx.q.openDealsOfOffer(offerId, 1)).length)
    throw new JourneyError(409, 'exit-blocked-by-open-deal', 'the offer has an open deal');
  const wasSupply = oj.commercial_status === 'Upcoming' || oj.commercial_status === 'Available';
  const updated = (await rederiveOffer(tx, offerId, { set: 'Inactive', reason, inactiveReason: reason })) ?? oj;
  await closeItems(tx, { offerId }, 'cancelled', `retired_${reason}`);
  await freezeCurve(tx, 'offer', offerId);
  await tx.events.emit(
    'offer.retired.v1',
    { type: 'offer', id: offerId },
    { offerId, reason, ...(knownPriceInr !== null && knownPriceInr !== undefined ? { knownPriceInr } : {}) },
  );
  const view = await tx.rows.get('offer_view', offerId);
  const cell = view ? offerCell(view) : null;
  if (cell && wasSupply) await tx.q.adjustGapCells([cell], 0, -1, tx.now);
  await audit(tx, 'offer.retired', actor, { type: 'offer', id: offerId }, { reason, ...(view ? { code: view.code } : {}) });
  return updated;
}

/** R-12: a "confirmed" outcome on an Inactive offer reactivates it (curve unfrozen, status re-derived). */
export async function reactivateInactiveOffer(tx: Tx, offerId: string): Promise<void> {
  const oj = await tx.rows.get('offer_journey', offerId, { forUpdate: true });
  if (!oj || oj.commercial_status !== 'Inactive') return;
  await tx.rows.update('offer_journey', offerId, { inactive_reason: null });
  await unfreezeCurve(tx, 'offer', offerId);
  const after = await rederiveOffer(tx, offerId, { reopen: true, reason: 'reactivated' });
  const view = await tx.rows.get('offer_view', offerId);
  const cell = view ? offerCell(view) : null;
  if (cell && after && (after.commercial_status === 'Available' || after.commercial_status === 'Upcoming'))
    await tx.q.adjustGapCells([cell], 0, 1, tx.now);
}
