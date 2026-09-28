// Quick add (REC-04, US-04): phone-first lookup (POST, never a URL) and one-step creation of a demand, a touch or
// supply; source type Direct / capture mode typed_in by default; stage Captured, Contacted when during a call (R-10).
import { RecordsError, notFound } from '../domain/errors.js';
import { normaliseEmail, normalisePhone } from '../domain/phone.js';
import type { Actor, App } from './context.js';
import { addTouchTo, demandFromInput, insertDemand, matchDemand, raiseDemandCandidates } from './demands.js';
import type { DemandRow, OfferRow, PersonRow, SourceType, TouchRow } from './model.js';
import { createPerson, mergedError } from './people.js';
import type { Tx } from './ports.js';
import { createSupply } from './supply.js';
import type { Dto, ScoredCandidate } from './supply.js';

export interface LookupResult {
  normalised: boolean;
  people: { personId: string; openDemandIds: string[]; offerIds: string[] }[];
}

export async function quickAddLookup(app: App, actor: Actor, input: { phone?: string | undefined; email?: string | undefined }): Promise<LookupResult> {
  return app.uow.run(actor, async (tx) => {
    const phone = input.phone ? normalisePhone(input.phone) : null;
    const email = input.email ? normaliseEmail(input.email) : null;
    const people: PersonRow[] = [];
    if (phone) people.push(...(await tx.q.personsByPhoneHashes([app.hash.phone(tx.tenantId, phone)])).map((r) => r.person));
    if (email) people.push(...(await tx.q.personsByEmailHashes([app.hash.email(tx.tenantId, email)])).map((r) => r.person));
    const unique = [...new Map(people.map((p) => [p.id, p])).values()].slice(0, 5);
    const out: LookupResult['people'] = [];
    for (const person of unique) {
      const demands = await tx.q.demandCandidates({ personId: person.id, companyNorm: null, since: new Date(0) });
      const parties = await tx.store.find('record_parties', { person_id: person.id }, { limit: 50 });
      const propertyIds = parties.filter((p) => p.subject_type === 'property').map((p) => p.subject_id);
      const direct = parties.filter((p) => p.subject_type === 'offer').map((p) => p.subject_id);
      const offers = [
        ...(await tx.store.findIn('offers', 'property_id', propertyIds, { status: 'active' })),
        ...(await tx.store.findIn('offers', 'id', direct, { status: 'active' })),
      ];
      out.push({
        personId: person.id,
        openDemandIds: demands.slice(0, 10).map((d) => d.id),
        offerIds: [...new Set(offers.map((o) => o.id))].slice(0, 10),
      });
    }
    return { normalised: phone !== null || (!input.phone && email !== null), people: out };
  });
}

export interface QuickAddInput {
  phone: string;
  name?: string | null | undefined;
  companyName?: string | null | undefined;
  partyType?: string | null | undefined;
  side: 'Supply' | 'Demand';
  existingPersonId?: string | null | undefined;
  existingDemandId?: string | null | undefined;
  demand?: Dto | null | undefined;
  property?: Dto | null | undefined;
  offers?: Dto[] | undefined;
  sourceType?: SourceType | undefined;
  sourceDetail?: string | undefined;
  referrerPersonId?: string | null | undefined;
  confirmNewDespiteCandidates?: boolean | undefined;
  duringCall?: boolean | undefined;
}

export interface QuickAddOutcome {
  outcome: 'demand_created' | 'touch_added' | 'offers_created';
  personId: string;
  demandId: string | null;
  touch: TouchRow | null;
  propertyId: string | null;
  offerIds: string[];
  mergeCandidateIds: string[];
}

const partyRole = (partyType: string | null, dealType: string | undefined) => {
  if (partyType === 'Broker') return 'Broker';
  if (partyType === 'Developer') return 'Developer';
  if (dealType === 'Lease') return 'Landlord';
  if (dealType === 'JV') return 'Landowner';
  return 'Seller';
};

async function person(app: App, tx: Tx, input: QuickAddInput): Promise<PersonRow> {
  if (input.existingPersonId) {
    const p = await tx.store.get('persons', input.existingPersonId);
    if (!p) throw notFound('person');
    if (p.status === 'merged') throw mergedError(p.merged_into_id);
    return p;
  }
  const r = await createPerson(
    app,
    tx,
    { name: input.name, phones: [input.phone], companyName: input.companyName, partyType: input.partyType },
    { onExisting: 'reuse' },
  );
  return r.person;
}

export async function quickAdd(
  app: App,
  actor: Actor,
  input: QuickAddInput,
  present: (c: ScoredCandidate) => Dto,
): Promise<QuickAddOutcome> {
  if (!normalisePhone(input.phone)) {
    throw new RecordsError('phone-invalid', undefined, { errors: [{ field: 'phone', code: 'phone-invalid' }] });
  }
  if (input.side === 'Demand' && actor.role === 'Supply agent') throw new RecordsError('forbidden', 'supply agents add supply');
  if (input.side === 'Supply' && actor.role === 'Demand agent') throw new RecordsError('forbidden', 'demand agents add demands');
  const sourceType = input.sourceType ?? 'Direct';
  return app.uow.run(actor, async (tx) => {
    const p = await person(app, tx, input);
    const base: QuickAddOutcome = {
      outcome: 'demand_created',
      personId: p.id,
      demandId: null,
      touch: null,
      propertyId: null,
      offerIds: [],
      mergeCandidateIds: [],
    };
    const touchSource = {
      sourceType,
      captureMode: 'typed_in' as const,
      sourceDetail: input.sourceDetail,
      referrerPersonId: input.referrerPersonId,
    };
    if (input.side === 'Demand') {
      if (input.existingDemandId) {
        const d = await tx.store.get('demands', input.existingDemandId, { lock: true });
        if (!d || d.status === 'voided') throw notFound('demand');
        if (d.status === 'merged') throw mergedError(d.merged_into_id);
        const touch = await addTouchTo(app, tx, d, touchSource);
        return { ...base, outcome: 'touch_added', demandId: d.id, touch };
      }
      if (!input.demand) {
        throw new RecordsError('validation-failed', 'side Demand needs demand or existingDemandId', {
          errors: [{ field: 'demand', code: 'required' }],
        });
      }
      const demand: DemandRow = await demandFromInput(
        app,
        tx,
        input.demand,
        {
          person_id: p.id,
          company_name: (input.demand['companyName'] as string | undefined) ?? p.company_name,
          owner_user_id: (input.demand['ownerUserId'] as string | undefined) ?? (actor.role === 'Demand agent' ? actor.userId : null),
          source_type: sourceType,
          capture_mode: 'typed_in',
          // R-10: the demand axis has no Contacted stage, so a demand taken during a call also starts at Captured.
          record_stage: 'Captured',
        },
        'demand/',
      );
      const match = await matchDemand(tx, demand);
      if (match.decision === 'touch' && match.best) {
        const touch = await addTouchTo(app, tx, match.best, touchSource);
        return { ...base, outcome: 'touch_added', demandId: match.best.id, touch };
      }
      const touch = await insertDemand(app, tx, demand, touchSource);
      const ids = await raiseDemandCandidates(app, tx, demand.id, match.similar);
      return { ...base, outcome: 'demand_created', demandId: demand.id, touch, mergeCandidateIds: ids };
    }
    if (!input.property || !input.offers?.length) {
      throw new RecordsError('validation-failed', 'side Supply needs property and at least one offer', {
        errors: [{ field: input.property ? 'offers' : 'property', code: 'required' }],
      });
    }
    const role = partyRole(p.party_type, input.offers[0]?.['dealType'] as string | undefined);
    const offerBase: Partial<OfferRow> = {
      record_stage: input.duringCall ? 'Contacted' : 'Captured',
      source_type: sourceType,
      capture_mode: 'typed_in',
    };
    const r = await createSupply(
      app,
      tx,
      actor,
      {
        property: input.property,
        offers: input.offers,
        parties: [{ personId: p.id, role }],
        sourceType,
        sourceDetail: input.sourceDetail,
        confirmNewDespiteCandidates: input.confirmNewDespiteCandidates,
      },
      offerBase,
      present,
    );
    return { ...base, outcome: 'offers_created', propertyId: r.propertyId, offerIds: r.offerIds };
  });
}
