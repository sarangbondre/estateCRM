'use client';
// C-17 Close / retire offer card (PRD §5.4, US-18, US-16, US-27; journeys LLD §4.2.2). Inactive: already gone (price →
// market data), owner unwilling (kept for intelligence, never published) or other → retire. Closed: an offer closes
// through its deal (journeys has no direct close); the card shows the open deal and opens the Deal card to close it
// with the closing price. Closing notifies the other matched demands, keeps the price as market data and, for an
// 11-month lease, schedules the automatic Upcoming renewal offer.
// journeys: getOfferJourney, retireOffer, getDeal; records: getOffer.
import { useState } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import type { operations as recordsOps } from '@11e/contracts/records';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { inr } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Input, RecordLink, Select } from '../common';
import { allowed, buildRetire, canRetireStatus, priceFieldFor, RETIRE_REASONS, ROLES } from './logic';
import { JourneyChips, Note, Problems, Radios, TextArea, useOfferJourney } from './shared';

type OfferJourney = Ok<journeysOps['retireOffer']>;
type Offer = Ok<recordsOps['getOffer']>;
type Deal = Ok<journeysOps['getDeal']>;

interface Props {
  offer: string;
  done?: boolean;
}

const enc = encodeURIComponent;
type Mode = 'inactive' | 'closed';

function RetireCard({ spec, shell, patch }: CardProps<Props>) {
  const code = String(spec.props.offer ?? '');
  const journey = useOfferJourney(code || null);
  const offer = useResource<Offer>(code ? `/v1/offers/${enc(code)}` : null);
  const j = journey.data;
  const openDealId = j?.openDealIds?.[0] ?? null;
  const deal = useResource<Deal>(openDealId ? `/v1/deals/${enc(openDealId)}` : null);
  const d = deal.data;
  const [mode, setMode] = useState<Mode>('inactive');
  const [reason, setReason] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const canRetire = allowed(shell.me.role, ROLES.retire);
  const status = j?.commercialStatus;
  const lease = priceFieldFor(offer.data?.dealType) === 'rentMonthlyInrMin';
  const pf = priceFieldFor(offer.data?.dealType);

  const act = useAction(
    (key) => {
      const built = buildRetire({ reason, knownPrice: price, note });
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<OfferJourney>('POST', `/v1/offers/${enc(code)}/retire`, { body: built.body, idempotencyKey: key });
    },
    (r) => {
      setMessage(`${r.data.code ?? code} is now ${r.data.commercialStatus}. It is unpublished and its matches are released.`);
      patch({ done: true });
      journey.reload();
    },
  );

  return (
    <Card
      kicker="Close / retire offer"
      title={<RecordLink code={j?.code ?? code} shell={shell} />}
      label={`Close or retire ${code}`}
      chips={<JourneyChips journey={j} />}
    >
      {journey.loading && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {offer.data && (
        <p className="small">
          {offer.data.label} · {inr(offer.data[pf] ?? null)}
        </p>
      )}
      {message && <Done>{message}</Done>}
      {j && !canRetireStatus(status) && !message && <Note>This offer is already {status}.</Note>}
      {j && canRetireStatus(status) && !message && (
        <>
          <Radios
            legend="Outcome"
            name={`rt-${spec.id}`}
            value={mode}
            options={[
              { value: 'inactive', label: 'Inactive (gone / unwilling)' },
              { value: 'closed', label: 'Closed (we closed a deal)' },
            ]}
            onChange={setMode}
          />
          {mode === 'inactive' && (
            <>
              {openDealId && <Note>A deal is open on this offer: cancel it or close it instead of retiring.</Note>}
              <div className="form-grid">
                <Select label="Why" value={reason} options={RETIRE_REASONS} onChange={setReason} required />
                {reason === 'already_gone' && (
                  <Input label="Last known price (₹, optional)" value={price} onChange={setPrice} inputMode="numeric" />
                )}
              </div>
              <TextArea label="Note" value={note} onChange={setNote} maxLength={1000} />
              <Note>
                {reason === 'unwilling'
                  ? 'Kept for matching intelligence and never published.'
                  : 'The offer becomes Inactive, is unpublished and its matches are released; a known price goes to market data. Matched demands are notified.'}
              </Note>
              {!canRetire && <Note>Only Supply agents, Managers and Admins retire offers.</Note>}
              <Problems errors={errors} />
              {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
              <ActionButton
                primary
                pending={act.pending}
                disabled={!canRetire || !!openDealId}
                onClick={() => {
                  const built = buildRetire({ reason, knownPrice: price, note });
                  setErrors('errors' in built ? built.errors : []);
                  if (!('errors' in built)) void act.run();
                }}
              >
                Retire as Inactive
              </ActionButton>
            </>
          )}
          {mode === 'closed' && (
            <>
              <Note>
                An offer closes through its deal: closing the deal (with the closing price) closes the offer and the demand, keeps
                the price as market data, notifies the other matched demands and releases their matches
                {lease ? ', and an 11-month lease automatically gets an Upcoming renewal offer' : ''}.
              </Note>
              {!openDealId && <Note>There is no open deal on this offer. Start one from the demand (&quot;start deal DEM-… with {code}&quot;).</Note>}
              {deal.loading && openDealId && <Loading label="Loading deal" />}
              {deal.error !== undefined && <ErrorNote error={deal.error} onRetry={deal.reload} />}
              {d && (
                <div className="row small">
                  <b className="mono">{d.code}</b> <Chip>{d.stage}</Chip>
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() =>
                      shell.addCards(
                        [{ kind: 'deal', props: { demand: d.demandId, offer: j.code ?? code, deal: d.code } }],
                        `Close ${d.code}`,
                      )
                    }
                  >
                    Close via the deal
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default RetireCard;
