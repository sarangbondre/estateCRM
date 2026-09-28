'use client';
// C-09 Qualify demand card (PRD §5.4, US-20; journeys LLD §4.5). Checklist: decision maker reached, budget confirmed,
// timing confirmed, agrees to work with 11 Estates → Mark qualified (all four required). Qualifying resets the life
// curve; crm-engine then runs the inventory check, so the card offers Matches (C-10) or a sourcing request (C-11).
// journeys: getDemandJourney, qualifyDemand.
import { useState } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import { call } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date } from '../../lib/format';
import type { CardProps } from '../../shell/types';
import { ActionButton, Card, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input, RecordLink } from '../common';
import { cardFor } from '../registry';
import { allowed, buildQualify, canQualify, CHECKLIST, ROLES } from './logic';
import type { Checklist } from './logic';
import { JourneyChips, Note, TextArea, useDemandJourney } from './shared';

interface Props {
  demand: string;
  done?: boolean;
}

const enc = encodeURIComponent;
const EMPTY: Checklist = { decisionMakerReached: false, budgetConfirmed: false, timingConfirmed: false, agreesToWork: false };

function QualifyCard({ spec, shell, patch }: CardProps<Props>) {
  const demand = String(spec.props.demand ?? '');
  const journey = useDemandJourney(demand || null);
  const [checks, setChecks] = useState<Checklist>(EMPTY);
  const [notes, setNotes] = useState('');
  const [showMatches, setShowMatches] = useState(false);
  const j = journey.data;
  const already = !!j?.qualifiedAt;
  const done = spec.props.done === true || already;
  const exited = !!j?.exit;
  const canAct = allowed(shell.me.role, ROLES.qualify);

  const act = useAction(
    (key) => {
      const body = buildQualify(checks, notes);
      if (!body) return Promise.reject(new Error('All four checklist items must be confirmed.'));
      return call<Ok<journeysOps['qualifyDemand']>>('POST', `/v1/demands/${enc(demand)}/qualify`, {
        body,
        idempotencyKey: key,
      });
    },
    () => {
      patch({ done: true });
      journey.reload();
    },
  );

  const Matches = cardFor('matches');
  const matchesProps = { demand: j?.code ?? demand };

  return (
    <Card
      kicker="Qualify"
      title={<RecordLink code={j?.code ?? demand} shell={shell} />}
      label={`Qualify ${demand}`}
      chips={<JourneyChips journey={j} />}
      footer={
        done ? (
          <>
            <Done>Qualified{j?.qualifiedAt ? ` on ${date(j.qualifiedAt)}` : ''}. Inventory check runs.</Done>
            <span className="grow" />
            <button type="button" className="btn sm primary" onClick={() => setShowMatches((v) => !v)} aria-expanded={showMatches}>
              {showMatches ? 'Hide matches' : 'Matches'}
            </button>
            <button type="button" className="btn sm" onClick={() => shell.addCards([{ kind: 'sourcing', props: { demand: matchesProps.demand } }])}>
              Sourcing request
            </button>
          </>
        ) : (
          <>
            <span className="grow" />
            <ActionButton
              primary
              pending={act.pending}
              disabled={!canQualify(checks) || !canAct || exited || !j}
              onClick={() => void act.run()}
            >
              Mark qualified
            </ActionButton>
          </>
        )
      }
    >
      {journey.loading && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {!done && (
        <>
          {CHECKLIST.map(({ key, label }) => (
            <Checkbox key={key} label={label} checked={checks[key]} onChange={(v) => setChecks({ ...checks, [key]: v })} />
          ))}
          <Input
            label="Decision maker (optional)"
            value={checks.decisionMakerNote ?? ''}
            onChange={(v) => setChecks({ ...checks, decisionMakerNote: v })}
            placeholder="Name or title"
          />
          <TextArea label="Notes" value={notes} onChange={setNotes} />
          <Note>Qualifying resets the life curve, moves the demand to Active and runs the inventory check.</Note>
          {exited && <Note>This demand has exited ({j?.exit?.type}); reactivate it first.</Note>}
          {!canAct && <Note>Your role cannot qualify demands.</Note>}
          {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
        </>
      )}
      {done && showMatches && <Matches spec={{ id: `${spec.id}-m`, kind: 'matches', props: matchesProps }} shell={shell} patch={() => {}} />}
    </Card>
  );
}

export default QualifyCard;
