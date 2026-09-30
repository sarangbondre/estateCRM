// Add supply for a demand or sourcing request (REC-07, US-05 AC2, C-07): dedup first, offer at Contacted tagged
// "Sourced for DEM-…"; crm-engine matches it on offer.created.v1 and journeys queues its verification.
import { RecordsError } from '../domain/errors.js';
import type { Actor, App } from './context.js';
import { agg, emitOffersCreated } from './emit.js';
import { mustFind } from './lookup.js';
import type { OfferRow, SourceType } from './model.js';
import { mergedError } from './people.js';
import { createSupply, linkParties, offerFromInput } from './supply.js';
import type { Dto, PartyInputDto, ScoredCandidate, SupplyResult } from './supply.js';

export interface AddSupplyInput {
  sourcingRequestId?: string | null | undefined;
  existingPropertyId?: string | null | undefined;
  property?: Dto | null | undefined;
  offer: Dto;
  parties?: PartyInputDto[] | undefined;
  sourceType?: SourceType | undefined;
  sourceDetail?: string | undefined;
  confirmNewDespiteCandidates?: boolean | undefined;
}

export async function addSupplyForDemand(
  app: App,
  actor: Actor,
  demandIdOrCode: string,
  input: AddSupplyInput,
  present: (c: ScoredCandidate) => Dto,
): Promise<SupplyResult> {
  if (!!input.existingPropertyId === !!input.property) {
    throw new RecordsError('validation-failed', 'exactly one of existingPropertyId and property', {
      errors: [{ field: 'property', code: 'one-of' }],
    });
  }
  return app.uow.run(actor, async (tx) => {
    const demand = await mustFind(tx, 'demands', demandIdOrCode);
    if (demand.status === 'merged') throw mergedError(demand.merged_into_id);
    if (actor.role === 'Demand agent' && demand.owner_user_id !== actor.userId) throw new RecordsError('not-demand-owner');
    const base: Partial<OfferRow> = {
      record_stage: 'Contacted',
      sourced_for_demand_id: demand.id,
      sourcing_request_id: input.sourcingRequestId ?? null,
      source_type: input.sourceType ?? 'Direct',
      capture_mode: 'typed_in',
      owner_user_id: actor.role === 'Supply agent' ? actor.userId : null,
    };
    let result: SupplyResult;
    if (input.existingPropertyId) {
      const property = await tx.store.get('properties', input.existingPropertyId, { lock: true });
      if (!property) throw new RecordsError('validation-failed', 'unknown property', { errors: [{ field: 'existingPropertyId', code: 'not-found' }] });
      if (property.status === 'merged') throw mergedError(property.merged_into_id);
      const offer = await offerFromInput(app, tx, property.id, input.offer, 'offer/', base);
      const clash = await tx.store.find('offers', { property_id: property.id, deal_type: offer.deal_type, status: 'active', project_id: null }, { limit: 1 });
      if (clash.length) throw new RecordsError('deal-type-exists', `the property already has an active ${offer.deal_type} offer`);
      await tx.store.insert('offers', offer);
      await linkParties(app, tx, { type: 'property', id: property.id }, input.parties ?? []);
      await emitOffersCreated(tx, [offer.id]);
      result = { propertyId: property.id, offerIds: [offer.id] };
    } else {
      result = await createSupply(
        app,
        tx,
        actor,
        {
          property: input.property as Dto,
          offers: [input.offer],
          parties: input.parties,
          sourceType: input.sourceType,
          sourceDetail: input.sourceDetail,
          confirmNewDespiteCandidates: input.confirmNewDespiteCandidates,
        },
        base,
        present,
      );
    }
    // The offer enters at Contacted (US-05 AC2): the Captured → Contacted move is announced for the record axis.
    const property = await tx.store.get('properties', result.propertyId);
    for (const offerId of result.offerIds) {
      const o = await tx.store.get('offers', offerId);
      if (!o) continue;
      const version = o.version + 1;
      await tx.store.update('offers', offerId, { version });
      await tx.events.emit('offer.record_stage_changed.v1', agg('offer', offerId, version), {
        offerId,
        from: 'Captured',
        to: 'Contacted',
        hasRealPhotos: property?.has_real_photos ?? false,
        changedBy: actor.userId,
      });
    }
    return result;
  });
}
