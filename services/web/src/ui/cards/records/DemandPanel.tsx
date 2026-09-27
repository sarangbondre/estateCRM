'use client';
// P-03 Demand panel (PRD §5.4): tabs Overview (status axes from journeys GET /v1/demands/{code}/journey, life curve),
// Touches (GET + POST /v1/demands/{code}/touches, first touch flagged), Matches (crm-engine matches card), Sourcing,
// Proposals & visits, Deal (journeys lists filtered by demandId, with buttons that open the action cards), Activity
// (call history). "Show contact" reveals the client (audited).
import { useState } from 'react';
import type { components as R, operations as Records } from '@11e/contracts/records';
import type { components as J, operations as Journeys } from '@11e/contracts/journeys';
import { call, useResource } from '../../lib/api';
import type { Resource } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { date, inr, relative, sqft } from '../../lib/format';
import type { PanelProps, ShellActions } from '../../shell/types';
import { ActionButton, Chip, Done, ErrorNote, useAction } from '../Card';
import { Axis, Input, KV, LifeStage, RecordLink, Select, Tabs } from '../common';
import { cardFor } from '../registry';
import { List, Loaded, PagedList, RevealContact, SendButton } from './parts';
import { CallRow } from './shared';
import { DEMAND_COMMERCIAL, DEMAND_RECORD_STAGES, rangeText, roleAllows, ROLES } from './logic';

type Demand = Ok<Records['getDemand']>;
type Journey = Ok<Journeys['getDemandJourney']>;

const TABS = ['Overview', 'Touches', 'Matches', 'Sourcing', 'Proposals & visits', 'Deal', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export function DemandPanel({ props, shell }: PanelProps<{ code: string }>) {
  const code = props.code;
  const [tab, setTab] = useState<Tab>('Overview');
  const demand = useResource<Demand>(code ? `/v1/demands/${encodeURIComponent(code)}` : null);
  const journey = useResource<Journey>(code ? `/v1/demands/${encodeURIComponent(code)}/journey` : null);
  if (!code) return <p className="small muted">No demand selected.</p>;
  return (
    <Loaded res={demand} label="Loading demand">
      {(d) => (
        <div>
          <div className="row">
            <span className="chip demand">Demand</span>
            <b>{d.clientDisplayName ?? d.companyName ?? 'Client'}</b>
            <span className="small muted">
              {[d.label, d.segment, (d.propertyTypes ?? []).join(', ')].filter(Boolean).join(' · ')}
            </span>
            {journey.data && <LifeStage stage={journey.data.lifeCurve?.stage} day={journey.data.lifeCurve?.dayCount ?? null} />}
            {journey.data?.exit && <Chip tone="bad">{journey.data.exit.type}</Chip>}
            {d.needsReview && <Chip tone="warn">Needs review</Chip>}
          </div>
          <Tabs tabs={TABS} value={tab} onChange={setTab} label={`${d.code} sections`} />
          <div role="tabpanel" aria-label={tab}>
            {tab === 'Overview' && <Overview d={d} journey={journey} shell={shell} />}
            {tab === 'Touches' && <Touches d={d} shell={shell} />}
            {tab === 'Matches' && <Matches code={d.code} shell={shell} />}
            {tab === 'Sourcing' && <Sourcing d={d} shell={shell} />}
            {tab === 'Proposals & visits' && <ProposalsVisits d={d} shell={shell} />}
            {tab === 'Deal' && <Deals d={d} shell={shell} />}
            {tab === 'Activity' && (
              <div>
                <KV
                  rows={[
                    ['Created', d.createdAt ? date(d.createdAt, true) : null],
                    ['Updated', d.updatedAt ? date(d.updatedAt, true) : null],
                    ['Qualified', journey.data?.qualifiedAt ? date(journey.data.qualifiedAt, true) : null],
                  ]}
                />
                <PagedList<J['schemas']['Call']>
                  title="Calls"
                  path="/v1/calls"
                  query={{ subjectId: d.id }}
                  empty="No calls logged."
                  render={(c) => <CallRow key={c.id} c={c} />}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </Loaded>
  );
}

function budgetText(d: Demand): string | null {
  const sale = rangeText(d.budgetInrMin, d.budgetInrMax, inr);
  const rent = rangeText(d.rentMonthlyInrMin, d.rentMonthlyInrMax, inr);
  return [sale, rent && `${rent} / month`].filter(Boolean).join(' · ') || null;
}

function Overview({ d, journey, shell }: { d: Demand; journey: Resource<Journey>; shell: ShellActions }) {
  const j = journey.data;
  const t = d.statedTags ?? {};
  const tags = [
    t.saleMode && `sale_mode=${t.saleMode}`,
    t.tenancyStatus && `tenancy_status=${t.tenancyStatus}`,
    t.tenure && `tenure=${t.tenure}`,
    t.agreementForm && `agreement_form=${t.agreementForm}`,
    t.possessionStatus && `possession_status=${t.possessionStatus}`,
    t.furnishing && `furnishing=${t.furnishing}`,
    t.isJodi && 'is_jodi=Yes',
  ].filter(Boolean);
  const exited = Boolean(j?.exit);
  return (
    <div>
      <div className="mono small muted">
        {[
          'side=Demand',
          `deal_type=${(d.dealTypes ?? []).join('|')}`,
          d.market && `market=${d.market}`,
          d.segment && `segment=${d.segment}`,
          d.propertyTypes?.length && `property_type=${d.propertyTypes.join('|')}`,
          (d.bhkMin ?? d.bhkMax) != null && `bhk=${rangeText(d.bhkMin, d.bhkMax, String)}`,
          ...tags,
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
      <Axis name="Record" steps={DEMAND_RECORD_STAGES} current={d.recordStage} />
      {j ? (
        <Axis name="Commercial" steps={DEMAND_COMMERCIAL} current={j.commercialStatus} />
      ) : journey.error !== undefined ? (
        <p className="small muted">Commercial status is not available right now.</p>
      ) : null}
      <KV
        rows={[
          ['Wants', [rangeText(d.areaSqftMin, d.areaSqftMax, sqft), d.areaBasis?.toLowerCase()].filter(Boolean).join(' ') || null],
          ['Where', <List key="w" values={[...(d.localities ?? []), ...(d.micromarkets ?? []).map((m) => m.name)]} />],
          ['Budget', budgetText(d)],
          ['Move in', d.moveInText ?? (d.moveInBy ? `by ${date(d.moveInBy)}` : null)],
          ['Decision maker', d.decisionMaker],
          ['Client', d.personCode ? <RecordLink key="p" code={d.personCode} shell={shell} /> : null],
          ['Touches', `${d.touchCount ?? 0}`],
          ['Source', `${d.sourceType}${d.captureMode ? ` · ${d.captureMode.replace('_', ' ')}` : ''}`],
          ['Live matches', j?.liveMatches != null ? String(j.liveMatches) : null],
          ['Queue', j?.queue ? `${j.queue.section.replace(/_/g, ' ')}${j.queue.reason ? ` · ${j.queue.reason}` : ''}` : null],
          [
            'Exit',
            j?.exit
              ? `${j.exit.type}${j.exit.reason ? ` · ${j.exit.reason}` : ''}${j.exit.revisitDate ? ` · revisit ${date(j.exit.revisitDate)}` : ''}`
              : null,
          ],
          ['Review', d.needsReview ? d.reviewReason ?? d.reviewReasonCode ?? 'yes' : null],
        ]}
      />
      {shell.me.role !== 'Supply agent' && !exited && (
        <div className="row">
          <SendButton send={shell.send} text={`qualify ${d.code}`}>
            Qualify
          </SendButton>
          <SendButton send={shell.send} text={`matches for ${d.code}`}>
            Matches
          </SendButton>
          <SendButton send={shell.send} text={`send proposal for ${d.code}`}>
            Proposal
          </SendButton>
          <SendButton send={shell.send} text={`start deal ${d.code}`}>
            Deal
          </SendButton>
          <SendButton send={shell.send} text={`client for ${d.code} postponed`}>
            Exit…
          </SendButton>
        </div>
      )}
      <div className="row">
        <SendButton send={shell.send} text={`add supply for ${d.code}`}>
          Add supply
        </SendButton>
      </div>
      {d.personId && (
        <RevealContact subjects={[{ type: 'person', id: d.personId, label: d.clientDisplayName ?? 'Client' }]} />
      )}
    </div>
  );
}

const SOURCE_TYPES = ['Direct', 'Channel', 'Digi'] as const;

function Touches({ d, shell }: { d: Demand; shell: ShellActions }) {
  const [sourceType, setSourceType] = useState<string | null>('Direct');
  const [detail, setDetail] = useState('');
  const [tick, setTick] = useState(0);
  const [added, setAdded] = useState(false);
  const add = useAction(
    (key) => {
      const body: Body<Records['addTouch']> = {
        sourceType: (sourceType ?? 'Direct') as R['schemas']['TouchInput']['sourceType'],
        ...(detail.trim() ? { sourceDetail: detail.trim() } : {}),
      };
      return call('POST', `/v1/demands/${encodeURIComponent(d.code)}/touches`, { body, idempotencyKey: key });
    },
    () => {
      setAdded(true);
      setDetail('');
      setTick((n) => n + 1);
    },
  );
  const canAdd = roleAllows(shell.me.role, ROLES.addTouch);
  return (
    <div>
      <PagedList<R['schemas']['Touch']>
        key={tick}
        path={`/v1/demands/${encodeURIComponent(d.code)}/touches`}
        empty="No touches."
        render={(t) => (
          <div key={t.id} className="qitem2">
            <div className="grow">
              <b>{t.sourceType}</b>{' '}
              <span className="small muted">
                {t.sourceDetail ?? ''} {t.captureMode ? `· ${t.captureMode.replace('_', ' ')}` : ''}
              </span>
            </div>
            {t.isFirstTouch && <Chip tone="good">first touch</Chip>}
            <span className="small muted">{relative(t.occurredAt)}</span>
          </div>
        )}
      />
      {canAdd && (
        <div className="box">
          <div className="qh">Add a touch</div>
          <p className="small muted">Another arrival of the same demand. First-touch credit never moves (A-16).</p>
          <div className="form-grid">
            <Select label="Source type" value={sourceType} options={SOURCE_TYPES} onChange={setSourceType} required />
            <Input label="Source detail" value={detail} onChange={setDetail} placeholder="e.g. referred again by Anil" />
          </div>
          <div className="row">
            <ActionButton small primary onClick={add.run} pending={add.pending} disabled={!sourceType}>
              Add touch
            </ActionButton>
            {added && <Done>Touch added</Done>}
          </div>
          {add.error !== undefined && <ErrorNote error={add.error} />}
        </div>
      )}
    </div>
  );
}

function Matches({ code, shell }: { code: string; shell: ShellActions }) {
  const C = cardFor('matches');
  return <C spec={{ id: `demand-matches-${code}`, kind: 'matches', props: { demand: code } }} shell={shell} patch={() => {}} />;
}

function Sourcing({ d, shell }: { d: Demand; shell: ShellActions }) {
  return (
    <div>
      <PagedList<J['schemas']['SourcingRequest']>
        path="/v1/sourcing-requests"
        query={{ demandId: d.id }}
        empty="No sourcing requests for this demand."
        render={(s) => (
          <div key={s.id} className="qitem2">
            <div className="grow">
              <b className="mono">{s.code}</b>{' '}
              <span className="small muted">
                priority {s.priority} · due {date(s.dueDate)}
                {s.offerIds?.length ? ` · ${s.offerIds.length} offers found` : ''}
              </span>
            </div>
            <Chip tone={s.status === 'Fulfilled' ? 'good' : s.status === 'Cancelled' ? 'plain' : 'warn'}>{s.status}</Chip>
            {(s.status === 'Open' || s.status === 'In progress') && (
              <SendButton send={shell.send} text={`add supply for ${d.code}`}>
                Add supply
              </SendButton>
            )}
          </div>
        )}
      />
      <div className="row">
        <SendButton send={shell.send} text={`source supply for ${d.code}`}>
          New sourcing request
        </SendButton>
      </div>
    </div>
  );
}

function ProposalsVisits({ d, shell }: { d: Demand; shell: ShellActions }) {
  return (
    <div>
      <PagedList<J['schemas']['Proposal']>
        title="Proposals"
        path="/v1/proposals"
        query={{ demandId: d.id }}
        empty="No proposals yet."
        render={(p) => (
          <div key={p.id} className="qitem2">
            <div className="grow">
              <b className="mono">{p.code}</b>{' '}
              <span className="small muted">
                {p.options?.length ?? 0} options{p.sentAt ? ` · sent ${relative(p.sentAt)}` : ''}
                {p.activeLink?.opens != null ? ` · opened ${p.activeLink.opens}×` : ''}
              </span>
            </div>
            <Chip tone={p.status === 'Sent' ? 'good' : p.status === 'Failed' ? 'bad' : 'plain'}>{p.status}</Chip>
          </div>
        )}
      />
      <PagedList<J['schemas']['SiteVisit']>
        title="Site visits"
        path="/v1/site-visits"
        query={{ demandId: d.id }}
        empty="No site visits yet."
        render={(v) => (
          <div key={v.id} className="qitem2">
            <div className="grow">
              <b className="mono">{v.code}</b>{' '}
              <span className="small muted">
                {date(v.scheduledAt, true)} · {v.offerIds?.length ?? 0} offers{v.outcome ? ` · ${v.outcome}` : ''}
              </span>
            </div>
            <Chip tone={v.status === 'Completed' ? 'good' : 'plain'}>{v.status}</Chip>
          </div>
        )}
      />
      <div className="row">
        <SendButton send={shell.send} text={`send proposal for ${d.code}`}>
          New proposal
        </SendButton>
        <SendButton send={shell.send} text={`schedule visit for ${d.code}`}>
          Schedule visit
        </SendButton>
      </div>
    </div>
  );
}

function Deals({ d, shell }: { d: Demand; shell: ShellActions }) {
  return (
    <div>
      <PagedList<J['schemas']['Deal']>
        path="/v1/deals"
        query={{ demandId: d.id }}
        empty="No deal for this demand."
        render={(x) => (
          <div key={x.id} className="qitem2">
            <div className="grow">
              <b className="mono">{x.code}</b>{' '}
              <span className="small muted">
                {x.nextAction ? `next: ${x.nextAction}` : 'no next action'}
                {x.followUpDate ? ` · follow up ${date(x.followUpDate)}` : ''}
              </span>
            </div>
            {x.overdue && <Chip tone="bad">overdue</Chip>}
            <Chip tone={x.stage === 'Closed' ? 'good' : x.stage === 'Cancelled' ? 'plain' : 'warn'}>{x.stage}</Chip>
          </div>
        )}
      />
      <div className="row">
        <SendButton send={shell.send} text={`start deal ${d.code}`}>
          Start deal
        </SendButton>
      </div>
    </div>
  );
}
