'use client';
// C-08 Call outcome card (PRD §4.2 "Call outcome", §5.4; US-12 AC3, US-18; journeys LLD §4.4). Outcomes: Confirmed
// (edit price / availability / areas, only the changed fields are sent), No answer (attempt n of 3, rescheduled),
// Already gone (Inactive; price → market data), Unwilling (never published); next call date; add another offer on the
// same property. HLD §7: the UI makes the two writes itself on Save, each with its own Idempotency-Key, and reports
// each result: records (PATCH offer / property, merge patch + If-Match) and journeys (POST /v1/calls).
// journeys: getOfferJourney, getDemandJourney, logCall; records: getOffer, getProperty, patchOffer, patchProperty.
import { useRef, useState } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import type { operations as recordsOps } from '@11e/contracts/records';
import { call, get, useResource } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { inr, sqft } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input, RecordLink, VocabSelect } from '../common';
import {
  allowed,
  amount,
  buildCallBody,
  changedOnly,
  defaultNextCallDate,
  outcomeEffect,
  OUTCOME_LABEL,
  outcomesFor,
  priceFieldFor,
  ROLES,
  subjectOfCode,
  takesNextCallDate,
  todayIst,
} from './logic';
import type { CallOutcome } from './logic';
import { JourneyChips, Note, Problems, Radios, TextArea, useDemandJourney, useOfferJourney } from './shared';

type Offer = Ok<recordsOps['getOffer']>;
type Property = Ok<recordsOps['getProperty']>;
type OfferPatch = Body<recordsOps['patchOffer']>;
type PropertyPatch = Body<recordsOps['patchProperty']>;
type CallResult = Ok<journeysOps['logCall']>;

interface Props {
  code: string;
  note?: string;
  done?: boolean;
  outcome?: string;
}

const enc = encodeURIComponent;
const MERGE = 'application/merge-patch+json';

interface FactEdits {
  price: string;
  possessionStatus: string | null;
  possessionDate: string;
  areaMin: string;
  areaMax: string;
}

function initialEdits(o: Offer | undefined): FactEdits {
  const pf = priceFieldFor(o?.dealType);
  const price = o?.[pf];
  return {
    price: price != null ? String(price) : '',
    possessionStatus: o?.possessionStatus ?? null,
    possessionDate: o?.possessionDate ?? '',
    areaMin: o?.areaSqftMin != null ? String(o.areaSqftMin) : '',
    areaMax: o?.areaSqftMax != null ? String(o.areaSqftMax) : '',
  };
}

function offerPatchOf(o: Offer, e: FactEdits): OfferPatch {
  const pf = priceFieldFor(o.dealType);
  return changedOnly<OfferPatch>(
    { [pf]: o[pf] ?? null, possessionStatus: o.possessionStatus ?? null, possessionDate: o.possessionDate ?? null },
    { [pf]: amount(e.price), possessionStatus: e.possessionStatus, possessionDate: e.possessionDate || null },
  );
}

function areaPatchOf(o: Offer, e: FactEdits): PropertyPatch {
  return changedOnly<PropertyPatch>(
    { areaSqftMin: o.areaSqftMin ?? null, areaSqftMax: o.areaSqftMax ?? null },
    { areaSqftMin: amount(e.areaMin), areaSqftMax: amount(e.areaMax) },
  );
}

const describePatch = (p: Record<string, unknown>) =>
  Object.entries(p)
    .map(([k, v]) => `${k} → ${v === null ? 'blank' : typeof v === 'number' && /Inr/.test(k) ? inr(v) : String(v)}`)
    .join(', ');

function CallOutcomeCard({ spec, shell, patch }: CardProps<Props>) {
  const code = String(spec.props.code ?? '').toUpperCase();
  const subject = subjectOfCode(code);
  const offerJourney = useOfferJourney(subject === 'offer' ? code : null);
  const demandJourney = useDemandJourney(subject === 'demand' ? code : null);
  const journey = subject === 'offer' ? offerJourney : demandJourney;
  const offer = useResource<Offer>(subject === 'offer' ? `/v1/offers/${enc(code)}` : null);
  const today = todayIst();

  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [nextCall, setNextCall] = useState('');
  const [notes, setNotes] = useState(spec.props.note ?? '');
  const [availableNow, setAvailableNow] = useState(false);
  const [knownPrice, setKnownPrice] = useState('');
  const [edits, setEdits] = useState<FactEdits | null>(null);
  const [recordsOk, setRecordsOk] = useState<string | null>(null);
  const [callOk, setCallOk] = useState<CallResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // A retry after a failed property PATCH must not re-send the offer PATCH (its version has moved on).
  const offerPatched = useRef(false);

  const o = offer.data;
  const e = edits ?? initialEdits(o);
  const offerPatch = o && outcome === 'confirmed' ? offerPatchOf(o, e) : {};
  const areaPatch = o && outcome === 'confirmed' ? areaPatchOf(o, e) : {};
  const hasFactEdits = Object.keys(offerPatch).length > 0 || Object.keys(areaPatch).length > 0;
  const canCall = allowed(shell.me.role, ROLES.logCall);
  const canPatch = allowed(shell.me.role, ROLES.patchOffer);
  const attempts =
    subject === 'offer' ? (offerJourney.data?.queue?.attempts ?? 0) : (demandJourney.data?.queue?.attempts ?? 0);
  const subjectId = subject === 'offer' ? offerJourney.data?.offerId : demandJourney.data?.demandId;
  const queueItemId =
    subject === 'offer' ? offerJourney.data?.queue?.queueItemId : demandJourney.data?.queue?.queueItemId;
  const done = spec.props.done === true || (callOk !== null && (!hasFactEdits || recordsOk !== null));

  const records = useAction(
    async (key) => {
      if (!o) throw new Error('Offer not loaded.');
      const parts: string[] = [];
      if (Object.keys(offerPatch).length && !offerPatched.current) {
        await call<Offer>('PATCH', `/v1/offers/${enc(o.id)}`, {
          body: offerPatch,
          contentType: MERGE,
          ifMatch: o.version,
          idempotencyKey: key,
        });
        offerPatched.current = true;
        parts.push(describePatch(offerPatch));
      }
      if (Object.keys(areaPatch).length) {
        const prop = await get<Property>(`/v1/properties/${enc(o.propertyId)}`);
        await call<Property>('PATCH', `/v1/properties/${enc(o.propertyId)}`, {
          body: areaPatch,
          contentType: MERGE,
          ifMatch: prop.version,
          idempotencyKey: key,
        });
        parts.push(describePatch(areaPatch));
      }
      return parts.join('; ');
    },
    (summary) => {
      setRecordsOk(summary || 'No changes');
      offer.reload();
    },
  );

  const journeysCall = useAction(
    async (key) => {
      if (!subject || !subjectId || !outcome) throw new Error('Choose an outcome.');
      const built = buildCallBody(
        {
          subjectType: subject,
          subjectId,
          queueItemId: queueItemId ?? null,
          outcome,
          nextCallDate: nextCall,
          notes,
          availableNow,
          knownPriceInr: amount(knownPrice),
        },
        today,
      );
      if ('errors' in built) throw new Error(built.errors.join(' '));
      return (await call<CallResult>('POST', '/v1/calls', { body: built.body, idempotencyKey: key })).data;
    },
    (r) => {
      setCallOk(r);
      journey.reload();
      patch(outcome ? { done: true, outcome } : { done: true });
    },
  );

  const save = () => {
    if (!subject || !subjectId || !outcome) return;
    const built = buildCallBody(
      { subjectType: subject, subjectId, outcome, nextCallDate: nextCall, notes, availableNow, knownPriceInr: amount(knownPrice) },
      today,
    );
    if ('errors' in built) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    // Two independent writes (HLD §7): each keeps its own key and result; a retry re-runs only the failed one.
    if (hasFactEdits && recordsOk === null && canPatch) void records.run();
    if (callOk === null) void journeysCall.run();
  };

  if (!subject)
    return (
      <Card kicker="Call outcome" title={code || 'Unknown record'}>
        <p className="small muted">A call outcome needs an offer (INV-…) or a demand (DEM-…) code.</p>
      </Card>
    );

  const pf = priceFieldFor(o?.dealType);
  const status = subject === 'offer' ? offerJourney.data?.commercialStatus : demandJourney.data?.commercialStatus;
  const setEdit = (k: keyof FactEdits, v: string | null) => setEdits({ ...e, [k]: v ?? '' });

  return (
    <Card
      kicker="Call outcome"
      title={<RecordLink code={code} shell={shell} />}
      label={`Call outcome ${code}`}
      chips={
        <JourneyChips journey={subject === 'offer' ? offerJourney.data : demandJourney.data} />
      }
      footer={
        done ? (
          <>
            {callOk && (
              <Done>
                Call logged ({OUTCOME_LABEL[callOk.call.outcome]}){callOk.call.code ? ` · ${callOk.call.code}` : ''}
                {callOk.commercialStatus ? ` · now ${callOk.commercialStatus}` : ''}
                {callOk.personUnreachable ? ' · person marked unreachable' : ''}
              </Done>
            )}
            {spec.props.done && !callOk && <Done>Outcome saved{spec.props.outcome ? `: ${spec.props.outcome}` : ''}.</Done>}
            {recordsOk && <Done>Record updated: {recordsOk}</Done>}
            <span className="grow" />
            {subject === 'offer' && (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  shell.addCards([{ kind: 'add-supply', props: {} }], `Add another offer on ${o?.propertyCode ?? 'the same property'}`)
                }
              >
                Add an offer on this property
              </button>
            )}
            {subject === 'demand' && demandJourney.data?.commercialStatus === 'Contacted' && (
              <button type="button" className="btn sm" onClick={() => shell.addCards([{ kind: 'qualify', props: { demand: code } }])}>
                Qualify
              </button>
            )}
          </>
        ) : (
          <>
            <span className="grow" />
            <ActionButton
              primary
              onClick={save}
              pending={records.pending || journeysCall.pending}
              disabled={!outcome || !subjectId || !canCall}
            >
              {callOk ? 'Retry record update' : recordsOk ? 'Retry call log' : 'Save outcome'}
            </ActionButton>
          </>
        )
      }
    >
      {journey.loading && !journey.data && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {o && (
        <p className="small">
          {o.label} · {inr(o[pf] ?? null)}
          {o.areaSqftMin != null ? ` · ${sqft(o.areaSqftMin)}${o.areaSqftMax && o.areaSqftMax !== o.areaSqftMin ? `–${sqft(o.areaSqftMax)}` : ''}` : ''}
        </p>
      )}
      {!canCall && <Note>Your role cannot log calls.</Note>}
      {!done && (
        <>
          <Radios
            legend="Outcome"
            name={`co-${spec.id}`}
            value={outcome}
            options={outcomesFor(subject).map((v) => ({ value: v, label: OUTCOME_LABEL[v] }))}
            onChange={(v) => {
              setOutcome(v);
              setNextCall(defaultNextCallDate(v, today) ?? '');
            }}
            disabled={!canCall}
          />
          {outcome === 'confirmed' && subject === 'offer' && o && (
            <>
              <div className="form-grid">
                <Input
                  label={/lease|rent/i.test(o.dealType) ? 'Rent / month (₹)' : 'Price (₹)'}
                  value={e.price}
                  onChange={(v) => setEdit('price', v)}
                  inputMode="numeric"
                />
                <VocabSelect
                  field="possession_status"
                  label="Availability"
                  value={e.possessionStatus}
                  onChange={(v) => setEdit('possessionStatus', v)}
                />
                <Input
                  label="Available from"
                  value={e.possessionDate}
                  onChange={(v) => setEdit('possessionDate', v)}
                  placeholder="YYYY-MM-DD"
                />
                <Input label="Area min (sq ft)" value={e.areaMin} onChange={(v) => setEdit('areaMin', v)} inputMode="numeric" />
                <Input label="Area max (sq ft)" value={e.areaMax} onChange={(v) => setEdit('areaMax', v)} inputMode="numeric" />
              </div>
              {status === 'Upcoming' && (
                <Checkbox label="Available now (Upcoming → Available)" checked={availableNow} onChange={setAvailableNow} />
              )}
              {hasFactEdits ? (
                <p className="small">
                  <Chip tone="warn">Changes</Chip> {describePatch({ ...offerPatch, ...areaPatch })}
                  {!canPatch && ' (your role cannot edit offers)'}
                </p>
              ) : (
                <Note>No fact changes: only the call is logged.</Note>
              )}
            </>
          )}
          {outcome === 'already_gone' && (
            <Input label="Last known price (₹, optional)" value={knownPrice} onChange={setKnownPrice} inputMode="numeric" />
          )}
          {outcome && takesNextCallDate(outcome) && (
            <Input
              label={outcome === 'no_answer' ? 'Call again on' : 'Next call date (optional)'}
              type="date"
              value={nextCall}
              onChange={setNextCall}
              min={today}
            />
          )}
          <TextArea label="Notes" value={notes} onChange={setNotes} />
          {outcome && <Note>{outcomeEffect(outcome, subject, attempts)}</Note>}
          <Problems errors={errors} />
          {records.error !== undefined && (
            <div>
              <span className="small">Record update (records): </span>
              <ErrorNote error={records.error} onRetry={() => void records.run()} />
            </div>
          )}
          {journeysCall.error !== undefined && (
            <div>
              <span className="small">Call log (journeys): </span>
              <ErrorNote error={journeysCall.error} onRetry={() => void journeysCall.run()} />
            </div>
          )}
          {recordsOk && <Done>Record updated: {recordsOk}</Done>}
          {callOk && <Done>Call logged.</Done>}
        </>
      )}
    </Card>
  );
}

export default CallOutcomeCard;
