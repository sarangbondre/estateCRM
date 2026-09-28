'use client';
// C-11 Sourcing request card (PRD §4.4 handoffs, §5.4; US-22; journeys LLD §4.5). Create an SRQ for a qualified demand:
// assignee (Supply agents from web's user directory), due date, priority, optional anonymous demand post → Confirm.
// The post itself belongs to listings: once the demand is in Sourcing the card shows its state and lets the agent post
// or take it down (it also comes down automatically when a match is confirmed).
// journeys: getDemandJourney, createSourcingRequest; listings: getDemandPost, setDemandPost; web: listUsers.
import { useState } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import type { operations as listingsOps } from '@11e/contracts/listings';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input, RecordLink, Select } from '../common';
import { addDays, allowed, buildSourcing, PRIORITIES, ROLES, todayIst } from './logic';
import { JourneyChips, Note, Problems, TextArea, UserSelect, useDemandJourney } from './shared';

type Srq = Ok<journeysOps['createSourcingRequest']>;
type DemandPost = Ok<listingsOps['getDemandPost']>;

interface Props {
  demand: string;
  done?: boolean;
  srq?: string;
}

const enc = encodeURIComponent;

function DemandPostToggle({ demand, canSet }: { demand: string; canSet: boolean }) {
  const post = useResource<DemandPost>(`/v1/demands/${enc(demand)}/demand-post`);
  const level = post.data?.level ?? null;
  const next = level === 'Anonymous' ? 'Private' : 'Anonymous';
  const act = useAction(
    () =>
      call<DemandPost>('PUT', `/v1/demands/${enc(demand)}/demand-post`, {
        body: { level: next },
        ...(post.data?.version != null ? { ifMatch: post.data.version } : {}),
      }),
    () => post.reload(),
  );
  if (post.loading && !post.data) return <Loading label="Loading demand post" />;
  if (post.error !== undefined) return <ErrorNote error={post.error} onRetry={post.reload} />;
  const allowedLevels: readonly string[] = post.data?.allowedLevels ?? [];
  return (
    <div className="row small">
      <span>Anonymous demand post:</span>
      <Chip tone={level === 'Anonymous' ? 'good' : 'plain'}>{level === 'Anonymous' ? 'Posted (Anonymous)' : 'Not posted'}</Chip>
      <ActionButton small pending={act.pending} disabled={!canSet || !allowedLevels.includes(next)} onClick={() => void act.run()}>
        {next === 'Anonymous' ? 'Post anonymously' : 'Take down'}
      </ActionButton>
      {act.error !== undefined && <ErrorNote error={act.error} />}
    </div>
  );
}

function SourcingCard({ spec, shell, patch }: CardProps<Props>) {
  const demand = String(spec.props.demand ?? '');
  const journey = useDemandJourney(demand || null);
  const today = todayIst();
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState(addDays(today, 3));
  const [priority, setPriority] = useState<string | null>('Normal');
  const [anon, setAnon] = useState(true);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<Srq | null>(null);
  const j = journey.data;
  const canAct = allowed(shell.me.role, ROLES.sourcing);
  const done = spec.props.done === true || created !== null;

  const act = useAction(
    (key) => {
      if (!j) return Promise.reject(new Error('Demand not loaded.'));
      const built = buildSourcing(
        { demandId: j.demandId, assigneeUserId: assignee, dueDate: due, priority, postAnonymously: anon, notes },
        today,
      );
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<Srq>('POST', '/v1/sourcing-requests', { body: built.body, idempotencyKey: key });
    },
    (r) => {
      setCreated(r.data);
      patch({ done: true, srq: r.data.code });
      journey.reload();
    },
  );

  const confirm = () => {
    const built = j
      ? buildSourcing({ demandId: j.demandId, assigneeUserId: assignee, dueDate: due, priority, postAnonymously: anon }, today)
      : { errors: ['Demand not loaded.'] };
    setErrors('errors' in built ? built.errors : []);
    if (!('errors' in built)) void act.run();
  };

  return (
    <Card
      kicker="Sourcing request"
      title={<RecordLink code={j?.code ?? demand} shell={shell} />}
      label={`Sourcing request for ${demand}`}
      chips={<JourneyChips journey={j} />}
      footer={
        done ? (
          <>
            <Done>
              {created ? `${created.code} sent to the supply team, due ${date(created.dueDate)} (${created.priority})` : `Sourcing request ${spec.props.srq ?? ''} created`}.
            </Done>
          </>
        ) : (
          <>
            <span className="grow" />
            <ActionButton primary pending={act.pending} disabled={!canAct || !j} onClick={confirm}>
              Confirm
            </ActionButton>
          </>
        )
      }
    >
      {journey.loading && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {!done && (
        <>
          <div className="form-grid">
            <UserSelect label="Assign to" role="Supply agent" value={assignee} onChange={setAssignee} required />
            <Input label="Due" type="date" value={due} onChange={setDue} min={today} required />
            <Select label="Priority" value={priority} options={PRIORITIES} onChange={setPriority} required />
          </div>
          <Checkbox label="Post the demand anonymously on the website (Wants label, rounded budget band)" checked={anon} onChange={setAnon} />
          <TextArea label="Notes for the supply team" value={notes} onChange={setNotes} />
          <Note>
            The demand moves to Sourcing (unless it already has a confirmed match) and the request lands in the assignee&apos;s
            queue. The anonymous post comes down once a match is confirmed.
          </Note>
          {j && !j.qualifiedAt && <Note>This demand is not qualified yet; qualify it first.</Note>}
          {!canAct && <Note>Your role cannot raise sourcing requests.</Note>}
          <Problems errors={errors} />
          {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
        </>
      )}
      {done && j && <DemandPostToggle demand={j.code ?? demand} canSet={allowed(shell.me.role, ROLES.demandPost)} />}
    </Card>
  );
}

export default SourcingCard;
