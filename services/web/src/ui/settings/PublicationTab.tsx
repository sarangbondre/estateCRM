'use client';
// Settings → MahaRERA & publication (WEB-08; US-34, BRD §4.6, questionnaire A7): the 11 Estates MahaRERA agent
// registration number and the "subject to confirmation" note shown on every listing (Admin). While the number is not
// set, the pilot shows "MahaRERA registration pending"; production needs it before any listing is served.
// Contract: listings getPublicationSettings, putPublicationSettings (If-Match version → 412).
import { useEffect, useState } from 'react';
import { call, useResource } from '../lib/api';
import { date } from '../lib/format';
import { ActionButton, Chip, Done, Loading, useAction } from '../cards/Card';
import { Input } from '../cards/common';
import type { TabProps } from './types';
import { Section, SettingsError } from './shared';
import { reraPending, validateRera } from './logic';
import type { PublicationSettings } from './logic';

const DEFAULT_NOTE = 'Details subject to confirmation';

export function PublicationTab({ editable, shell }: TabProps) {
  const res = useResource<PublicationSettings>('/v1/publication-settings');
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
        body: { mahareraAgentNumber: rera.trim().toUpperCase(), subjectToConfirmationNote: note.trim() || DEFAULT_NOTE },
        ...(res.data ? { ifMatch: res.data.version } : {}),
      }),
    () => {
      setDone(true);
      setTried(false);
      res.reload();
    },
  );
  const pending = reraPending(res.data);

  return (
    <Section
      title="MahaRERA registration"
      actions={
        res.data ? pending ? <Chip tone="warn">Registration pending</Chip> : <Chip tone="good">Set</Chip> : undefined
      }
      note={
        pending
          ? shell.me.environment.pilot
            ? 'Pilot: publishing is allowed and every listing shows "MahaRERA registration pending". The number is mandatory before production.'
            : 'Listings show "MahaRERA registration pending" until the number is set; production needs it before any listing is served.'
          : 'Shown on every listing. A change refreshes every public item.'
      }
    >
      {res.error !== undefined && !res.data ? (
        <SettingsError error={res.error} onReload={res.reload} />
      ) : !res.data ? (
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
              <span className="mono">{res.data.mahareraAgentNumber || 'Registration pending'}</span> · {res.data.subjectToConfirmationNote ?? DEFAULT_NOTE}
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
          {res.data.updatedAt && <span className="faint small">Last changed {date(res.data.updatedAt, true)}</span>}
        </form>
      )}
    </Section>
  );
}
