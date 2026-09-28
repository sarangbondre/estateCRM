'use client';
// Settings → Users & roles (WEB-08; US-34, PRD §2.1/§2.3, questionnaire A6): directory (Managers read), invite by Google
// e-mail, revoke pending invitations, change role / Data operator flag / name, deactivate / reactivate (Admin).
// Contract: web listUsers, listRoles, inviteUser, revokeInvitation, updateUser (merge patch + If-Match).
import { useState } from 'react';
import type { operations } from '@11e/contracts/web';
import { call, useResource } from '../lib/api';
import type { Ok } from '../lib/contract';
import { date, relative } from '../lib/format';
import { ActionButton, Chip, Done, Loading, useAction } from '../cards/Card';
import { Checkbox, Input, Select, usePaged } from '../cards/common';
import type { TabProps } from './types';
import { Section, SettingsError } from './shared';
import {
  EMPTY_INVITE,
  ROLE_CODES,
  STATUS_TONE,
  buildInvite,
  buildUserPatch,
  userDraft,
  validateInvite,
  validateUserDraft,
} from './logic';
import type { InviteDraft, RoleCode, User, UserDraft } from './logic';

const MAX_ROWS = 50;

export function UsersTab({ shell, editable }: TabProps) {
  const users = usePaged<User>('/v1/users', { limit: MAX_ROWS });
  const roles = useResource<Ok<operations['listRoles']>>('/v1/roles');
  const alone = !users.loading && !users.error && users.items.length <= 1;

  return (
    <>
      {editable && (
        <Section
          title={alone ? 'Invite your first colleagues' : 'Invite a colleague'}
          note={
            alone
              ? 'You are the only user so far. Invite each colleague with their Google account e-mail and a role; they get an e-mail invitation valid for 7 days and sign in with Google.'
              : 'Invitations go to the Google account e-mail and expire after 7 days.'
          }
        >
          <InviteForm
            onInvited={(u) => {
              shell.toast(`Invitation sent to ${u.displayName}`);
              users.reload();
            }}
          />
        </Section>
      )}

      <Section
        title="Users"
        note={editable ? 'You cannot change your own role, and the last active Admin cannot be demoted or deactivated.' : 'Directory (read-only). Only an Admin can invite users or change roles.'}
      >
        {users.error ? (
          <SettingsError error={users.error} onReload={() => void users.reload()} />
        ) : (
          <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  {editable && <th>Google account</th>}
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  {editable && (
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {users.items.slice(0, 500).map((u) => (
                  <UserRow key={u.userId} user={u} editable={editable} selfId={shell.me.userId} onChanged={() => void users.reload()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {users.loading && <Loading label="Loading users" />}
        {users.hasMore && !users.loading && (
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void users.more()}>
            Load more
          </button>
        )}
      </Section>

      <Section title="Roles and permissions" note="Fixed roles (PRD §2.3). The Data operator flag adds upload and review permissions to an agent.">
        {roles.error ? (
          <SettingsError error={roles.error} onReload={roles.reload} />
        ) : !roles.data ? (
          <Loading label="Loading roles" />
        ) : (
          <div>
            {(roles.data.items ?? []).map((r) => (
              <details key={r.code} className="how">
                <summary>
                  {r.code} — {r.description}
                </summary>
                <div>
                  {(r.permissions ?? []).map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function InviteForm({ onInvited }: { onInvited: (u: User) => void }) {
  const [d, setD] = useState<InviteDraft>(EMPTY_INVITE);
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const errors = tried ? validateInvite(d) : [];
  const invite = useAction(
    (key) => call<User>('POST', '/v1/users/invitations', { body: buildInvite(d), idempotencyKey: key }).then((r) => r.data),
    (u) => {
      setSent(u?.email ?? d.email.trim());
      setD(EMPTY_INVITE);
      setTried(false);
      if (u) onInvited(u);
    },
  );
  const set = (p: Partial<InviteDraft>) => {
    setD((x) => ({ ...x, ...p }));
    setSent(null);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (validateInvite(d).length === 0) void invite.run();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div className="form-grid">
        <Input label="Google account e-mail" type="email" value={d.email} onChange={(v) => set({ email: v })} required />
        <Input label="Display name" value={d.displayName} onChange={(v) => set({ displayName: v })} placeholder="e.g. Priyanka" />
        <Select label="Role" value={d.role} options={ROLE_CODES} onChange={(v) => set({ role: (v as RoleCode | null) ?? null })} required />
      </div>
      <Checkbox
        label="Data operator (uploads and review queues, in addition to the role)"
        checked={d.isDataOperator}
        onChange={(v) => set({ isDataOperator: v })}
      />
      {errors.length > 0 && (
        <div role="alert" className="err-note">
          {errors.join(' ')}
        </div>
      )}
      <div className="row">
        <ActionButton type="submit" primary pending={invite.pending}>
          Send invitation
        </ActionButton>
        {sent && <Done>Invitation sent to {sent}</Done>}
        {invite.error !== undefined && <SettingsError error={invite.error} />}
      </div>
    </form>
  );
}

function UserRow({ user, editable, selfId, onChanged }: { user: User; editable: boolean; selfId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revoke = useAction(
    () => call('DELETE', `/v1/users/invitations/${encodeURIComponent(user.userId)}`),
    () => onChanged(),
  );
  const self = user.userId === selfId;
  const cols = editable ? 6 : 4;

  return (
    <>
      <tr>
        <td>
          {user.displayName}
          {self && <span className="faint"> (you)</span>}
        </td>
        {editable && <td className="mono">{user.email ?? '—'}</td>}
        <td>
          {user.role}
          {user.isDataOperator && user.role !== 'Data operator' && (
            <>
              {' '}
              <Chip>+ Data operator</Chip>
            </>
          )}
        </td>
        <td>
          <Chip tone={STATUS_TONE[user.status] ?? 'plain'}>{user.status}</Chip>
          {user.status === 'invited' && user.invitationExpiresAt && (
            <div className="faint small">expires {date(user.invitationExpiresAt)}</div>
          )}
        </td>
        <td>{user.lastSeenAt ? relative(user.lastSeenAt) : '—'}</td>
        {editable && (
          <td>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? 'Close' : 'Edit'}
                <span className="sr-only"> {user.displayName}</span>
              </button>
              {user.status === 'invited' &&
                (confirmRevoke ? (
                  <>
                    <ActionButton small danger pending={revoke.pending} onClick={() => void revoke.run()}>
                      Confirm revoke
                    </ActionButton>
                    <button type="button" className="btn sm ghost" onClick={() => setConfirmRevoke(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn sm" onClick={() => setConfirmRevoke(true)}>
                    Revoke invitation
                  </button>
                ))}
            </div>
            {revoke.error !== undefined && <SettingsError error={revoke.error} onReload={onChanged} />}
          </td>
        )}
      </tr>
      {editable && open && (
        <tr>
          <td colSpan={cols} style={{ background: 'var(--surface-2)' }}>
            <UserEditor key={user.version ?? 0} user={user} self={self} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function UserEditor({ user, self, onChanged }: { user: User; self: boolean; onChanged: () => void }) {
  const [d, setD] = useState<UserDraft>(() => userDraft(user));
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const version = user.version ?? 0;

  const patch = (body: object) =>
    call<User>('PATCH', `/v1/users/${encodeURIComponent(user.userId)}`, {
      body,
      contentType: 'application/merge-patch+json',
      ifMatch: version,
    });

  const save = useAction(
    () => {
      const p = buildUserPatch(user, d);
      return p ? patch(p) : Promise.resolve(null);
    },
    (r) => {
      setDone(r ? 'Saved' : null);
      if (r) onChanged();
    },
  );
  const status = useAction(
    () => patch({ status: user.status === 'deactivated' ? 'active' : 'deactivated' }),
    () => {
      setDone(user.status === 'deactivated' ? 'Reactivated' : 'Deactivated; sessions revoked');
      onChanged();
    },
  );

  const onSave = () => {
    setDone(null);
    const invalid = validateUserDraft(d);
    if (invalid) return setNote(invalid);
    if (!buildUserPatch(user, d)) return setNote('Nothing changed.');
    setNote(null);
    void save.run();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0' }}>
      <div className="form-grid">
        <Input label="Display name" value={d.displayName} onChange={(v) => setD({ ...d, displayName: v })} required />
        <Select
          label={self ? 'Role (you cannot change your own)' : 'Role'}
          value={d.role}
          options={ROLE_CODES}
          onChange={(v) => v && setD({ ...d, role: v as RoleCode })}
          disabled={self}
          required
        />
      </div>
      <Checkbox label="Data operator (uploads and review queues)" checked={d.isDataOperator} onChange={(v) => setD({ ...d, isDataOperator: v })} />
      {note && (
        <div role="alert" className="err-note">
          {note}
        </div>
      )}
      <div className="row">
        <ActionButton primary small pending={save.pending} onClick={onSave}>
          Save changes
        </ActionButton>
        {!self && user.status !== 'invited' && (
          <ActionButton small danger={user.status !== 'deactivated'} pending={status.pending} onClick={() => void status.run()}>
            {user.status === 'deactivated' ? 'Reactivate' : 'Deactivate'}
          </ActionButton>
        )}
        {done && <Done>{done}</Done>}
      </div>
      {save.error !== undefined && <SettingsError error={save.error} onReload={onChanged} />}
      {status.error !== undefined && <SettingsError error={status.error} onReload={onChanged} />}
      {user.status !== 'deactivated' && !self && (
        <p className="faint small" style={{ margin: 0 }}>
          Deactivating signs the person out everywhere at once and blocks new sign-ins.
        </p>
      )}
    </div>
  );
}
