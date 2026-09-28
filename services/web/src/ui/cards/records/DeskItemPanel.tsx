'use client';
// C-21 Desk item (PRD §5.4, US-36): GET /v1/desk-items/{code}. Business / Capital / Archive: Admin and Manager assign,
// archive or open the linked Property (PATCH /v1/desk-items/{code}, JSON Merge Patch + If-Match). Watchlist: the supply
// follow-up tasks (journeys GET /v1/watchlist-tasks, POST /v1/watchlist-tasks/{id}/complete; Supply agent, Manager,
// Admin).
import { useState } from 'react';
import type { operations as Records } from '@11e/contracts/records';
import type { components as J } from '@11e/contracts/journeys';
import type { operations as Web } from '@11e/contracts/web';
import { call, useResource } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { date } from '../../lib/format';
import type { PanelProps, ShellActions } from '../../shell/types';
import { ActionButton, Chip, Done, ErrorNote, useAction } from '../Card';
import { Input, KV, Select } from '../common';
import { Loaded, PagedList } from './parts';
import { daysUntil, roleAllows, ROLES, tabForDesk } from './logic';

type DeskItem = Ok<Records['getDeskItem']>;
type Users = Ok<Web['listUsers']>;

export function DeskItemPanel({ props, shell }: PanelProps<{ code: string }>) {
  const res = useResource<DeskItem>(props.code ? `/v1/desk-items/${encodeURIComponent(props.code)}` : null);
  if (!props.code) return <p className="small muted">No item selected.</p>;
  return (
    <Loaded res={res} label="Loading desk item">
      {(it) => {
        const days = daysUntil(it.deadlineDate);
        return (
          <div>
            <div className="row">
              <b className="mono">{it.code}</b>
              <Chip>{tabForDesk(it.desk) ?? it.desk}</Chip>
              {it.side && <Chip>side {it.side}</Chip>}
              {it.archived && <Chip>archived</Chip>}
              {it.outsideLaunchArea && <Chip tone="warn">Outside launch area</Chip>}
            </div>
            <KV
              rows={[
                ['Record scope', it.recordScope],
                ['Deal types', (it.dealTypes ?? []).join(', ') || null],
                ['Sector', it.sector],
                ['Includes property', it.includesProperty],
                ['Participant role', it.participantRole],
                ['Signal', it.signalType],
                ['Party type', it.partyType],
                [
                  'Deadline',
                  it.deadlineDate
                    ? `${date(it.deadlineDate)}${days != null ? (days >= 0 ? ` · in ${days} days` : ` · ${-days} days ago`) : ''}`
                    : null,
                ],
                ['Description', it.businessDescription],
                ['Created', it.createdAt ? date(it.createdAt) : null],
              ]}
            />
            <div className="row">
              {it.linkedPropertyId && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    shell.openPanel({ kind: 'property', title: 'Linked property', props: { code: it.linkedPropertyId } })
                  }
                >
                  Open linked property
                </button>
              )}
              {it.personId && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => shell.openPanel({ kind: 'person', title: 'Person', props: { code: it.personId } })}
                >
                  Open person
                </button>
              )}
            </div>
            {it.desk !== 'network' && <ManageItem it={it} shell={shell} onSaved={res.reload} />}
            {it.desk === 'watchlist' && <WatchlistTasks it={it} shell={shell} />}
          </div>
        );
      }}
    </Loaded>
  );
}

function ManageItem({ it, shell, onSaved }: { it: DeskItem; shell: ShellActions; onSaved: () => void }) {
  const canManage = roleAllows(shell.me.role, ROLES.patchDeskItem);
  const users = useResource<Users>(canManage ? '/v1/users' : null, { status: 'active', limit: 100 });
  const [assignee, setAssignee] = useState<string | null>(it.assigneeUserId ?? null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const patchItem = (body: Body<Records['patchDeskItem']>) =>
    call<DeskItem>('PATCH', `/v1/desk-items/${encodeURIComponent(it.code)}`, {
      body,
      contentType: 'application/merge-patch+json',
      ifMatch: it.version,
    });
  const assign = useAction(
    () => patchItem({ assigneeUserId: assignee, ...(note.trim() ? { note: note.trim() } : {}) }),
    () => {
      setDone('Saved');
      setNote('');
      onSaved();
    },
  );
  const archive = useAction(
    () => patchItem({ archived: !it.archived }),
    () => {
      setDone(it.archived ? 'Restored' : 'Archived');
      onSaved();
    },
  );
  const assigneeName = users.data?.items.find((u) => u.userId === it.assigneeUserId)?.displayName;
  if (!canManage)
    return (
      <p className="small muted">
        {it.assigneeUserId ? `Assigned${assigneeName ? ` to ${assigneeName}` : ''}.` : 'Not assigned.'} Managers can assign
        or archive.
      </p>
    );
  const options = (users.data?.items ?? []).map((u) => ({ value: u.userId, label: `${u.displayName} · ${u.role}` }));
  return (
    <div className="box">
      <div className="qh">Manage</div>
      <div className="form-grid">
        <Select label="Assignee" value={assignee} options={options} onChange={setAssignee} placeholder="Unassigned" />
        <Input label="Note" value={note} onChange={setNote} placeholder="optional" />
      </div>
      {users.error !== undefined && <ErrorNote error={users.error} onRetry={users.reload} />}
      <div className="row">
        <ActionButton small primary onClick={assign.run} pending={assign.pending} disabled={assignee === (it.assigneeUserId ?? null) && !note.trim()}>
          Save assignment
        </ActionButton>
        <ActionButton small onClick={archive.run} pending={archive.pending}>
          {it.archived ? 'Restore from archive' : 'Archive'}
        </ActionButton>
        {done && <Done>{done}</Done>}
      </div>
      {assign.error !== undefined && <ErrorNote error={assign.error} />}
      {archive.error !== undefined && <ErrorNote error={archive.error} />}
    </div>
  );
}

function WatchlistTasks({ it, shell }: { it: DeskItem; shell: ShellActions }) {
  const [tick, setTick] = useState(0);
  return (
    <div>
      <PagedList<J['schemas']['WatchlistTask']>
        key={tick}
        title="Follow-up tasks"
        path="/v1/watchlist-tasks"
        query={{ limit: 100 }}
        filter={(t) => t.watchlistItemId === it.id || t.watchlistCode === it.code}
        empty="No follow-up task on this page of tasks."
        render={(t) => <TaskRow key={t.id} t={t} shell={shell} onDone={() => setTick((n) => n + 1)} />}
      />
    </div>
  );
}

function TaskRow({ t, shell, onDone }: { t: J['schemas']['WatchlistTask']; shell: ShellActions; onDone: () => void }) {
  const [outcome, setOutcome] = useState('');
  const canComplete = roleAllows(shell.me.role, ROLES.completeWatchlistTask);
  const complete = useAction(
    (key) =>
      call('POST', `/v1/watchlist-tasks/${encodeURIComponent(t.id)}/complete`, {
        body: { outcome: outcome.trim() } satisfies J['schemas']['WatchlistTaskComplete'],
        idempotencyKey: key,
      }),
    onDone,
  );
  return (
    <div className="box">
      <div className="row">
        <b>{t.signalType ?? 'Follow-up'}</b>
        <Chip tone={t.status === 'Done' ? 'good' : t.status === 'Cancelled' ? 'plain' : 'warn'}>{t.status}</Chip>
        {t.dueDate && <span className="small muted">due {date(t.dueDate)}</span>}
        {t.outcome && <span className="small muted">· {t.outcome}</span>}
      </div>
      {t.status === 'Open' && canComplete && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <Input label="Outcome" value={outcome} onChange={setOutcome} required placeholder="What happened" />
          </div>
          <ActionButton small primary onClick={complete.run} pending={complete.pending} disabled={!outcome.trim()}>
            Task done
          </ActionButton>
        </div>
      )}
      {complete.error !== undefined && <ErrorNote error={complete.error} />}
    </div>
  );
}
