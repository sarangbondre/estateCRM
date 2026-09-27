'use client';
// Settings → Vocabulary (WEB-08; US-37, D-16): the active controlled-vocabulary release, read-only for every role —
// changes ship only as a versioned release shared with the extractors. Contract: records getVocabulary,
// listVocabularyVersions.
import { useResource } from '../lib/api';
import { date } from '../lib/format';
import { Chip, Loading } from '../cards/Card';
import { usePaged } from '../cards/common';
import { Section, SettingsError } from './shared';
import type { VocabularyRelease, VocabularyVersion } from './logic';

export function VocabularyTab() {
  const vocab = useResource<VocabularyRelease>('/v1/vocabulary');
  const versions = usePaged<VocabularyVersion>('/v1/vocabulary/versions', { limit: 20 });
  const fields = Object.entries(vocab.data?.fields ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <Section
        title="Controlled vocabulary"
        actions={
          vocab.data?.version ? (
            <Chip tone="good">
              {vocab.data.version}
              {vocab.data.status ? ` · ${vocab.data.status}` : ''}
            </Chip>
          ) : undefined
        }
        note={
          <>
            <b>Read-only: changes only by versioned release.</b> The same values are used by the newspaper and WhatsApp
            extractors, so a change ships to all of them together (D-16).
            {vocab.data?.activatedAt ? ` Active since ${date(vocab.data.activatedAt)}.` : ''}
          </>
        }
      >
        {vocab.error !== undefined && !vocab.data ? (
          <SettingsError error={vocab.error} onReload={vocab.reload} />
        ) : !vocab.data ? (
          <Loading label="Loading vocabulary" />
        ) : (
          <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Values</th>
                </tr>
              </thead>
              <tbody>
                {fields.map(([name, f]) => {
                  const bySegment = Object.entries(f?.bySegment ?? {});
                  return (
                    <tr key={name}>
                      <td className="mono">
                        {name}
                        {f?.multi && <div className="faint small">multiple values</div>}
                      </td>
                      <td>
                        {(f?.values ?? []).length > 0 && <div>{(f?.values ?? []).join(', ')}</div>}
                        {bySegment.map(([seg, vals]) => (
                          <div key={seg} className="small">
                            <span className="muted">{seg}:</span> {(vals ?? []).join(', ')}
                          </div>
                        ))}
                        {(f?.values ?? []).length === 0 && bySegment.length === 0 && '—'}
                      </td>
                    </tr>
                  );
                })}
                {(vocab.data.recordScopes ?? []).length > 0 && (
                  <tr>
                    <td className="mono">record_scope</td>
                    <td>
                      {(vocab.data.recordScopes ?? []).map((r, i) => (
                        <div key={r.value ?? i} className="small">
                          <b>{r.value ?? '—'}</b>
                          {r.allowedDealTypes?.length ? ` · deal types: ${r.allowedDealTypes.join(', ')}` : ''}
                          {r.sides?.length ? ` · sides: ${r.sides.join(', ')}` : ''}
                          {r.routedTo ? ` · goes to ${r.routedTo}` : ''}
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Release history">
        {versions.error !== undefined && <SettingsError error={versions.error} onReload={() => void versions.reload()} />}
        <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Activated</th>
                <th>Checksum</th>
              </tr>
            </thead>
            <tbody>
              {versions.items.map((v) => (
                <tr key={`${v.version}:${v.checksum}`}>
                  <td className="mono">{v.version}</td>
                  <td>{v.status}</td>
                  <td>{date(v.activatedAt)}</td>
                  <td className="mono faint">{(v.checksum ?? '').slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {versions.loading && <Loading />}
        {versions.hasMore && !versions.loading && (
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void versions.more()}>
            Load more
          </button>
        )}
      </Section>
    </>
  );
}
