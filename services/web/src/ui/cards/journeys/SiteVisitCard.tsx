'use client';
// C-14 Site visit card (PRD §5.4, US-24; journeys LLD §4.7). Schedule: date/time (IST), offers (from the demand's live
// matches: journeys rejects offers without one, 409 offer-not-matched), attendees → schedule. Afterwards: outcome,
// visited offers, preferred offer → complete; completion resets both life curves (no-shows spare the absent side).
// journeys: getDemandJourney, listSiteVisits, scheduleSiteVisit, completeSiteVisit; crm-engine: listDemandMatches;
// web: listUsers.
import { useState } from 'react';
import type { operations as engineOps } from '@11e/contracts/crm-engine';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input, RecordLink, Select } from '../common';
import { allowed, buildVisit, ROLES, VISIT_OUTCOMES, visitResetNote } from './logic';
import type { VisitOutcome } from './logic';
import { JourneyChips, Note, Problems, TextArea, useDemandJourney, useUsers } from './shared';

type Visit = Ok<journeysOps['getSiteVisit']>;
type VisitPage = Ok<journeysOps['listSiteVisits']>;
type MatchPage = Ok<engineOps['listDemandMatches']>;

interface Props {
  demand?: string;
  visit?: string;
}

const enc = encodeURIComponent;

/** Offer id → display code, from the demand's matches (bundles contribute each offer). */
function offerCodes(matches: MatchPage | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of matches?.items ?? []) {
    m.offerIds.forEach((id, i) => {
      if (!map.has(id)) map.set(id, m.offerCodes?.[i] ?? id.slice(0, 8));
    });
  }
  return map;
}

function CompleteVisit({
  visit,
  codes,
  canAct,
  onDone,
}: {
  visit: Visit;
  codes: Map<string, string>;
  canAct: boolean;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState<VisitOutcome | null>(null);
  const [visited, setVisited] = useState<string[]>(visit.offerIds);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const act = useAction(
    (key) =>
      call<Visit>('POST', `/v1/site-visits/${enc(visit.id)}/complete`, {
        body: {
          outcome: outcome as VisitOutcome,
          visitedOfferIds: visited,
          ...(preferred ? { preferredOfferId: preferred } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
        idempotencyKey: key,
      }),
    onDone,
  );
  return (
    <div className="card-b" style={{ borderTop: '1px dashed var(--line)' }}>
      <div className="row small">
        <b className="mono">{visit.code}</b> <span>{date(visit.scheduledAt, true)}</span>
        <Chip>{visit.status}</Chip>
      </div>
      <div className="form-grid">
        <Select label="Outcome" value={outcome} options={VISIT_OUTCOMES} onChange={(v) => setOutcome(v as VisitOutcome | null)} required />
        <Select
          label="Preferred offer (optional)"
          value={preferred}
          options={visited.map((id) => ({ value: id, label: codes.get(id) ?? id.slice(0, 8) }))}
          onChange={setPreferred}
        />
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">Visited</legend>
        {visit.offerIds.map((id) => (
          <Checkbox
            key={id}
            label={codes.get(id) ?? id.slice(0, 8)}
            checked={visited.includes(id)}
            onChange={(on) => setVisited((v) => (on ? [...v, id] : v.filter((x) => x !== id)))}
          />
        ))}
      </fieldset>
      <TextArea label="Visit notes" value={notes} onChange={setNotes} />
      <Note>{visitResetNote(outcome)}</Note>
      {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
      <ActionButton primary pending={act.pending} disabled={!canAct || !outcome} onClick={() => void act.run()}>
        Record outcome
      </ActionButton>
    </div>
  );
}

function SiteVisitCard({ spec, shell, patch }: CardProps<Props>) {
  const [demandInput, setDemandInput] = useState('');
  const [demand, setDemand] = useState(String(spec.props.demand ?? ''));
  const journey = useDemandJourney(demand || null);
  const j = journey.data;
  const matches = useResource<MatchPage>(demand ? `/v1/demands/${enc(demand)}/matches` : null, { limit: 50 });
  const visits = useResource<VisitPage>(j ? '/v1/site-visits' : null, j ? { demandId: j.demandId, status: 'Scheduled', limit: 10 } : undefined);
  const users = useUsers();
  const codes = offerCodes(matches.data);
  const canAct = allowed(shell.me.role, ROLES.siteVisit);

  const [offers, setOffers] = useState<string[]>([]);
  const [when, setWhen] = useState('');
  const [attendees, setAttendees] = useState<string[]>([shell.me.userId]);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [scheduled, setScheduled] = useState<Visit | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);

  const build = () =>
    j
      ? buildVisit({ demandId: j.demandId, offerIds: offers, scheduledLocal: when, attendeeUserIds: attendees, notes })
      : ({ errors: ['Choose the demand first.'] } as const);
  const act = useAction(
    (key) => {
      const built = build();
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<Visit>('POST', '/v1/site-visits', { body: built.body, idempotencyKey: key });
    },
    (r) => {
      setScheduled(r.data);
      patch({ visit: r.data.code });
      visits.reload();
    },
  );

  if (!demand)
    return (
      <Card kicker="Site visit" title="Which demand?">
        <div className="row">
          <Input label="Demand code" value={demandInput} onChange={setDemandInput} placeholder="DEM-000127" />
          <button type="button" className="btn" onClick={() => setDemand(demandInput.trim().toUpperCase())} disabled={!demandInput.trim()}>
            Continue
          </button>
        </div>
      </Card>
    );

  const offerIds = [...codes.keys()];
  const scheduledList = visits.data?.items ?? [];

  return (
    <Card
      kicker="Site visit"
      title={<RecordLink code={j?.code ?? demand} shell={shell} />}
      label={`Site visit for ${demand}`}
      chips={<JourneyChips journey={j} />}
    >
      {journey.loading && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {!canAct && <Note>Your role cannot schedule visits.</Note>}
      {scheduled ? (
        <Done>
          {scheduled.code} scheduled for {date(scheduled.scheduledAt, true)} with {scheduled.offerIds.length} offer(s). Attendees are
          notified.
        </Done>
      ) : (
        <>
          <div className="qh">Schedule</div>
          <Input label="Date and time (IST)" type="datetime-local" value={when} onChange={setWhen} required />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted">Offers (matched to this demand)</legend>
            {matches.loading && <Loading label="Loading matches" />}
            {matches.error !== undefined && <ErrorNote error={matches.error} onRetry={matches.reload} />}
            {!matches.loading && offerIds.length === 0 && <p className="small muted">No live matches: confirm a match first.</p>}
            {offerIds.slice(0, 50).map((id) => (
              <Checkbox
                key={id}
                label={codes.get(id) ?? id}
                checked={offers.includes(id)}
                onChange={(on) => setOffers((o) => (on ? [...o, id] : o.filter((x) => x !== id)))}
              />
            ))}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted">Attendees</legend>
            {(users.data?.items ?? []).slice(0, 50).map((u) => (
              <Checkbox
                key={u.userId}
                label={`${u.displayName} · ${u.role}`}
                checked={attendees.includes(u.userId)}
                onChange={(on) => setAttendees((a) => (on ? [...a, u.userId] : a.filter((x) => x !== u.userId)))}
              />
            ))}
          </fieldset>
          <TextArea label="Notes" value={notes} onChange={setNotes} />
          <Problems errors={errors} />
          {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
          <ActionButton
            primary
            pending={act.pending}
            disabled={!canAct || !j}
            onClick={() => {
              const built = build();
              setErrors('errors' in built ? [...built.errors] : []);
              if (!('errors' in built)) void act.run();
            }}
          >
            Schedule visit
          </ActionButton>
        </>
      )}
      {scheduledList.length > 0 && <div className="qh">Afterwards: record the outcome</div>}
      {scheduledList.map((v) => (
        <CompleteVisit
          key={v.id}
          visit={v}
          codes={codes}
          canAct={canAct}
          onDone={() => {
            setCompleted(v.code);
            visits.reload();
            journey.reload();
          }}
        />
      ))}
      {completed && <Done>{completed} completed. Life curves reset as described.</Done>}
    </Card>
  );
}

export default SiteVisitCard;
