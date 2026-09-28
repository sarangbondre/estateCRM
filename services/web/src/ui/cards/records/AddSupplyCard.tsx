'use client';
// C-07 Add supply (PRD §5.4, US-05, FR-ENT-2): prefilled from the demand (GET /v1/demands/{code}); property-level
// duplicate check first (POST /v1/properties/dedup-check) with likely duplicates to pick; then create: for a demand
// POST /v1/demands/{code}/add-supply (offer starts at Contacted, tagged Sourced for DEM-…), otherwise POST /v1/offers on
// a picked property or POST /v1/properties for a new one. Done → "Open INV-…" / "Publish".
import { useEffect, useState } from 'react';
import type { components as R, operations as Records } from '@11e/contracts/records';
import { ApiError, call } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { inr, sqft } from '../../lib/format';
import { useVocabulary } from '../../lib/vocabulary';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Input, Select, numOrNull } from '../common';
import { RecordFields } from './RecordFields';
import {
  addSupplyRoute,
  buildAddSupplyRequest,
  buildCreateOfferRequest,
  buildCreatePropertyRequest,
  buildDedupRequest,
  candidatesOf,
  emptyForm,
  missingRequired,
  PARTY_ROLES,
  prefillFromDemand,
  rangeText,
  roleAllows,
  ROLES,
} from './logic';
import type { PartyDraft, PropertyChoice, PropertyExtras, RecordForm } from './logic';

export interface AddSupplyProps {
  demand?: string;
  done?: boolean;
  offerCodes?: string[];
  propertyCode?: string | null;
}

type Demand = Ok<Records['getDemand']>;
type DedupResult = Ok<Records['checkPropertyDuplicates']>;
type Candidate = R['schemas']['PropertyCandidate'];
type Offer = R['schemas']['Offer'];

type Picked = { kind: 'existing'; propertyId: string; code: string } | { kind: 'new' } | null;

export function AddSupplyCard({ spec, shell, patch }: CardProps<AddSupplyProps>) {
  const p = spec.props;
  const { vocab } = useVocabulary();
  const [demand, setDemand] = useState<Demand | null>(null);
  const [demandError, setDemandError] = useState<unknown>(undefined);
  const [demandTick, setDemandTick] = useState(0);
  const [form, setForm] = useState<RecordForm>(() => emptyForm('Supply'));
  const [prefilled, setPrefilled] = useState(false);
  const [extras, setExtras] = useState<{ buildingName: string; floorNo: number | null; city: string }>({
    buildingName: '',
    floorNo: null,
    city: '',
  });
  // Owner / broker contact stays in this component's memory only.
  const [party, setParty] = useState<PartyDraft>({ phone: '', name: '', role: null });
  const [dedup, setDedup] = useState<DedupResult | null>(null);
  const [picked, setPicked] = useState<Picked>(null);

  useEffect(() => {
    if (!p.demand || p.done) return;
    let live = true;
    call<Demand>('GET', `/v1/demands/${encodeURIComponent(p.demand)}`)
      .then((r) => live && setDemand(r.data))
      .catch((e: unknown) => live && setDemandError(e));
    return () => {
      live = false;
    };
  }, [p.demand, p.done, demandTick]);

  useEffect(() => {
    if (demand && vocab && !prefilled) {
      setForm(prefillFromDemand(demand, vocab));
      setPrefilled(true);
    }
  }, [demand, vocab, prefilled]);

  const propExtras: PropertyExtras = {
    buildingName: extras.buildingName,
    floorNo: extras.floorNo,
    city: extras.city,
  };

  const check = useAction(
    () =>
      call<DedupResult>('POST', '/v1/properties/dedup-check', {
        body: buildDedupRequest(form, propExtras, party),
      }).then((r) => r.data),
    (r) => {
      setDedup(r);
      setPicked(r.candidates?.length ? null : { kind: 'new' });
    },
  );

  const choice = (confirmNew: boolean): PropertyChoice =>
    picked?.kind === 'existing'
      ? { existingPropertyId: picked.propertyId }
      : { newProperty: true, confirmNewDespiteCandidates: confirmNew };

  const finish = (offers: Offer[], propertyCode: string | null) =>
    patch({ done: true, offerCodes: offers.map((o) => o.code).filter(Boolean), propertyCode });

  const submit = (confirmNew: boolean) => async (key: string) => {
    const c = choice(confirmNew);
    const route = addSupplyRoute(p.demand, c);
    try {
      if (route === 'add-supply') {
        const r = await call<Ok<Records['addSupplyForDemand']>>(
          'POST',
          `/v1/demands/${encodeURIComponent(p.demand ?? '')}/add-supply`,
          { body: buildAddSupplyRequest(form, propExtras, c, party), idempotencyKey: key },
        );
        return { offers: r.data.offers ?? [], propertyCode: r.data.property?.code ?? null };
      }
      if (route === 'offer' && 'existingPropertyId' in c) {
        const r = await call<Offer>('POST', '/v1/offers', {
          body: buildCreateOfferRequest(form, c.existingPropertyId),
          idempotencyKey: key,
        });
        return { offers: [r.data], propertyCode: r.data.propertyCode ?? null };
      }
      const r = await call<Ok<Records['createProperty']>>('POST', '/v1/properties', {
        body: buildCreatePropertyRequest(form, propExtras, confirmNew, party),
        idempotencyKey: key,
      });
      return { offers: r.data.offers ?? [], propertyCode: r.data.property?.code ?? null };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate-property-suspected') {
        setDedup({ decision: 'uncertain', candidates: candidatesOf(e.problem) });
        setPicked(null);
      }
      throw e;
    }
  };
  // A confirmed "new despite candidates" is a different body, so it gets its own Idempotency-Key.
  const create = useAction(submit(false), (r) => finish(r.offers, r.propertyCode));
  const createAnyway = useAction(submit(true), (r) => finish(r.offers, r.propertyCode));

  const allowed = p.demand ? ROLES.addSupplyForDemand : ROLES.createOffer;
  const canAct = roleAllows(shell.me.role, allowed);
  const canCheck = roleAllows(shell.me.role, ROLES.dedupCheck);

  if (p.done) {
    const code = p.offerCodes?.[0];
    return (
      <Card kicker="Add supply" title={p.demand ? `Supply for ${p.demand}` : 'Supply added'}>
        <Done>
          Created {p.offerCodes?.join(', ') || 'the offer'}
          {p.demand ? `, tagged Sourced for ${p.demand}; matching and verification run now` : ''}
        </Done>
        <div className="row">
          {code && (
            <button
              type="button"
              className="btn sm"
              onClick={() => shell.openPanel({ kind: 'offer', title: code, props: { code } })}
            >
              Open {code}
            </button>
          )}
          {code && (
            <button type="button" className="btn sm primary" onClick={() => shell.send(`publish ${code}`)}>
              Publish
            </button>
          )}
        </div>
      </Card>
    );
  }

  const missing = missingRequired(form);
  const hasCandidates = (dedup?.candidates?.length ?? 0) > 0;
  const confirmNewNeeded = picked?.kind === 'new' && hasCandidates;

  return (
    <Card
      kicker="Add supply"
      title={p.demand ? `For ${p.demand}` : 'New supply'}
      chips={
        p.demand ? (
          demand ? (
            <Chip tone="demand">Prefilled from {demand.code}</Chip>
          ) : demandError === undefined ? (
            <Chip>Loading demand…</Chip>
          ) : null
        ) : null
      }
      footer={
        <>
          <span className="grow" />
          {!dedup ? (
            <ActionButton primary onClick={check.run} pending={check.pending} disabled={!canCheck || missing.length > 0}>
              Check duplicates
            </ActionButton>
          ) : confirmNewNeeded ? (
            <ActionButton primary onClick={createAnyway.run} pending={createAnyway.pending} disabled={!canAct}>
              Create new property anyway
            </ActionButton>
          ) : (
            <ActionButton
              primary
              onClick={create.run}
              pending={create.pending}
              disabled={!canAct || !picked || missing.length > 0}
            >
              {picked?.kind === 'existing' ? `Create offer on ${picked.code}` : 'Create offer'}
            </ActionButton>
          )}
        </>
      }
    >
      {p.demand && demandError !== undefined && (
        <ErrorNote error={demandError} onRetry={() => { setDemandError(undefined); setDemandTick((n) => n + 1); }} />
      )}
      {demand && (
        <p className="small muted">
          {demand.label} · {rangeText(demand.areaSqftMin, demand.areaSqftMax, sqft) ?? 'any area'} ·{' '}
          {rangeText(demand.budgetInrMin ?? demand.rentMonthlyInrMin, demand.budgetInrMax ?? demand.rentMonthlyInrMax, inr) ??
            'budget not set'}
        </p>
      )}
      {!vocab && <Loading label="Loading the controlled lists" />}
      <fieldset disabled={Boolean(dedup)} style={{ border: 0, padding: 0, margin: 0 }}>
        <RecordFields form={form} onChange={setForm} vocab={vocab} lockSide />
        <div className="form-grid">
          <Input
            label="Building (private)"
            value={extras.buildingName}
            onChange={(v) => setExtras({ ...extras, buildingName: v })}
            placeholder="optional, helps the duplicate check"
          />
          <Input
            label="Floor"
            type="number"
            inputMode="numeric"
            value={extras.floorNo}
            onChange={(v) => setExtras({ ...extras, floorNo: numOrNull(v) })}
          />
          <Input label="City" value={extras.city} onChange={(v) => setExtras({ ...extras, city: v })} placeholder="optional" />
        </div>
        <div className="form-grid">
          <Select
            label="Contact role"
            value={party.role}
            options={PARTY_ROLES}
            onChange={(v) => setParty({ ...party, role: v })}
          />
          <Input label="Contact phone" type="tel" inputMode="tel" value={party.phone} onChange={(v) => setParty({ ...party, phone: v })} />
          <Input label="Contact name" value={party.name} onChange={(v) => setParty({ ...party, name: v })} placeholder="optional" />
        </div>
      </fieldset>
      {missing.length > 0 && <p className="small muted">Still needed: {missing.join(', ')}.</p>}
      {!canAct && <p className="small muted">Your role cannot add this supply.</p>}
      {check.error !== undefined && <ErrorNote error={check.error} onRetry={check.run} />}

      {dedup && (
        <div className="box">
          <div className="qh">
            Duplicate check: {dedup.decision === 'new' ? 'looks new' : dedup.decision === 'same_property' ? 'same property found' : 'possible duplicates'}
          </div>
          {(dedup.candidates ?? []).slice(0, 10).map((c) => (
            <CandidateRow
              key={c.propertyId}
              c={c}
              group={`${spec.id}-pick`}
              selected={picked?.kind === 'existing' && picked.propertyId === c.propertyId}
              onPick={() => setPicked({ kind: 'existing', propertyId: c.propertyId, code: c.code })}
              onOpen={() => shell.openPanel({ kind: 'property', title: c.code, props: { code: c.code } })}
            />
          ))}
          <div className="check">
            <input
              id={`${spec.id}-new`}
              type="radio"
              name={`${spec.id}-pick`}
              checked={picked?.kind === 'new'}
              onChange={() => setPicked({ kind: 'new' })}
            />
            <label htmlFor={`${spec.id}-new`}>It is a new property</label>
          </div>
          <button type="button" className="btn sm ghost" onClick={() => { setDedup(null); setPicked(null); }}>
            Edit details
          </button>
        </div>
      )}
      {create.error !== undefined && !(create.error instanceof ApiError && create.error.code === 'duplicate-property-suspected') && (
        <ErrorNote error={create.error} />
      )}
      {createAnyway.error !== undefined && <ErrorNote error={createAnyway.error} />}
    </Card>
  );
}

function CandidateRow({
  c,
  group,
  selected,
  onPick,
  onOpen,
}: {
  c: Candidate;
  group: string;
  selected: boolean;
  onPick: () => void;
  onOpen: () => void;
}) {
  const id = `cand-${c.propertyId}`;
  return (
    <div className="qitem2">
      <input id={id} type="radio" name={group} checked={selected} onChange={onPick} aria-label={`Use ${c.code}`} />
      <div className="grow">
        <label htmlFor={id}>
          <b>{c.code}</b> <span className="small muted">score {Math.round((c.score ?? 0) * 100)}%</span>
        </label>
        <div className="small muted">
          {c.summary ?? ''}
          {c.reasons?.length ? ` · same ${c.reasons.join(', ')}` : ''}
          {c.offers?.length ? ` · offers ${c.offers.map((o) => o.code).join(', ')}` : ''}
        </div>
      </div>
      <button type="button" className="btn sm" onClick={onOpen}>
        Open {c.code}
      </button>
    </div>
  );
}
