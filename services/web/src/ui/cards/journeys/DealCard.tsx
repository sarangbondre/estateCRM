'use client';
// C-15 Deal card (PRD §5.4, US-25, US-27; journeys LLD §4.7). Open a deal for one demand and one offer (starts at
// Negotiation) with agreed terms; next action + follow-up date are required. For an open deal: advance the stage
// (forward only; Closed needs the closing price, and lease months for a lease), log a follow-up, or cancel (the offer
// returns to Available and the demand to Active; the failed deal is kept).
// journeys: getDemandJourney, getOfferJourney, openDeal, getDeal, updateDeal, logDealFollowUp, cancelDeal;
// crm-engine: listDemandMatches (Confirmed, to pick the offer); records: getOffer (deal type for the lease rule).
import { useState } from 'react';
import type { operations as engineOps } from '@11e/contracts/crm-engine';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import type { operations as recordsOps } from '@11e/contracts/records';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date, inr } from '../../lib/format';
import type { CardProps, ShellActions } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Input, KV, RecordLink, Select, Tabs } from '../common';
import {
  allowed,
  buildDealCreate,
  buildDealPatch,
  CANCEL_REASONS,
  followUpErrors,
  priceFieldFor,
  ROLES,
  stagesFrom,
  todayIst,
} from './logic';
import type { TermsInput } from './logic';
import { JourneyChips, Note, Problems, TextArea, useDemandJourney, useOfferJourney } from './shared';

type Deal = Ok<journeysOps['getDeal']>;
type MatchPage = Ok<engineOps['listDemandMatches']>;
type Offer = Ok<recordsOps['getOffer']>;

interface Props {
  demand: string;
  offer?: string;
  deal?: string;
}

const enc = encodeURIComponent;
const MERGE = 'application/merge-patch+json';

function Terms({ terms, onChange, lease }: { terms: TermsInput; onChange: (t: TermsInput) => void; lease: boolean }) {
  const set = (k: keyof TermsInput) => (v: string) => onChange({ ...terms, [k]: v });
  return (
    <div className="form-grid">
      {lease ? (
        <>
          <Input label="Rent / month (₹)" value={terms.rentMonthlyInr} onChange={set('rentMonthlyInr')} inputMode="numeric" />
          <Input label="Deposit (₹)" value={terms.depositInr} onChange={set('depositInr')} inputMode="numeric" />
          <Input label="Lease months" value={terms.leaseMonths} onChange={set('leaseMonths')} inputMode="numeric" />
          <Input label="Lock-in months" value={terms.lockInMonths} onChange={set('lockInMonths')} inputMode="numeric" />
          <Input label="Rent-free months" value={terms.rentFreeMonths} onChange={set('rentFreeMonths')} inputMode="decimal" />
        </>
      ) : (
        <Input label="Price (₹)" value={terms.priceInr} onChange={set('priceInr')} inputMode="numeric" />
      )}
      <Input label="Other terms" value={terms.otherTerms} onChange={set('otherTerms')} />
    </div>
  );
}

function FollowUpFields({
  nextAction,
  followUpDate,
  onAction,
  onDate,
  today,
  required = true,
}: {
  nextAction: string;
  followUpDate: string;
  onAction: (v: string) => void;
  onDate: (v: string) => void;
  today: string;
  required?: boolean;
}) {
  return (
    <div className="form-grid">
      <Input label="Next action" value={nextAction} onChange={onAction} placeholder="e.g. Send revised term sheet" required={required} />
      <Input label="Follow-up date" type="date" value={followUpDate} onChange={onDate} min={today} required={required} />
    </div>
  );
}

function OpenDeal({
  demandId,
  demand,
  offerProp,
  canAct,
  onOpened,
}: {
  demandId: string;
  demand: string;
  offerProp: string | undefined;
  canAct: boolean;
  onOpened: (d: Deal) => void;
}) {
  const today = todayIst();
  const offerJourney = useOfferJourney(offerProp ?? null);
  const matches = useResource<MatchPage>(offerProp ? null : `/v1/demands/${enc(demand)}/matches`, { status: ['Confirmed'], limit: 20 });
  const singles = (matches.data?.items ?? []).filter((m) => m.status === 'Confirmed' && m.offerIds.length === 1);
  const [matchId, setMatchId] = useState<string | null>(null);
  const picked = singles.find((m) => m.id === matchId);
  const offerId = offerProp ? (offerJourney.data?.offerId ?? null) : (picked?.offerIds[0] ?? null);
  const offer = useResource<Offer>(offerId ? `/v1/offers/${enc(offerId)}` : null);
  const lease = priceFieldFor(offer.data?.dealType) === 'rentMonthlyInrMin';
  const [terms, setTerms] = useState<TermsInput>({});
  const [nextAction, setNextAction] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const build = () =>
    buildDealCreate({ demandId, offerId, matchId: picked?.id ?? null, terms, nextAction, followUpDate: followUp }, today);
  const act = useAction(
    (key) => {
      const built = build();
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<Deal>('POST', '/v1/deals', { body: built.body, idempotencyKey: key });
    },
    (r) => onOpened(r.data),
  );
  return (
    <>
      {offerProp ? (
        <p className="small">
          Offer: <b className="mono">{offerProp}</b> {offer.data ? `· ${offer.data.label}` : ''}
        </p>
      ) : (
        <Select
          label="Offer (confirmed match)"
          value={matchId}
          options={singles.map((m) => ({ value: m.id, label: `${m.offerCodes?.[0] ?? m.code} · score ${m.score}` }))}
          onChange={setMatchId}
          placeholder={matches.loading ? 'Loading…' : singles.length ? 'Choose…' : 'No confirmed matches'}
          required
        />
      )}
      {offerJourney.error !== undefined && <ErrorNote error={offerJourney.error} onRetry={offerJourney.reload} />}
      <p className="small">
        Stage: <Chip>Negotiation</Chip> <span className="muted">(a deal starts here and moves forward only)</span>
      </p>
      <Terms terms={terms} onChange={setTerms} lease={lease} />
      <FollowUpFields nextAction={nextAction} followUpDate={followUp} onAction={setNextAction} onDate={setFollowUp} today={today} />
      <Note>Every In process deal needs a next action and a follow-up date. The offer and the demand move to In process.</Note>
      <Problems errors={errors} />
      {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
      <ActionButton
        primary
        pending={act.pending}
        disabled={!canAct}
        onClick={() => {
          const built = build();
          setErrors('errors' in built ? built.errors : []);
          if (!('errors' in built)) void act.run();
        }}
      >
        Start In process
      </ActionButton>
    </>
  );
}

const TABS = ['Update', 'Follow-up', 'Cancel'] as const;

function ExistingDeal({ id, shell, onChange }: { id: string; shell: ShellActions; onChange: () => void }) {
  const today = todayIst();
  const deal = useResource<Deal>(`/v1/deals/${enc(id)}`);
  const d = deal.data;
  const offer = useResource<Offer>(d ? `/v1/offers/${enc(d.offerId)}` : null);
  const lease = priceFieldFor(offer.data?.dealType) === 'rentMonthlyInrMin';
  const [tab, setTab] = useState<(typeof TABS)[number]>('Update');
  const [stage, setStage] = useState<string | null>(null);
  const [terms, setTerms] = useState<TermsInput>({});
  const [closing, setClosing] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState<string | null>('call');
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [cancelText, setCancelText] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const role = shell.me.role;

  const after = (m: string) => () => {
    setMessage(m);
    setErrors([]);
    deal.reload();
    onChange();
  };
  const buildPatch = () =>
    d
      ? buildDealPatch(
          { currentStage: d.stage, stage: stage ?? d.stage, nextAction, followUpDate: followUp, closingPriceInr: closing, isLease: lease, terms },
          today,
        )
      : ({ errors: ['Deal not loaded.'] } as const);
  const update = useAction(
    (key) => {
      const built = buildPatch();
      if (!d || 'errors' in built) return Promise.reject(new Error('Fix the fields first.'));
      return call<Deal>('PATCH', `/v1/deals/${enc(d.id)}`, {
        body: built.body,
        contentType: MERGE,
        ifMatch: d.version,
        idempotencyKey: key,
      });
    },
    after('Deal updated.'),
  );
  const followUpAct = useAction(
    (key) =>
      call<Deal>('POST', `/v1/deals/${enc(id)}/follow-ups`, {
        body: {
          channel: channel === 'meeting' ? 'meeting' : 'call',
          nextAction: nextAction.trim(),
          followUpDate: followUp,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        idempotencyKey: key,
      }),
    after('Follow-up logged. Both life curves reset.'),
  );
  const cancel = useAction(
    (key) =>
      call<Deal>('POST', `/v1/deals/${enc(id)}/cancel`, {
        body: {
          reasonCode: (cancelReason ?? 'other') as (typeof CANCEL_REASONS)[number]['value'],
          ...(cancelText.trim() ? { reason: cancelText.trim() } : {}),
        },
        idempotencyKey: key,
      }),
    after('Deal cancelled. The offer is back to Available and the demand to Active; the deal is kept.'),
  );

  if (!d) return deal.error !== undefined ? <ErrorNote error={deal.error} onRetry={deal.reload} /> : <Loading label="Loading deal" />;
  const open = d.stage !== 'Closed' && d.stage !== 'Cancelled';
  const terms0 = d.agreedTerms ?? {};
  const canCancel = open ? allowed(role, ROLES.cancelDeal) : d.stage === 'Closed' && allowed(role, ['Admin', 'Manager']);

  return (
    <>
      <div className="row small">
        <b className="mono">{d.code}</b>
        <Chip tone={d.stage === 'Cancelled' ? 'bad' : d.stage === 'Closed' ? 'good' : 'plain'}>{d.stage}</Chip>
        {d.overdue && <Chip tone="bad">follow-up overdue</Chip>}
      </div>
      <KV
        rows={[
          ['Next action', d.nextAction],
          ['Follow-up', d.followUpDate ? date(d.followUpDate) : null],
          ['Price', terms0.priceInr != null ? inr(terms0.priceInr) : null],
          ['Rent / month', terms0.rentMonthlyInr != null ? inr(terms0.rentMonthlyInr) : null],
          ['Lease', terms0.leaseMonths != null ? `${terms0.leaseMonths} months` : null],
          ['Closing price', d.closingPriceInr != null ? inr(d.closingPriceInr) : null],
          ['Lease renewal due', d.leaseRenewalDueOn ? date(d.leaseRenewalDueOn) : null],
        ]}
      />
      {message && <Done>{message}</Done>}
      {(open || canCancel) && <Tabs tabs={open ? TABS : (['Cancel'] as const)} value={open ? tab : 'Cancel'} onChange={setTab} label="Deal actions" />}
      {open && tab === 'Update' && (
        <>
          <Select label="Stage" value={stage ?? d.stage} options={stagesFrom(d.stage)} onChange={setStage} />
          <Terms terms={terms} onChange={setTerms} lease={lease} />
          {(stage ?? d.stage) === 'Closed' && (
            <>
              <Input label="Closing price (₹)" value={closing} onChange={setClosing} inputMode="numeric" required />
              <Note>
                Closing closes the offer (a project configuration with units left stays live) and the demand; other matched demands
                are notified and the closing price is kept as market data.
                {lease ? ' An 11-month lease schedules the Upcoming renewal offer.' : ''}
              </Note>
            </>
          )}
          <FollowUpFields
            nextAction={nextAction}
            followUpDate={followUp}
            onAction={setNextAction}
            onDate={setFollowUp}
            today={today}
            required={(stage ?? d.stage) !== 'Closed'}
          />
          <Problems errors={errors} />
          {update.error !== undefined && <ErrorNote error={update.error} onRetry={() => void update.run()} />}
          <ActionButton
            primary
            pending={update.pending}
            disabled={!allowed(role, ROLES.updateDeal)}
            onClick={() => {
              const built = buildPatch();
              setErrors('errors' in built ? [...built.errors] : []);
              if (!('errors' in built)) void update.run();
            }}
          >
            {(stage ?? d.stage) === 'Closed' ? 'Close deal' : 'Save'}
          </ActionButton>
        </>
      )}
      {open && tab === 'Follow-up' && (
        <>
          <Select label="Channel" value={channel} options={['call', 'meeting']} onChange={setChannel} />
          <TextArea label="What happened" value={note} onChange={setNote} />
          <FollowUpFields nextAction={nextAction} followUpDate={followUp} onAction={setNextAction} onDate={setFollowUp} today={today} />
          <Problems errors={errors} />
          {followUpAct.error !== undefined && <ErrorNote error={followUpAct.error} onRetry={() => void followUpAct.run()} />}
          <ActionButton
            primary
            pending={followUpAct.pending}
            disabled={!allowed(role, ROLES.dealFollowUp)}
            onClick={() => {
              const errs = followUpErrors(nextAction, followUp, today);
              setErrors(errs);
              if (!errs.length) void followUpAct.run();
            }}
          >
            Log follow-up
          </ActionButton>
        </>
      )}
      {(open ? tab === 'Cancel' : canCancel) && (
        <>
          <Select label="Why cancel" value={cancelReason} options={CANCEL_REASONS} onChange={setCancelReason} required />
          <TextArea label="Details (optional)" value={cancelText} onChange={setCancelText} maxLength={500} />
          <Note>Cancelling returns the offer to Available and the demand to Active. The failed deal is kept.</Note>
          {cancel.error !== undefined && <ErrorNote error={cancel.error} onRetry={() => void cancel.run()} />}
          {!confirmCancel ? (
            <ActionButton danger disabled={!canCancel || !cancelReason} onClick={() => setConfirmCancel(true)}>
              Cancel deal…
            </ActionButton>
          ) : (
            <div className="row">
              <span className="small">Cancel {d.code}?</span>
              <ActionButton onClick={() => setConfirmCancel(false)}>Keep it</ActionButton>
              <ActionButton danger pending={cancel.pending} onClick={() => void cancel.run()}>
                Confirm cancel
              </ActionButton>
            </div>
          )}
        </>
      )}
    </>
  );
}

function DealCard({ spec, shell, patch }: CardProps<Props>) {
  const demand = String(spec.props.demand ?? '');
  const journey = useDemandJourney(demand || null);
  const j = journey.data;
  const [dealId, setDealId] = useState<string | null>(spec.props.deal ?? null);
  const current = dealId ?? j?.openDealId ?? null;
  const canOpen = allowed(shell.me.role, ROLES.openDeal);

  return (
    <Card
      kicker="Deal"
      title={
        <>
          <RecordLink code={j?.code ?? demand} shell={shell} />
          {spec.props.offer ? (
            <>
              {' with '}
              <RecordLink code={spec.props.offer} shell={shell} />
            </>
          ) : null}
        </>
      }
      label={`Deal for ${demand}`}
      chips={<JourneyChips journey={j} />}
    >
      {journey.loading && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {j && current && <ExistingDeal id={current} shell={shell} onChange={journey.reload} />}
      {j && !current && (
        <>
          {!canOpen && <Note>Your role cannot open deals.</Note>}
          <OpenDeal
            demandId={j.demandId}
            demand={j.code ?? demand}
            offerProp={spec.props.offer}
            canAct={canOpen}
            onOpened={(d) => {
              setDealId(d.id);
              patch({ deal: d.code });
              journey.reload();
            }}
          />
        </>
      )}
    </Card>
  );
}

export default DealCard;
