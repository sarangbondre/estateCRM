'use client';
// P-04 Person panel (PRD §5.4): roles, flags (POST /v1/people/{code}/flags; removal Admin/Manager), linked demands
// (GET /v1/demands?personId=) and linked counts, dependencies, call history (journeys GET /v1/calls?personId=).
// Masked by default; "Show contact" reveals via POST /v1/reveals (audited, this view only).
import { useState } from 'react';
import type { components as R, operations as Records } from '@11e/contracts/records';
import type { components as J } from '@11e/contracts/journeys';
import { call, useResource } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import type { PanelProps, ShellActions } from '../../shell/types';
import { ActionButton, Chip, Done, ErrorNote, useAction } from '../Card';
import { Input, KV, Select } from '../common';
import { Loaded, PagedList, RevealContact } from './parts';
import { CallRow } from './shared';
import { FLAG_LABELS, roleAllows, ROLES } from './logic';

type Person = Ok<Records['getPerson']>;
type Flag = R['schemas']['FlagRequest']['flag'];

export function PersonPanel({ props, shell }: PanelProps<{ code: string }>) {
  const res = useResource<Person>(props.code ? `/v1/people/${encodeURIComponent(props.code)}` : null);
  if (!props.code) return <p className="small muted">No person selected.</p>;
  return (
    <Loaded res={res} label="Loading person">
      {(p) => (
        <div>
          <div className="row">
            <b style={{ fontSize: 16 }}>{p.displayName}</b>
            <span className="mono small muted">{p.code}</span>
            {p.companyName && <span className="small muted">{p.companyName}</span>}
            {(p.flags ?? []).map((f) => (
              <Chip key={f} tone="bad">
                {FLAG_LABELS[f] ?? f}
              </Chip>
            ))}
          </div>
          <KV
            rows={[
              ['Party type', p.partyType],
              ['Participant role', p.participantRole],
              ['Phones', (p.phonesMasked ?? []).join(', ') || null],
              ['Email', p.hasEmail ? 'on file' : null],
              ['WhatsApp', p.hasWhatsapp ? 'on file' : null],
              [
                'Linked',
                `${p.linked?.offers ?? 0} offers · ${p.linked?.demands ?? 0} demands · ${p.linked?.enquiries ?? 0} enquiries`,
              ],
            ]}
          />
          <RevealContact subjects={[{ type: 'person', id: p.id, label: p.displayName }]} />
          <Flags p={p} shell={shell} onChanged={res.reload} />
          <PagedList<R['schemas']['Demand']>
            title="Demands"
            path="/v1/demands"
            query={{ personId: p.id }}
            empty="No demands from this person."
            render={(d) => (
              <div key={d.id} className="qitem2">
                <div className="grow">
                  <button
                    type="button"
                    className="btn ghost sm mono"
                    onClick={() => shell.openPanel({ kind: 'demand', title: d.code, props: { code: d.code } })}
                  >
                    {d.code}
                  </button>{' '}
                  <span>{d.label}</span>
                </div>
                <Chip>{d.recordStage}</Chip>
              </div>
            )}
          />
          <div className="qh">Dependencies</div>
          {(p.dependencies ?? []).length ? (
            (p.dependencies ?? []).slice(0, 50).map((x, i) => (
              <div key={i} className="qitem2">
                <div className="grow">{x.text ?? 'Linked record'}</div>
                {x.offerId && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => shell.openPanel({ kind: 'offer', title: 'Offer', props: { code: x.offerId } })}
                  >
                    Open offer
                  </button>
                )}
                {x.demandId && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => shell.openPanel({ kind: 'demand', title: 'Demand', props: { code: x.demandId } })}
                  >
                    Open demand
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="small muted">None recorded.</p>
          )}
          <PagedList<J['schemas']['Call']>
            title="Call history"
            path="/v1/calls"
            query={{ personId: p.id }}
            empty="No calls logged with this person."
            render={(c) => <CallRow key={c.id} c={c} />}
          />
        </div>
      )}
    </Loaded>
  );
}

const FLAGS = Object.entries(FLAG_LABELS).map(([value, label]) => ({ value, label }));

function Flags({ p, shell, onChanged }: { p: Person; shell: ShellActions; onChanged: () => void }) {
  const [flag, setFlag] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const has = flag ? (p.flags ?? []).includes(flag as Flag) : false;
  const act = useAction(
    (key) => {
      const body: Body<Records['flagPerson']> = {
        flag: flag as Flag,
        action: has ? 'remove' : 'add',
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      return call('POST', `/v1/people/${encodeURIComponent(p.code)}/flags`, { body, idempotencyKey: key });
    },
    () => {
      setDone(has ? 'Flag removed' : 'Flag added');
      setReason('');
      onChanged();
    },
  );
  const canAdd = roleAllows(shell.me.role, ROLES.flagPerson);
  const canRemove = roleAllows(shell.me.role, ROLES.removeFlag);
  if (!canAdd) return null;
  return (
    <div className="box">
      <div className="qh">Flags</div>
      <div className="form-grid">
        <Select label="Flag" value={flag} options={FLAGS} onChange={(v) => { setFlag(v); setDone(null); }} />
        <Input label="Reason" value={reason} onChange={setReason} placeholder="optional" />
      </div>
      <div className="row">
        <ActionButton small onClick={act.run} pending={act.pending} disabled={!flag || (has && !canRemove)} danger={has}>
          {has ? 'Remove flag' : 'Add flag'}
        </ActionButton>
        {has && !canRemove && <span className="small muted">Only a manager can remove a flag.</span>}
        {done && <Done>{done}</Done>}
      </div>
      {act.error !== undefined && <ErrorNote error={act.error} />}
    </div>
  );
}
