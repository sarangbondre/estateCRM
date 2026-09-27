'use client';
// C-16 Exit card (PRD §5.4, US-26; journeys LLD §4.2.4–4.2.5). Lost (reason, competing terms / price → market data),
// Dormant (revisit date, default today + 60, A-41), Invalid (reason; flag the person) → Confirm. Blocked while a deal
// is open (cancel it first). An exited demand can be reactivated: Dormant by the demand team, Lost / Invalid only by a
// Manager or Admin (exit override).
// journeys: getDemandJourney, exitDemand, reactivateDemand; records: getDemand (the linked person for flagging).
import { useState } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import type { operations as recordsOps } from '@11e/contracts/records';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input, RecordLink, Select } from '../common';
import {
  allowed,
  buildExit,
  canReactivate,
  defaultRevisit,
  EXIT_REASONS,
  exitEffect,
  exitTypeFromText,
  ROLES,
  todayIst,
} from './logic';
import type { ExitType } from './logic';
import { JourneyChips, Note, Problems, Radios, TextArea, useDemandJourney } from './shared';

type Journey = Ok<journeysOps['exitDemand']>;
type Demand = Ok<recordsOps['getDemand']>;

interface Props {
  demand: string;
  note?: string;
  done?: boolean;
}

const enc = encodeURIComponent;
const TYPES: { value: ExitType; label: string }[] = [
  { value: 'Lost', label: 'Lost' },
  { value: 'Dormant', label: 'Dormant' },
  { value: 'Invalid', label: 'Invalid' },
];

function Reactivate({ demand, exitType, role, onDone }: { demand: string; exitType: string; role: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction(
    (key) =>
      call<Journey>('POST', `/v1/demands/${enc(demand)}/reactivate`, {
        body: reason.trim() ? { reason: reason.trim() } : {},
        idempotencyKey: key,
      }),
    onDone,
  );
  const ok = canReactivate(exitType, role);
  return (
    <>
      <TextArea label="Why reactivate (optional)" value={reason} onChange={setReason} maxLength={500} />
      {!ok && <Note>Reactivating a {exitType} demand is a Manager override.</Note>}
      {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
      <ActionButton primary pending={act.pending} disabled={!ok} onClick={() => void act.run()}>
        Reactivate
      </ActionButton>
      <Note>The life curve restarts at day 0 and matching runs again.</Note>
    </>
  );
}

function ExitCard({ spec, shell, patch }: CardProps<Props>) {
  const demand = String(spec.props.demand ?? '');
  const journey = useDemandJourney(demand || null);
  const record = useResource<Demand>(demand ? `/v1/demands/${enc(demand)}` : null);
  const j = journey.data;
  const today = todayIst();
  const [type, setType] = useState<ExitType>(exitTypeFromText(spec.props.note) ?? 'Dormant');
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [terms, setTerms] = useState('');
  const [price, setPrice] = useState('');
  const [revisit, setRevisit] = useState(defaultRevisit(today));
  const [flag, setFlag] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const canExit = allowed(shell.me.role, ROLES.exit);
  const personId = record.data?.personId ?? null;

  const input = { type, reasonCode, reason, competingTerms: terms, competingPrice: price, revisitDate: revisit, flagPerson: flag, personId };
  const act = useAction(
    (key) => {
      const built = buildExit(input, today);
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<Journey>('POST', `/v1/demands/${enc(demand)}/exit`, { body: built.body, idempotencyKey: key });
    },
    (r) => {
      setMessage(`${r.data.code ?? demand} exited as ${type}.`);
      patch({ done: true });
      journey.reload();
    },
  );

  const exit = j?.exit ?? null;
  return (
    <Card
      kicker="Exit"
      title={<RecordLink code={j?.code ?? demand} shell={shell} />}
      label={`Exit ${demand}`}
      chips={<JourneyChips journey={j} />}
    >
      {journey.loading && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {message && <Done>{message}</Done>}
      {j && exit && (
        <>
          <p className="small">
            Exited as <b>{exit.type}</b> on {date(exit.exitedAt)}
            {exit.revisitDate ? `, revisit ${date(exit.revisitDate)}` : ''}
            {exit.reasonCode ? ` (${exit.reasonCode.replace(/_/g, ' ')})` : ''}.
          </p>
          <Reactivate
            demand={j.code ?? demand}
            exitType={exit.type}
            role={shell.me.role}
            onDone={() => {
              setMessage('Reactivated.');
              journey.reload();
            }}
          />
        </>
      )}
      {j && !exit && (
        <>
          {j.openDealId && <Note>A deal is open on this demand. Cancel the deal before exiting.</Note>}
          <Radios
            legend="Exit as"
            name={`ex-${spec.id}`}
            value={type}
            options={TYPES}
            onChange={(t) => {
              setType(t);
              setReasonCode(null);
            }}
          />
          <div className="form-grid">
            <Select
              label="Reason"
              value={reasonCode}
              options={EXIT_REASONS[type]}
              onChange={setReasonCode}
              required={type !== 'Dormant'}
            />
            {type === 'Dormant' && <Input label="Revisit on" type="date" value={revisit} onChange={setRevisit} min={today} required />}
            {type === 'Lost' && (
              <>
                <Input label="Competing terms" value={terms} onChange={setTerms} placeholder="e.g. Powai, 2 months rent free" />
                <Input label="Competing price (₹, optional)" value={price} onChange={setPrice} inputMode="numeric" />
              </>
            )}
          </div>
          <TextArea label="Details" value={reason} onChange={setReason} maxLength={500} hint="Business terms only; no names or phone numbers." />
          {type === 'Invalid' && (
            <>
              <Checkbox label="Flag the person so future records from them are marked" checked={flag} onChange={setFlag} />
              {flag && !personId && !record.loading && <Note>No person is linked to this demand.</Note>}
            </>
          )}
          <Note>{exitEffect(type)}</Note>
          {!canExit && <Note>Your role cannot exit demands.</Note>}
          <Problems errors={errors} />
          {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
          <ActionButton
            primary
            pending={act.pending}
            disabled={!canExit || !!j.openDealId}
            onClick={() => {
              const built = buildExit(input, today);
              setErrors('errors' in built ? built.errors : []);
              if (!('errors' in built)) void act.run();
            }}
          >
            Confirm {type}
          </ActionButton>
        </>
      )}
    </Card>
  );
}

export default ExitCard;
