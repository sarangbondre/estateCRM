'use client';
// Settings → MahaRERA & publication (WEB-08; US-34, BRD §4.6, questionnaire A7): the 11 Estates MahaRERA agent
// registration number and the "subject to confirmation" note shown on every listing (Admin). While the number is not
// set, the pilot shows "MahaRERA registration pending"; production needs it before any listing is served.
// Contract: listings getPublicationSettings, putPublicationSettings (If-Match version → 412).
import { useEffect, useState } from 'react';
import { ApiError, call, useResource } from '../lib/api';
import { date } from '../lib/format';
import { ActionButton, Chip, Done, Loading, useAction } from '../cards/Card';
import { Input } from '../cards/common';
import type { TabProps } from './types';
import { Section, SettingsError } from './shared';
import { reraPending, validateRera } from './logic';
import type { PublicationSettings } from './logic';

const DEFAULT_NOTE = 'Details subject to confirmation';
// What the tab shows before the number is first saved (no version yet, so the first save sends no If-Match).
const NOT_SET: PublicationSettings = {
  mahareraAgentNumber: '',
  subjectToConfirmationNote: DEFAULT_NOTE,
  version: 0,
  updatedAt: '',
};

export function PublicationTab({ editable, shell }: TabProps) {
  const res = useResource<PublicationSettings>('/v1/publication-settings');
  // listings answers 404 until the number is first saved: that is "registration pending", not an error.
  const notSet = res.error instanceof ApiError && res.error.status === 404;
  const current = res.data ?? (notSet ? NOT_SET : undefined);
  const [rera, setRera] = useState('');
  const [note, setNote] = useState(DEFAULT_NOTE);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!res.data) return;
    setRera(res.data.mahareraAgentNumber ?? '');
    setNote(res.data.subjectToConfirmationNote ?? DEFAULT_NOTE);
  }, [res.data]);

  const reraError = tried ? validateRera(rera) : null;
  const noteError = note.length > 120 ? 'The note is at most 120 characters.' : null;
  const save = useAction(
    () =>
      call<PublicationSettings>('PUT', '/v1/publication-settings', {
        body: {
          mahareraAgentNumber: rera.trim().toUpperCase(),
          subjectToConfirmationNote: note.trim() || DEFAULT_NOTE,
        },
        ...(res.data ? { ifMatch: res.data.version } : {}),
      }),
    () => {
      setDone(true);
      setTried(false);
      res.reload();
    },
  );
  const pending = reraPending(current);

  return (
    <Section
      title="MahaRERA registration"
      actions={
        current ? (
          pending ? (
            <Chip tone="warn">Registration pending</Chip>
          ) : (
            <Chip tone="good">Set</Chip>
          )
        ) : undefined
      }
      note={
        pending
          ? shell.me.environment.pilot
            ? 'Pilot: publishing is allowed and every listing shows "MahaRERA registration pending". The number is mandatory before production.'
            : 'Listings show "MahaRERA registration pending" until the number is set; production needs it before any listing is served.'
          : 'Shown on every listing. A change refreshes every public item.'
      }
    >
      {res.error !== undefined && !current ? (
        <SettingsError error={res.error} onReload={res.reload} />
      ) : !current ? (
        <Loading />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            setDone(false);
            if (!validateRera(rera) && !noteError) void save.run();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {editable ? (
            <div className="form-grid">
              <Input
                label="11 Estates MahaRERA agent number"
                value={rera}
                onChange={(v) => setRera(v.toUpperCase())}
                placeholder="e.g. A51900012345"
                required
              />
              <Input label="Listing note" value={note} onChange={setNote} placeholder={DEFAULT_NOTE} />
            </div>
          ) : (
            <p style={{ margin: 0 }}>
              <span className="mono">{current.mahareraAgentNumber || 'Registration pending'}</span> ·{' '}
              {current.subjectToConfirmationNote ?? DEFAULT_NOTE}
            </p>
          )}
          {(reraError || noteError) && (
            <div role="alert" className="err-note">
              {[reraError, noteError].filter(Boolean).join(' ')}
            </div>
          )}
          {editable && (
            <div className="row">
              <ActionButton type="submit" primary pending={save.pending}>
                Save
              </ActionButton>
              {done && <Done>Saved; public listings are being refreshed</Done>}
            </div>
          )}
          {save.error !== undefined && <SettingsError error={save.error} onReload={res.reload} />}
          {current.updatedAt && (
            <span className="faint small">Last changed {date(current.updatedAt, true)}</span>
          )}
        </form>
      )}
    </Section>
  );
}
