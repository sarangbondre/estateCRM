'use client';
// C-10 Matches card, incl. bundles (PRD §4.5, §5.4; US-21, US-28, US-29). For a demand (best first) or an offer; with
// neither, the caller's demands with open matches (journeys queue section open_matches). Prototype .match rows with the
// .score badge (hi ≥ 80, mid below), factor chips, reconfirm / price flags; Confirm, Reject with a reason, "Why?"
// (hard filters, factor weights and points), Build bundle from 2–3 selected offers, Re-run matching (async run,
// polled). Supply agents view and may suggest bundles only; confirm / reject / re-run are disabled for them.
// crm-engine: listDemandMatches, listOfferMatches, explainMatch, confirmMatch, rejectMatch, createBundle,
// rerunDemandMatching, getMatchingRun; journeys: listMyQueueSection (open_matches).
import { useEffect, useState } from 'react';
import type { operations as engineOps } from '@11e/contracts/crm-engine';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { inr, sqft } from '../../lib/format';
import type { CardProps, ShellActions } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, RecordLink, Select, usePaged } from '../common';
import {
  buildBundle,
  bundleable,
  canBundle,
  canConfirm,
  canDecide,
  canReject,
  factorChip,
  flagChip,
  matchTitle,
  REJECT_REASONS,
  scoreBand,
  STATUS_TONE,
} from './logic';
import type { Match } from './logic';

type Explanation = Ok<engineOps['explainMatch']>;
type BundleResult = Ok<engineOps['createBundle']>;
type Run = Ok<engineOps['getMatchingRun']>;
type Accepted = Ok<engineOps['rerunDemandMatching']>;
type QueueItem = Ok<journeysOps['listMyQueueSection']>['items'][number];

interface Props {
  demand?: string;
  offer?: string;
}

const enc = encodeURIComponent;
const MAX_ROWS = 50;

function Why({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const ex = useResource<Explanation>(open ? `/v1/matches/${enc(id)}/explanation` : null);
  const e = ex.data;
  return (
    <details className="how" onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary>Why?</summary>
      {ex.loading && <Loading label="Loading explanation" />}
      {ex.error !== undefined && <ErrorNote error={ex.error} onRetry={ex.reload} />}
      {e && (
        <>
          <div>
            {(e.hardFilters ?? []).map((f) => (
              <code key={f.filter}>
                {f.passed ? '✔' : '✗'} {f.filter.replace(/_/g, ' ')}
                {f.detail ? `: ${f.detail}` : ''}
              </code>
            ))}
          </div>
          <div>
            {(e.factors ?? []).map((f) => (
              <code key={f.factor}>
                {f.factor} · weight {f.weight} × fit {Number(f.value).toFixed(2)} = {Math.round(f.points)} pts
                {f.note ? ` (${f.note})` : ''}
              </code>
            ))}
          </div>
          {(e.flags ?? []).length > 0 && (
            <div>
              {e.flags.map((f) => (
                <code key={f.flag}>
                  {flagChip(f.flag).text}
                  {f.detail ? `: ${f.detail}` : ''}
                </code>
              ))}
            </div>
          )}
          {e.bundle && (
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              Bundle: {e.bundle.grouping.replace(/_/g, ' ')} · combined {sqft(e.bundle.combinedAreaSqft)}
              {e.bundle.combinedPriceInr != null ? ` · ${inr(e.bundle.combinedPriceInr)}` : ''}
              {e.bundle.combinedRentMonthlyInr != null ? ` · ${inr(e.bundle.combinedRentMonthlyInr)}/month` : ''}
            </p>
          )}
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            Score {e.score} with weights v{e.weightsVersion}.
          </p>
        </>
      )}
    </details>
  );
}

function MatchRow({
  match,
  side,
  shell,
  selectable,
  selected,
  onSelect,
  onChanged,
}: {
  match: Match;
  side: 'demand' | 'offer';
  shell: ShellActions;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onChanged: (m: Match) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const decide = canDecide(shell.me.role);
  const confirm = useAction(
    (key) => call<Match>('POST', `/v1/matches/${enc(match.id)}/confirm`, { body: {}, idempotencyKey: key }),
    (r) => onChanged(r.data),
  );
  const reject = useAction(
    (key) =>
      call<Match>('POST', `/v1/matches/${enc(match.id)}/reject`, {
        body: { reasonCode: (reason ?? 'other') as (typeof REJECT_REASONS)[number]['value'] },
        idempotencyKey: key,
      }),
    (r) => {
      setRejecting(false);
      onChanged(r.data);
    },
  );
  const codes = match.offerCodes ?? [];
  return (
    <div className="match">
      <div className={`score ${scoreBand(match.score)}`} aria-label={`Score ${match.score} of 100`}>
        {match.score}
      </div>
      <div className="grow">
        <div className="row small" style={{ flexWrap: 'wrap' }}>
          {selectable && (
            <input
              type="checkbox"
              aria-label={`Add ${codes[0] ?? match.code} to a bundle`}
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
            />
          )}
          {side === 'demand' && codes.length > 0 ? (
            codes.map((c, i) => (
              <span key={c}>
                {i > 0 && ' + '}
                <RecordLink code={c} shell={shell} />
              </span>
            ))
          ) : side === 'offer' && match.demandCode ? (
            <RecordLink code={match.demandCode} shell={shell} />
          ) : (
            <b>{matchTitle(match, side, match.demandCode)}</b>
          )}
          {match.isBundle && <Chip tone="supply">Bundle{match.bundleCode ? ` ${match.bundleCode}` : ''}</Chip>}
          <Chip tone={STATUS_TONE[match.status] ?? 'plain'}>{match.status}</Chip>
          {(match.flags ?? []).map((f) => {
            const c = flagChip(f);
            return (
              <Chip key={f} tone={c.tone}>
                {c.text}
              </Chip>
            );
          })}
        </div>
        <div className="small muted">
          {match.code}
          {match.rank != null ? ` · #${match.rank}` : ''}
          {match.origin === 'user' ? ' · built by hand' : ''}
          {match.rejectedReason ? ` · rejected: ${match.rejectedReason.replace(/_/g, ' ')}` : ''}
          {match.closedReason ? ` · closed: ${match.closedReason.replace(/_/g, ' ')}` : ''}
        </div>
        {(match.factors ?? []).length > 0 && (
          <div className="factors">
            {(match.factors ?? []).map((f) => {
              const c = factorChip(f);
              return (
                <Chip key={f.factor} tone={c.tone}>
                  {c.text}
                </Chip>
              );
            })}
          </div>
        )}
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {canConfirm(match) && (
            <ActionButton small primary pending={confirm.pending} disabled={!decide} onClick={() => void confirm.run()}>
              Confirm
            </ActionButton>
          )}
          {canReject(match) && !rejecting && (
            <ActionButton small disabled={!decide} onClick={() => setRejecting(true)}>
              Reject
            </ActionButton>
          )}
          {rejecting && (
            <>
              <Select label="Reason" value={reason} options={REJECT_REASONS} onChange={setReason} required />
              <ActionButton small onClick={() => setRejecting(false)}>
                Cancel
              </ActionButton>
              <ActionButton small danger pending={reject.pending} disabled={!reason} onClick={() => void reject.run()}>
                Reject match
              </ActionButton>
            </>
          )}
          {match.status === 'Confirmed' && <span className="done-note">✓ Confirmed</span>}
        </div>
        {confirm.error !== undefined && <ErrorNote error={confirm.error} onRetry={() => void confirm.run()} />}
        {reject.error !== undefined && <ErrorNote error={reject.error} onRetry={() => void reject.run()} />}
        <Why id={match.id} />
      </div>
    </div>
  );
}

function MatchList({ side, subject, shell }: { side: 'demand' | 'offer'; subject: string; shell: ShellActions }) {
  const path = side === 'demand' ? `/v1/demands/${enc(subject)}/matches` : `/v1/offers/${enc(subject)}/matches`;
  const list = usePaged<Match>(path, { limit: 25 });
  const [changed, setChanged] = useState<Record<string, Match>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmBundle, setConfirmBundle] = useState(false);
  const [bundleErrors, setBundleErrors] = useState<string[]>([]);
  const [bundleDone, setBundleDone] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const role = shell.me.role;
  const decide = canDecide(role);
  const items = list.items.slice(0, MAX_ROWS).map((m) => changed[m.id] ?? m);
  const demandId = side === 'demand' ? (items[0]?.demandId ?? null) : null;

  const offerOf = new Map(items.filter(bundleable).map((m) => [m.offerIds[0] as string, m]));
  const bundle = useAction(
    (key) => {
      const built = buildBundle(demandId, selected, confirmBundle, role);
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<BundleResult>('POST', '/v1/bundles', { body: built.body, idempotencyKey: key });
    },
    (r) => {
      setBundleDone(`${r.data.bundle.code} built (${r.data.match.status}, score ${r.data.match.score}).`);
      setSelected([]);
      void list.reload();
    },
  );

  const rerun = useAction(
    (key) =>
      call<Accepted>('POST', `/v1/demands/${enc(subject)}/matching-runs`, { body: { reason: 'manual' }, idempotencyKey: key }),
    (r) => setRunId(r.data.runId),
  );
  const run = useResource<Run>(runId ? `/v1/matching-runs/${enc(runId)}` : null, undefined, runId ? 2000 : undefined);
  const runStatus = run.data?.status;
  useEffect(() => {
    if (runStatus === 'done' || runStatus === 'failed') {
      setRunId(null);
      void list.reload();
    }
  }, [runStatus]);

  return (
    <>
      {list.loading && items.length === 0 && <Loading label="Loading matches" />}
      {list.error !== undefined && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
      {!list.loading && !list.error && items.length === 0 && (
        <p className="small muted">
          No live matches.{' '}
          {side === 'demand' && (
            <button type="button" className="btn sm" onClick={() => shell.addCards([{ kind: 'sourcing', props: { demand: subject } }])}>
              Raise sourcing request
            </button>
          )}
        </p>
      )}
      {items.map((m) => (
        <MatchRow
          key={m.id}
          match={m}
          side={side}
          shell={shell}
          selectable={side === 'demand' && canBundle(role) && bundleable(m)}
          selected={selected.includes(m.offerIds[0] ?? '')}
          onSelect={(on) => {
            const id = m.offerIds[0];
            if (!id) return;
            setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));
          }}
          onChanged={(u) => setChanged((c) => ({ ...c, [u.id]: u }))}
        />
      ))}
      {list.hasMore && items.length < MAX_ROWS && (
        <button type="button" className="btn sm" onClick={() => void list.more()}>
          Load more
        </button>
      )}
      {side === 'demand' && (
        <div className="card-f" style={{ flexWrap: 'wrap' }}>
          {canBundle(role) && (
            <>
              <span className="small">
                Bundle: {selected.length ? selected.map((id) => offerOf.get(id)?.offerCodes?.[0] ?? id.slice(0, 8)).join(' + ') : 'select 2–3 offers'}
              </span>
              {decide && <Checkbox label="Confirm immediately" checked={confirmBundle} onChange={setConfirmBundle} />}
              <ActionButton
                small
                pending={bundle.pending}
                disabled={selected.length < 2}
                onClick={() => {
                  const built = buildBundle(demandId, selected, confirmBundle, role);
                  setBundleErrors('errors' in built ? built.errors : []);
                  if (!('errors' in built)) void bundle.run();
                }}
              >
                Build bundle
              </ActionButton>
            </>
          )}
          <span className="grow" />
          <ActionButton small pending={rerun.pending || runId !== null} disabled={!decide} onClick={() => void rerun.run()}>
            {runId ? `Matching ${runStatus ?? 'queued'}…` : 'Re-run matching'}
          </ActionButton>
          <button type="button" className="btn sm" onClick={() => shell.addCards([{ kind: 'proposal', props: { demand: subject } }])}>
            Build proposal from confirmed
          </button>
        </div>
      )}
      {bundleErrors.length > 0 && (
        <div role="alert" className="small err-note">
          {bundleErrors.join(' ')}
        </div>
      )}
      {bundle.error !== undefined && <ErrorNote error={bundle.error} onRetry={() => void bundle.run()} />}
      {bundleDone && <Done>{bundleDone}</Done>}
      {rerun.error !== undefined && <ErrorNote error={rerun.error} onRetry={() => void rerun.run()} />}
      {run.data?.status === 'failed' && <span className="err-note">Matching run failed{run.data.error ? `: ${run.data.error}` : ''}.</span>}
      {!decide && <p className="small muted">Your role can view matches{canBundle(role) ? ' and suggest bundles' : ''}; confirming is for the demand team.</p>}
    </>
  );
}

function OpenMatchesQueue({ shell }: { shell: ShellActions }) {
  const q = usePaged<QueueItem>('/v1/queues/me/sections/open_matches', { limit: 25 });
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.items.slice(0, MAX_ROWS);
  return (
    <>
      {q.loading && rows.length === 0 && <Loading label="Loading demands with open matches" />}
      {q.error !== undefined && <ErrorNote error={q.error} onRetry={() => void q.reload()} />}
      {!q.loading && !q.error && rows.length === 0 && <p className="small muted">No demands with matches to confirm.</p>}
      {rows.map((it) => {
        const demand = it.subjectType === 'demand' ? it.subjectCode : (it.demandId ?? it.subjectCode);
        return (
          <div key={it.id}>
            <div className="qitem2">
              <div className="grow">
                <RecordLink code={it.subjectCode} shell={shell} /> <span>{it.summary ?? ''}</span>
                <div className="small muted">{it.reasonRef ?? 'Matches to confirm'}</div>
              </div>
              {it.overdue && <Chip tone="bad">overdue</Chip>}
              <button type="button" className="btn sm" aria-expanded={open === it.id} onClick={() => setOpen(open === it.id ? null : it.id)}>
                {open === it.id ? 'Hide' : 'Show matches'}
              </button>
            </div>
            {open === it.id && <MatchList side="demand" subject={demand} shell={shell} />}
          </div>
        );
      })}
      {q.hasMore && rows.length < MAX_ROWS && (
        <button type="button" className="btn sm" onClick={() => void q.more()}>
          Load more
        </button>
      )}
    </>
  );
}

function MatchesCard({ spec, shell }: CardProps<Props>) {
  const demand = spec.props.demand ? String(spec.props.demand) : null;
  const offer = spec.props.offer ? String(spec.props.offer) : null;
  const subject = demand ?? offer;
  return (
    <Card
      kicker="Matches"
      title={subject ? <RecordLink code={subject} shell={shell} /> : 'Demands with matches to confirm'}
      label={subject ? `Matches for ${subject}` : 'Matches to confirm'}
    >
      {demand && <MatchList side="demand" subject={demand} shell={shell} />}
      {!demand && offer && <MatchList side="offer" subject={offer} shell={shell} />}
      {!subject && <OpenMatchesQueue shell={shell} />}
    </Card>
  );
}

export default MatchesCard;
