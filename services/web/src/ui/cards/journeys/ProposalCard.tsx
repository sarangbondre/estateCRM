'use client';
// C-13 Proposal card (PRD §5.4, US-23, D-11; journeys LLD §4.6). Pick options from the demand's confirmed matches →
// preview → create (content snapshot is built off the request path: Preparing → Ready) → Generate PDF (queued, polled)
// and/or a private share link (14 days, shown once) → Mark sent (logs date and channel; the system sends nothing) →
// client feedback per option. "Maybe" (questionnaire C3) is shown but not recordable yet (LLD gap G-13).
// journeys: getDemandJourney, listProposals, createProposal, getProposal, generateProposalPdf, getProposalPdf,
// createProposalShareLink, markProposalSent, recordProposalFeedback; crm-engine: listDemandMatches (Confirmed).
import { useEffect, useState } from 'react';
import type { operations as engineOps } from '@11e/contracts/crm-engine';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { date, relative } from '../../lib/format';
import type { CardProps, ShellActions } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Field, Loading, useAction } from '../Card';
import { Checkbox, RecordLink, Select } from '../common';
import { allowed, buildFeedback, buildProposal, FEEDBACK, ROLES, SENT_CHANNELS } from './logic';
import type { FeedbackChoice } from './logic';
import { JourneyChips, Note, Problems, TextArea, useDemandJourney } from './shared';

type Proposal = Ok<journeysOps['getProposal']>;
type ProposalPage = Ok<journeysOps['listProposals']>;
type Pdf = Ok<journeysOps['getProposalPdf']>;
type ShareLink = Ok<journeysOps['createProposalShareLink']>;
type MatchPage = Ok<engineOps['listDemandMatches']>;
type Match = MatchPage['items'][number];

interface Props {
  demand: string;
  proposal?: string;
}

const enc = encodeURIComponent;

function optionLabel(matchId: string, offerIds: readonly string[], matches: readonly Match[]): string {
  const m = matches.find((x) => x.id === matchId);
  if (m?.offerCodes?.length) return `${m.isBundle ? 'Bundle ' : ''}${m.offerCodes.join(' + ')}`;
  return `${offerIds.length} offer${offerIds.length === 1 ? '' : 's'}`;
}

function Builder({
  demandId,
  matches,
  canAct,
  onCreated,
}: {
  demandId: string;
  matches: readonly Match[];
  canAct: boolean;
  onCreated: (p: Proposal) => void;
}) {
  const [picked, setPicked] = useState<string[]>(() => matches.slice(0, 5).map((m) => m.id));
  const [cover, setCover] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  const act = useAction(
    (key) => {
      const built = buildProposal(demandId, picked, cover);
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<Proposal>('POST', '/v1/proposals', { body: built.body, idempotencyKey: key });
    },
    (r) => onCreated(r.data),
  );
  if (!matches.length)
    return <Note>No confirmed matches yet. Confirm matches first (a proposal only uses confirmed matches).</Note>;
  const chosen = picked.map((id) => matches.find((m) => m.id === id)).filter((m): m is Match => !!m);
  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">Options (confirmed matches)</legend>
        {matches.slice(0, 20).map((m) => (
          <Checkbox
            key={m.id}
            label={`${m.isBundle ? 'Bundle ' : ''}${(m.offerCodes ?? []).join(' + ') || m.code} · score ${m.score}`}
            checked={picked.includes(m.id)}
            onChange={(on) => toggle(m.id, on)}
          />
        ))}
      </fieldset>
      {chosen.length > 0 && (
        <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
          <table>
            <caption className="small muted">Preview: building names, areas, price and photos are added from the records.</caption>
            <thead>
              <tr>
                <th>Option</th>
                <th>Offers</th>
                <th className="n">Score</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {chosen.map((m, i) => (
                <tr key={m.id}>
                  <td>{i + 1}</td>
                  <td>{(m.offerCodes ?? []).join(' + ') || m.code}</td>
                  <td className="n">{m.score}</td>
                  <td>{m.flags.length ? m.flags.join(', ').replace(/_/g, ' ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TextArea label="Cover note (optional)" value={cover} onChange={setCover} />
      <Note>Proposals never include owner or broker contacts. Footer: 11 Estates MahaRERA number.</Note>
      <Problems errors={errors} />
      {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
      <div className="row">
        <span className="grow" />
        <ActionButton
          primary
          pending={act.pending}
          disabled={!canAct}
          onClick={() => {
            const built = buildProposal(demandId, picked, cover);
            setErrors('errors' in built ? built.errors : []);
            if (!('errors' in built)) void act.run();
          }}
        >
          Create proposal
        </ActionButton>
      </div>
    </>
  );
}

function PdfBox({ proposal, canAct }: { proposal: Proposal; canAct: boolean }) {
  const [asked, setAsked] = useState(false);
  const base = `/v1/proposals/${enc(proposal.id)}/pdf`;
  const initial = proposal.pdf?.status ?? 'none';
  const watching = asked || initial === 'queued' || initial === 'ready';
  const pdf = useResource<Pdf>(watching ? base : null, undefined, asked || initial === 'queued' ? 3000 : undefined);
  const status = pdf.data?.status ?? initial;
  const gen = useAction(
    (key) => call('POST', base, { idempotencyKey: key }),
    () => setAsked(true),
  );
  const stillQueued = status === 'queued';
  return (
    <div className="row small">
      <span>PDF:</span>
      <Chip tone={status === 'ready' ? 'good' : status === 'failed' ? 'bad' : 'plain'}>{status}</Chip>
      {status === 'ready' && pdf.data?.url ? (
        <a className="btn sm" href={pdf.data.url} target="_blank" rel="noreferrer noopener">
          Download PDF
        </a>
      ) : null}
      {!stillQueued && (
        <ActionButton small pending={gen.pending} disabled={!canAct || proposal.status === 'Preparing'} onClick={() => void gen.run()}>
          {status === 'ready' ? 'Regenerate PDF' : 'Generate PDF'}
        </ActionButton>
      )}
      {stillQueued && <span className="muted">Generating…</span>}
      {status === 'ready' && <span className="faint">download link valid 5 minutes</span>}
      {gen.error !== undefined && <ErrorNote error={gen.error} />}
      {pdf.error !== undefined && <ErrorNote error={pdf.error} onRetry={pdf.reload} />}
    </div>
  );
}

function ShareBox({ proposal, canAct, onChange }: { proposal: Proposal; canAct: boolean; onChange: () => void }) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const act = useAction(
    (key) =>
      call<ShareLink>('POST', `/v1/proposals/${enc(proposal.id)}/share-link`, {
        body: { expiresInDays: 14 },
        idempotencyKey: key,
      }),
    (r) => {
      setLink(r.data);
      onChange();
    },
  );
  const active = proposal.activeLink ?? null;
  return (
    <div>
      <div className="row small">
        <span>Share link:</span>
        {active ? (
          <Chip tone="good">
            active until {date(active.expiresAt)} · {active.opens ?? 0} open{active.opens === 1 ? '' : 's'}
            {active.lastOpenedAt ? ` · last ${relative(active.lastOpenedAt)}` : ''}
          </Chip>
        ) : (
          <Chip>none</Chip>
        )}
        <ActionButton small pending={act.pending} disabled={!canAct || proposal.status === 'Preparing'} onClick={() => void act.run()}>
          {active ? 'Replace link (14 days)' : 'Create share link (14 days)'}
        </ActionButton>
      </div>
      {link && (
        <div className="row">
          <Field label="Private link (shown once)">
            {(id) => <input id={id} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />}
          </Field>
          <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(link.url)}>
            Copy
          </button>
        </div>
      )}
      {act.error !== undefined && <ErrorNote error={act.error} />}
    </div>
  );
}

function SentBox({ proposal, canAct, onChange }: { proposal: Proposal; canAct: boolean; onChange: () => void }) {
  const [channel, setChannel] = useState<string | null>('WhatsApp');
  const act = useAction(
    (key) =>
      call<Proposal>('POST', `/v1/proposals/${enc(proposal.id)}/mark-sent`, {
        body: { channel: (channel ?? 'Other') as (typeof SENT_CHANNELS)[number] },
        idempotencyKey: key,
      }),
    onChange,
  );
  if (proposal.status === 'Sent')
    return (
      <Done>
        Sent{proposal.sentChannel ? ` by ${proposal.sentChannel}` : ''}
        {proposal.sentAt ? ` on ${date(proposal.sentAt)}` : ''}.
      </Done>
    );
  return (
    <div className="row">
      <Select label="Sent by" value={channel} options={SENT_CHANNELS} onChange={setChannel} />
      <ActionButton primary pending={act.pending} disabled={!canAct || proposal.status !== 'Ready' || !channel} onClick={() => void act.run()}>
        Mark sent
      </ActionButton>
      <span className="small muted">Logs the date and channel. The system sends nothing.</span>
      {act.error !== undefined && <ErrorNote error={act.error} />}
    </div>
  );
}

function FeedbackBox({
  proposal,
  matches,
  canAct,
  onChange,
}: {
  proposal: Proposal;
  matches: readonly Match[];
  canAct: boolean;
  onChange: () => void;
}) {
  const [choice, setChoice] = useState<Record<number, FeedbackChoice | null>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<number[]>([]);
  const entries = proposal.options.map((o) => ({
    position: o.position,
    feedback: choice[o.position] ?? null,
    note: notes[o.position] ?? '',
  }));
  const act = useAction(
    (key) => {
      const built = buildFeedback(entries);
      if ('errors' in built) return Promise.reject(new Error(built.errors.join(' ')));
      return call<Proposal>('POST', `/v1/proposals/${enc(proposal.id)}/feedback`, { body: built.body, idempotencyKey: key });
    },
    onChange,
  );
  return (
    <div>
      <div className="qh">Client feedback</div>
      {proposal.options.map((o) => (
        <div key={o.position} className="form-grid">
          <Select
            label={`Option ${o.position}: ${optionLabel(o.matchId, o.offerIds, matches)}${o.feedback ? ` (recorded: ${o.feedback.replace('_', ' ')})` : ''}`}
            value={choice[o.position] ?? null}
            options={FEEDBACK}
            onChange={(v) => setChoice({ ...choice, [o.position]: v as FeedbackChoice | null })}
          />
          <TextArea
            label={`Note on option ${o.position}`}
            value={notes[o.position] ?? ''}
            maxLength={500}
            onChange={(v) => setNotes({ ...notes, [o.position]: v })}
          />
        </div>
      ))}
      <Problems errors={errors} />
      {skipped.length > 0 && (
        <Note>Option(s) {skipped.join(', ')} marked Maybe were not recorded (the service accepts Liked / Rejected / Wants a visit).</Note>
      )}
      {act.error !== undefined && <ErrorNote error={act.error} onRetry={() => void act.run()} />}
      <ActionButton
        pending={act.pending}
        disabled={!canAct}
        onClick={() => {
          const built = buildFeedback(entries);
          setErrors('errors' in built ? built.errors : []);
          setSkipped('errors' in built ? [] : built.skipped);
          if (!('errors' in built)) void act.run();
        }}
      >
        Save feedback
      </ActionButton>
    </div>
  );
}

function ProposalView({
  id,
  matches,
  canAct,
  shell,
  demand,
}: {
  id: string;
  matches: readonly Match[];
  canAct: boolean;
  shell: ShellActions;
  demand: string;
}) {
  const [preparing, setPreparing] = useState(true);
  const p = useResource<Proposal>(`/v1/proposals/${enc(id)}`, undefined, preparing ? 3000 : undefined);
  const data = p.data;
  const status = data?.status;
  useEffect(() => {
    if (status && status !== 'Preparing') setPreparing(false);
  }, [status]);
  if (!data) return p.error !== undefined ? <ErrorNote error={p.error} onRetry={p.reload} /> : <Loading label="Loading proposal" />;
  return (
    <div>
      <div className="row small">
        <b className="mono">{data.code}</b>
        <Chip tone={data.status === 'Failed' ? 'bad' : data.status === 'Preparing' ? 'warn' : 'good'}>{data.status}</Chip>
        <span className="muted">{data.options.length} option(s)</span>
      </div>
      {data.status === 'Preparing' && <Note>Building the content snapshot from the records…</Note>}
      {data.status === 'Failed' && <Note>The snapshot could not be built. Create a new proposal or try later.</Note>}
      {data.status !== 'Failed' && (
        <>
          <PdfBox proposal={data} canAct={canAct} />
          <ShareBox proposal={data} canAct={canAct} onChange={p.reload} />
          <SentBox proposal={data} canAct={canAct} onChange={p.reload} />
          {data.status === 'Sent' && <FeedbackBox proposal={data} matches={matches} canAct={canAct} onChange={p.reload} />}
          {data.status === 'Sent' && (
            <div className="row">
              <button type="button" className="btn sm" onClick={() => shell.addCards([{ kind: 'site-visit', props: { demand } }])}>
                Schedule a site visit
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProposalCard({ spec, shell, patch }: CardProps<Props>) {
  const demand = String(spec.props.demand ?? '');
  const journey = useDemandJourney(demand || null);
  const j = journey.data;
  const [current, setCurrent] = useState<string | null>(spec.props.proposal ?? null);
  const [building, setBuilding] = useState(false);
  const existing = useResource<ProposalPage>(j ? '/v1/proposals' : null, j ? { demandId: j.demandId, limit: 5 } : undefined);
  const matches = useResource<MatchPage>(
    demand ? `/v1/demands/${enc(demand)}/matches` : null,
    { status: ['Confirmed'], limit: 20 },
  );
  const canAct = allowed(shell.me.role, ROLES.proposal);
  const confirmed = (matches.data?.items ?? []).filter((m) => m.status === 'Confirmed');
  const list = existing.data?.items ?? [];

  return (
    <Card
      kicker="Proposal"
      title={<RecordLink code={j?.code ?? demand} shell={shell} />}
      label={`Proposal for ${demand}`}
      chips={<JourneyChips journey={j} />}
    >
      {(journey.loading || matches.loading) && !j && <Loading />}
      {journey.error !== undefined && <ErrorNote error={journey.error} onRetry={journey.reload} />}
      {matches.error !== undefined && <ErrorNote error={matches.error} onRetry={matches.reload} />}
      {!canAct && <Note>Your role can view proposals but not create or send them.</Note>}
      {!current && !building && list.length > 0 && (
        <div className="row small">
          <span>Existing:</span>
          {list.map((p) => (
            <button key={p.id} type="button" className="btn sm" onClick={() => setCurrent(p.id)}>
              {p.code} · {p.status}
            </button>
          ))}
          <button type="button" className="btn sm primary" onClick={() => setBuilding(true)} disabled={!canAct}>
            New proposal
          </button>
        </div>
      )}
      {!current && j && (building || (existing.data !== undefined && list.length === 0)) && (
        <Builder
          demandId={j.demandId}
          matches={confirmed}
          canAct={canAct}
          onCreated={(p) => {
            setCurrent(p.id);
            setBuilding(false);
            patch({ proposal: p.code });
            existing.reload();
          }}
        />
      )}
      {current && (
        <>
          <ProposalView id={current} matches={confirmed} canAct={canAct} shell={shell} demand={j?.code ?? demand} />
          {list.length > 1 && (
            <button type="button" className="btn ghost sm" onClick={() => setCurrent(null)}>
              Other proposals
            </button>
          )}
        </>
      )}
    </Card>
  );
}

export default ProposalCard;
