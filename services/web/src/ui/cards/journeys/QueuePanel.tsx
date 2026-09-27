'use client';
// P-01 My queue panel (PRD §4.2 supply call queues, §4.3 demand queues, §5.4; R-UI-4; US-12, US-19). Header: capacity,
// calls logged today, planned today. Sections per team as prototype .qh headers with .qitem2 rows in computed order
// (no drag reordering: rank is computed); each item shows code, summary, reason, due/overdue, life stage and the
// action that opens the right card, plus Open (record panel). Managers/Admins pick a team member to view their queue
// and reassign selected items (C-19 confirm step).
// journeys: getMyQueue, listMyQueueSection (should_call with plannedOnly), getUserQueue, listUserQueueSection,
// reassignQueueItems; web: listUsers.
import { useState } from 'react';
import type { operations as journeysOps } from '@11e/contracts/journeys';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { count, relative } from '../../lib/format';
import type { PanelProps, ShellActions } from '../../shell/types';
import { panelForCode } from '../../chat/intents';
import { ActionButton, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { LifeStage, RecordLink, usePaged } from '../common';
import {
  actionFor,
  allowed,
  buildReassign,
  dueChip,
  groupSections,
  reasonLabel,
  ROLES,
  sectionMeta,
  sectionTone,
  TEAM_LABEL,
} from './logic';
import type { QueueItem, QueueSectionSummary } from './logic';
import { Problems, UserSelect } from './shared';

type Summary = Ok<journeysOps['getMyQueue']>;

const enc = encodeURIComponent;
const MAX_ROWS = 50;

function QueueItemRow({
  item,
  shell,
  selectable,
  selected,
  onSelect,
}: {
  item: QueueItem;
  shell: ShellActions;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const action = actionFor(item);
  const due = dueChip(item);
  const panel = panelForCode(item.subjectCode);
  const why = [
    reasonLabel(item.reason) + (item.reasonRef ? ` ${item.reasonRef}` : ''),
    item.section === 'should_call' && item.rank != null ? `rank ${Math.round(item.rank)}` : null,
    (item.attempts ?? 0) > 0 ? `attempt ${item.attempts} of 3` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="qitem2">
      {selectable && (
        <input
          type="checkbox"
          aria-label={`Select ${item.subjectCode}`}
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
        />
      )}
      <div className="grow">
        <RecordLink code={item.subjectCode} shell={shell} /> <span>{item.summary ?? ''}</span>
        <div className="small muted">{why}</div>
      </div>
      <LifeStage stage={item.lifeStage ?? null} day={item.dayCount ?? null} />
      {due && <Chip tone={due.tone}>{due.text}</Chip>}
      {action && (
        <button
          type="button"
          className="btn sm"
          onClick={() =>
            shell.addCards([{ kind: action.kind, props: action.props }], `${action.label}: ${item.subjectCode}`)
          }
        >
          {action.label}
        </button>
      )}
      {panel && (
        <button type="button" className="btn sm ghost" onClick={() => shell.openPanel(panel)}>
          Open
        </button>
      )}
    </div>
  );
}

function Section({
  summary,
  base,
  mine,
  shell,
  selectable,
  selected,
  onSelect,
}: {
  summary: QueueSectionSummary;
  base: string;
  mine: boolean;
  shell: ShellActions;
  selectable: boolean;
  selected: Set<string>;
  onSelect: (id: string, on: boolean) => void;
}) {
  const meta = sectionMeta(summary.section, summary.team);
  const [open, setOpen] = useState(summary.count > 0);
  const query = {
    limit: 25,
    ...(mine && summary.section === 'should_call' ? { plannedOnly: true } : {}),
  };
  const items = usePaged<QueueItem>(open && summary.count > 0 ? `${base}/sections/${enc(summary.section)}` : null, query);
  const planned = summary.section === 'should_call' && summary.plannedToday != null ? ` · ${summary.plannedToday} planned` : '';
  const rows = items.items.slice(0, MAX_ROWS);
  return (
    <div className="qsec">
      <div className="qh">
        <button type="button" className="btn ghost sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {meta.label}
        </button>{' '}
        <Chip tone={sectionTone(summary)}>
          {count(summary.count)}
          {summary.overdue ? ` · ${summary.overdue} overdue` : ''}
          {planned}
        </Chip>
      </div>
      {open &&
        (summary.count === 0 ? (
          <p className="small muted">Nothing due.</p>
        ) : (
          <>
            {rows.map((it) => (
              <QueueItemRow
                key={it.id}
                item={it}
                shell={shell}
                selectable={selectable}
                selected={selected.has(it.id)}
                onSelect={(on) => onSelect(it.id, on)}
              />
            ))}
            {items.loading && <Loading />}
            {items.error !== undefined && <ErrorNote error={items.error} onRetry={() => void items.reload()} />}
            {!items.loading && !items.error && rows.length === 0 && <p className="small muted">Nothing due.</p>}
            {items.hasMore && rows.length < MAX_ROWS && (
              <button type="button" className="btn sm" onClick={() => void items.more()}>
                Load more
              </button>
            )}
            {rows.length >= MAX_ROWS && items.hasMore && (
              <p className="small muted">Showing the first {MAX_ROWS}. Clear some and reopen the section.</p>
            )}
          </>
        ))}
    </div>
  );
}

function Reassign({
  selected,
  exclude,
  onDone,
}: {
  selected: string[];
  exclude: string | null;
  onDone: (message: string) => void;
}) {
  const [assignee, setAssignee] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const built = buildReassign(selected, assignee);
  const act = useAction(
    (key) =>
      'body' in built
        ? call<Ok<journeysOps['reassignQueueItems']>>('POST', '/v1/queue-items/reassign', {
            body: built.body,
            idempotencyKey: key,
          })
        : Promise.reject(new Error(built.errors.join(' '))),
    (r) => {
      const skipped = r.data.skipped?.length ?? 0;
      setConfirming(false);
      onDone(`Reassigned ${r.data.reassigned}${skipped ? `, ${skipped} skipped (already closed or not movable)` : ''}.`);
    },
  );
  return (
    <div className="card-f" style={{ flexWrap: 'wrap' }}>
      <span className="small">{selected.length} selected</span>
      <UserSelect label="Reassign to" value={assignee} onChange={setAssignee} {...(exclude ? { exclude } : {})} />
      {!confirming ? (
        <ActionButton onClick={() => setConfirming(true)} disabled={!('body' in built)}>
          Reassign…
        </ActionButton>
      ) : (
        <>
          <span className="small">Move {selected.length} item(s)? The new owner sees them in their queue.</span>
          <ActionButton onClick={() => setConfirming(false)}>Cancel</ActionButton>
          <ActionButton primary pending={act.pending} onClick={() => void act.run()}>
            Confirm
          </ActionButton>
        </>
      )}
      {'errors' in built && assignee !== null && <Problems errors={built.errors} />}
      {act.error !== undefined && <ErrorNote error={act.error} />}
    </div>
  );
}

function QueuePanel({ shell }: PanelProps<Record<string, unknown>>) {
  const isManager = allowed(shell.me.role, ROLES.queueOfOthers);
  const [userId, setUserId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const mine = userId === null || userId === shell.me.userId;
  const base = mine ? '/v1/queues/me' : `/v1/queues/users/${enc(userId)}`;
  const summary = useResource<Summary>(base);
  const s = summary.data;
  const refresh = () => {
    summary.reload();
    setRefreshKey((k) => k + 1);
  };
  const groups = groupSections(s?.sections ?? []);

  const onSelect = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div>
      {isManager && (
        <div className="filters">
          <UserSelect
            label="Queue of"
            value={userId}
            onChange={(v) => {
              setUserId(v);
              setSelected(new Set());
            }}
          />
          {!mine && (
            <button type="button" className="btn sm" onClick={() => setUserId(null)}>
              Back to my queue
            </button>
          )}
        </div>
      )}
      {summary.loading && !s && <Loading label="Loading queue" />}
      {summary.error !== undefined && <ErrorNote error={summary.error} onRetry={summary.reload} />}
      {s && (
        <>
          <div className="kpis" role="group" aria-label="Today">
            <div className="kpi">
              <span className="small muted">Capacity</span>
              <b>{count(s.capacity)}</b>
            </div>
            <div className="kpi">
              <span className="small muted">Calls logged today</span>
              <b>{count(s.callsLoggedToday)}</b>
            </div>
            <div className="kpi">
              <span className="small muted">Planned today</span>
              <b>{count(s.plannedToday)}</b>
            </div>
          </div>
          <p className="small faint">
            Order is computed (overdue first, then due time or rank); it cannot be reordered by hand.
            {s.generatedAt ? ` Updated ${relative(s.generatedAt)}.` : ''}{' '}
            <button type="button" className="btn ghost sm" onClick={refresh}>
              Refresh
            </button>
          </p>
          {groups.length === 0 && <p className="small muted">Your queue is empty.</p>}
          {groups.map((g) => (
            <section key={g.team} aria-label={TEAM_LABEL[g.team]}>
              {groups.length > 1 && <h4 className="small muted">{TEAM_LABEL[g.team]}</h4>}
              {g.sections.map((sec) => (
                <Section
                  key={`${base}|${sec.section}|${refreshKey}`}
                  summary={sec}
                  base={base}
                  mine={mine}
                  shell={shell}
                  selectable={isManager}
                  selected={selected}
                  onSelect={onSelect}
                />
              ))}
            </section>
          ))}
          {isManager && selected.size > 0 && (
            <Reassign
              selected={[...selected]}
              exclude={mine ? shell.me.userId : userId}
              onDone={(message) => {
                setSelected(new Set());
                setNotice(message);
                refresh();
              }}
            />
          )}
          {notice && <Done>{notice}</Done>}
        </>
      )}
    </div>
  );
}

export default QueuePanel;
