'use client';
// Settings → Capacities (WEB-08; US-34, D-10, questionnaire C6): calls per person per day, default 40, Admin and Manager.
// Contract: journeys listCapacities, putCapacity (If-Match row version; no version = first capacity for the user);
// names from web listUsers.
import { useState } from 'react';
import { call } from '../lib/api';
import { ActionButton, Done, Loading, useAction } from '../cards/Card';
import { Select, usePaged } from '../cards/common';
import type { TabProps } from './types';
import { NumberInput, Section, SettingsError } from './shared';
import { CAPACITY_RULE, DEFAULT_CAPACITY, capacityRows, checkNumber } from './logic';
import type { Capacity, CapacityRow, Team, User } from './logic';

const TEAMS: { value: Team; label: string }[] = [
  { value: 'demand', label: 'Demand' },
  { value: 'supply', label: 'Supply' },
];

export function CapacitiesTab({ editable }: TabProps) {
  const caps = usePaged<Capacity>('/v1/capacities', { limit: 100 });
  const users = usePaged<User>('/v1/users', { limit: 100 });
  const rows = capacityRows(users.items, caps.items).slice(0, 200);
  const reload = () => void caps.reload();

  return (
    <Section
      title="Daily call capacity"
      note={`How many calls each person's queue plans per day (default ${DEFAULT_CAPACITY}). The Should call queue fills up to this number.`}
    >
      {caps.error !== undefined && <SettingsError error={caps.error} onReload={reload} />}
      {users.error !== undefined && <SettingsError error={users.error} onReload={() => void users.reload()} />}
      <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Team</th>
              <th className="n">Calls / day</th>
              {editable && (
                <th>
                  <span className="sr-only">Save</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <CapacityRowView key={r.userId} row={r} editable={editable} onSaved={reload} />
            ))}
            {!caps.loading && !users.loading && rows.length === 0 && (
              <tr>
                <td colSpan={editable ? 4 : 3} className="muted">
                  No users with a call queue yet. Invite colleagues under Users &amp; roles.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(caps.loading || users.loading) && <Loading label="Loading capacities" />}
      {(caps.hasMore || users.hasMore) && (
        <button
          type="button"
          className="btn sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            if (caps.hasMore) void caps.more();
            if (users.hasMore) void users.more();
          }}
        >
          Load more
        </button>
      )}
    </Section>
  );
}

function CapacityRowView({ row, editable, onSaved }: { row: CapacityRow; editable: boolean; onSaved: () => void }) {
  const [calls, setCalls] = useState(String(row.dailyCalls));
  const [team, setTeam] = useState<Team>(row.team);
  const [saved, setSaved] = useState(false);
  const error = checkNumber(calls, CAPACITY_RULE);
  const dirty = Number(calls) !== row.dailyCalls || team !== row.team || row.version === null;
  const save = useAction(
    () =>
      call<Capacity>('PUT', `/v1/capacities/${encodeURIComponent(row.userId)}`, {
        body: { team, dailyCalls: Number(calls) },
        ...(row.version !== null ? { ifMatch: row.version } : {}),
      }),
    () => {
      setSaved(true);
      onSaved();
    },
  );

  return (
    <tr>
      <td>
        {row.name}
        {row.role && <div className="faint small">{row.role}</div>}
        {row.version === null && <div className="faint small">default, not saved yet</div>}
      </td>
      <td>
        {editable ? (
          <Select label={`${row.name} team`} value={team} options={TEAMS} onChange={(v) => v && setTeam(v as Team)} />
        ) : (
          (TEAMS.find((t) => t.value === row.team)?.label ?? row.team)
        )}
      </td>
      <td className="n">
        {editable ? (
          <NumberInput
            label={`${row.name} calls per day`}
            hideLabel
            value={calls}
            onChange={(v) => {
              setCalls(v);
              setSaved(false);
            }}
            error={error ?? undefined}
            min={CAPACITY_RULE.min}
            max={CAPACITY_RULE.max}
            integer
          />
        ) : (
          row.dailyCalls
        )}
      </td>
      {editable && (
        <td>
          <div className="row">
            <ActionButton small primary={dirty} disabled={Boolean(error) || !dirty} pending={save.pending} onClick={() => void save.run()}>
              Save
              <span className="sr-only"> {row.name}</span>
            </ActionButton>
            {saved && <Done>Saved</Done>}
          </div>
          {save.error !== undefined && <SettingsError error={save.error} onReload={onSaved} />}
        </td>
      )}
    </tr>
  );
}
