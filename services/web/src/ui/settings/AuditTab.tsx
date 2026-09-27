'use client';
// Settings → Audit log (WEB-08; US-35, FR-AUD-1): the immutable audit log, newest first, filtered on stored fields
// (actor, action exact or "prefix.*", subject, producer, date range), cursor "Load more" (Admin).
// Contract: web listAuditLog; actor names from listUsers.
import { useState } from 'react';
import { date } from '../lib/format';
import { Chip, Loading } from '../cards/Card';
import { Input, Select, usePaged } from '../cards/common';
import { Section, SettingsError } from './shared';
import { AUDIT_PRODUCERS, EMPTY_AUDIT_FILTERS, auditQuery, formatDetails, shortId } from './logic';
import type { AuditEntry, AuditFilters, User } from './logic';

const ACTION_MODES = [
  { value: 'exact', label: 'Exactly' },
  { value: 'prefix', label: 'Starts with' },
];

export function AuditTab() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const users = usePaged<User>('/v1/users', { limit: 100 });
  const log = usePaged<AuditEntry>('/v1/audit-log', { limit: 50, ...applied });
  const set = (p: Partial<AuditFilters>) => setDraft((d) => ({ ...d, ...p }));

  const apply = (f: AuditFilters) => {
    const r = auditQuery(f);
    setErrors(r.errors);
    if (r.errors.length === 0) setApplied(r.query);
  };
  const actorOptions = users.items.map((u) => ({ value: u.userId, label: u.displayName }));

  return (
    <Section
      title="Audit log"
      note="Contact views, exports, merges and undos, publication changes, exits, deal closes and setting changes. Entries cannot be changed or deleted and are kept at least a year."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div className="form-grid">
          <Select label="Who" value={draft.actorUserId || null} options={actorOptions} onChange={(v) => set({ actorUserId: v ?? '' })} placeholder="Anyone" />
          <Select
            label="Action match"
            value={draft.actionMode}
            options={ACTION_MODES}
            onChange={(v) => set({ actionMode: v === 'prefix' ? 'prefix' : 'exact' })}
            placeholder="Exactly"
          />
          <Input label="Action" value={draft.action} onChange={(v) => set({ action: v })} placeholder="e.g. contact.viewed or export" />
          <Input label="Subject type" value={draft.subjectType} onChange={(v) => set({ subjectType: v })} placeholder="e.g. offer" />
          <Input label="Subject id" value={draft.subjectId} onChange={(v) => set({ subjectId: v })} placeholder="UUID" />
          <Select label="Service" value={draft.producer || null} options={AUDIT_PRODUCERS} onChange={(v) => set({ producer: v ?? '' })} placeholder="Any" />
          <Input label="From" type="date" value={draft.from} onChange={(v) => set({ from: v })} />
          <Input label="To" type="date" value={draft.to} onChange={(v) => set({ to: v })} />
        </div>
        {errors.length > 0 && (
          <div role="alert" className="err-note">
            {errors.join(' ')}
          </div>
        )}
        <div className="row">
          <button type="submit" className="btn primary sm">
            Apply filters
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setDraft(EMPTY_AUDIT_FILTERS);
              apply(EMPTY_AUDIT_FILTERS);
            }}
          >
            Clear
          </button>
          {Object.keys(applied).length > 0 && (
            <span className="faint small">
              Filtered by {Object.entries(applied).map(([k, v]) => `${k}=${k === 'actorUserId' ? (actorOptions.find((a) => a.value === v)?.label ?? shortId(v)) : v}`).join(', ')}
            </span>
          )}
        </div>
      </form>

      {log.error !== undefined && <SettingsError error={log.error} onReload={() => void log.reload()} />}
      <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Via</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {log.items.map((e) => (
              <tr key={e.auditId}>
                <td style={{ whiteSpace: 'nowrap' }}>{date(e.occurredAt, true)}</td>
                <td>{e.actorDisplayName ?? <span className="mono">{shortId(e.actorUserId)}</span>}</td>
                <td>
                  <span className="mono">{e.action}</span>
                  <div className="faint small">{e.producer}</div>
                </td>
                <td>
                  {e.subjectType} <span className="mono faint">{shortId(e.subjectId)}</span>
                </td>
                <td>
                  <Chip>{e.via}</Chip>
                </td>
                <td className="small">{formatDetails(e.details) || '—'}</td>
              </tr>
            ))}
            {!log.loading && log.items.length === 0 && !log.error && (
              <tr>
                <td colSpan={6} className="muted">
                  No entries match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {log.loading && <Loading label="Loading audit log" />}
      {log.hasMore && !log.loading && (
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void log.more()}>
          Load more
        </button>
      )}
    </Section>
  );
}
