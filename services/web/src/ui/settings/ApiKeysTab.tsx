'use client';
// Settings → API keys (WEB-08; US-34, PRD §4.9 Listings API): one key per website or microsite (Admin). The secret is
// shown once after create / rotate with a copy button. Contract: listings listApiKeys, createApiKey, rotateApiKey
// (grace period, Idempotency-Key), revokeApiKey.
import { useState } from 'react';
import { call } from '../lib/api';
import { date, relative } from '../lib/format';
import { ActionButton, Chip, Loading, useAction } from '../cards/Card';
import { Input, usePaged } from '../cards/common';
import type { TabProps } from './types';
import { NumberInput, Section, SettingsError } from './shared';
import { EMPTY_API_KEY, GRACE_RULE, STATUS_TONE, buildApiKey, checkNumber, validateApiKey } from './logic';
import type { ApiKey, ApiKeyDraft, ApiKeyWithSecret } from './logic';

export function ApiKeysTab({ shell }: TabProps) {
  const keys = usePaged<ApiKey>('/v1/api-keys', { limit: 50 });
  const [secret, setSecret] = useState<ApiKeyWithSecret | null>(null);
  const [adding, setAdding] = useState(false);
  const issued = (k: ApiKeyWithSecret) => {
    setSecret(k.secret ? k : null);
    if (!k.secret) shell.toast('Key issued. The secret was already shown once and cannot be shown again.');
    void keys.reload();
  };

  return (
    <>
      {secret && <SecretOnce apiKey={secret} onDismiss={() => setSecret(null)} toast={shell.toast} />}
      <Section
        title="Website API keys"
        note="Each site or microsite gets its own key for the Listings API. Only the first characters are kept for identification."
        actions={
          <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            {adding ? 'Close' : 'New key'}
          </button>
        }
      >
        {adding && (
          <CreateKeyForm
            onCreated={(k) => {
              setAdding(false);
              issued(k);
            }}
          />
        )}
        {keys.error !== undefined && <SettingsError error={keys.error} onReload={() => void keys.reload()} />}
        <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Key</th>
                <th>Status</th>
                <th>Rate limit</th>
                <th>Last used</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.items.map((k) => (
                <KeyRow key={k.keyId} k={k} onIssued={issued} onChanged={() => void keys.reload()} />
              ))}
              {!keys.loading && keys.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No API keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {keys.loading && <Loading />}
        {keys.hasMore && !keys.loading && (
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void keys.more()}>
            Load more
          </button>
        )}
      </Section>
    </>
  );
}

function SecretOnce({ apiKey, onDismiss, toast }: { apiKey: ApiKeyWithSecret; onDismiss: () => void; toast: (m: string) => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.secret ?? '');
      toast('Key copied');
    } catch {
      toast('Copy failed. Select the key and copy it by hand.');
    }
  };
  return (
    <div className="card" role="region" aria-label="New API key secret" style={{ borderColor: 'var(--warn)' }}>
      <div className="card-b">
        <p role="alert" style={{ margin: 0 }}>
          <b>Copy this key now.</b> It is shown only once and cannot be recovered; if it is lost, rotate the key.
        </p>
        <div className="row">
          <span className="muted small">{apiKey.name}</span>
          <code className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>
            {apiKey.secret}
          </code>
        </div>
        <div className="row">
          <button type="button" className="btn primary sm" onClick={() => void copy()}>
            Copy key
          </button>
          <button type="button" className="btn sm" onClick={onDismiss}>
            I have stored it
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateKeyForm({ onCreated }: { onCreated: (k: ApiKeyWithSecret) => void }) {
  const [d, setD] = useState<ApiKeyDraft>(EMPTY_API_KEY);
  const [tried, setTried] = useState(false);
  const errors = tried ? validateApiKey(d) : [];
  const create = useAction(
    (key) => call<ApiKeyWithSecret>('POST', '/v1/api-keys', { body: buildApiKey(d), idempotencyKey: key }).then((r) => r.data),
    (k) => onCreated(k),
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (validateApiKey(d).length === 0) void create.run();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div className="form-grid">
        <Input label="Site name" value={d.name} onChange={(v) => setD({ ...d, name: v })} placeholder='e.g. "11estates.in"' required />
        <NumberInput label="Requests per second" value={d.rateLimitRps} onChange={(v) => setD({ ...d, rateLimitRps: v })} min={1} max={50} integer />
        <NumberInput label="Burst" value={d.burst} onChange={(v) => setD({ ...d, burst: v })} min={1} max={100} integer />
      </div>
      <Input
        label="Allowed origins (optional, space or comma separated)"
        value={d.origins}
        onChange={(v) => setD({ ...d, origins: v })}
        placeholder="https://11estates.in"
      />
      {errors.length > 0 && (
        <div role="alert" className="err-note">
          {errors.join(' ')}
        </div>
      )}
      <div className="row">
        <ActionButton type="submit" primary small pending={create.pending}>
          Create key
        </ActionButton>
      </div>
      {create.error !== undefined && <SettingsError error={create.error} />}
    </form>
  );
}

function KeyRow({ k, onIssued, onChanged }: { k: ApiKey; onIssued: (k: ApiKeyWithSecret) => void; onChanged: () => void }) {
  const [mode, setMode] = useState<'none' | 'rotate' | 'revoke'>('none');
  const [grace, setGrace] = useState(String(GRACE_RULE.default));
  const graceError = checkNumber(grace, GRACE_RULE);
  const rotate = useAction(
    (key) =>
      call<ApiKeyWithSecret>('POST', `/v1/api-keys/${encodeURIComponent(k.keyId)}/rotate`, {
        body: { graceHours: Number(grace) },
        idempotencyKey: key,
      }).then((r) => r.data),
    (nk) => {
      setMode('none');
      onIssued(nk);
    },
  );
  const revoke = useAction(
    (key) => call<ApiKey>('POST', `/v1/api-keys/${encodeURIComponent(k.keyId)}/revoke`, { idempotencyKey: key }),
    () => {
      setMode('none');
      onChanged();
    },
  );
  const live = k.status !== 'revoked';

  return (
    <tr>
      <td>
        {k.name}
        {(k.allowedOrigins ?? []).length > 0 && <div className="faint small">{(k.allowedOrigins ?? []).slice(0, 3).join(', ')}</div>}
      </td>
      <td className="mono">{k.prefix}…</td>
      <td>
        <Chip tone={STATUS_TONE[k.status] ?? 'plain'}>{k.status}</Chip>
        {k.status === 'rotating' && k.graceEndsAt && <div className="faint small">old key valid until {date(k.graceEndsAt, true)}</div>}
      </td>
      <td className="small">
        {k.rateLimitRps ?? '—'}/s{k.burst ? `, burst ${k.burst}` : ''}
      </td>
      <td>{k.lastUsedAt ? relative(k.lastUsedAt) : 'never'}</td>
      <td>
        {live && mode === 'none' && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {k.status === 'active' && (
              <button type="button" className="btn sm" onClick={() => setMode('rotate')}>
                Rotate<span className="sr-only"> {k.name}</span>
              </button>
            )}
            <button type="button" className="btn sm" onClick={() => setMode('revoke')}>
              Revoke<span className="sr-only"> {k.name}</span>
            </button>
          </div>
        )}
        {mode === 'rotate' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <NumberInput
              label="Old key stays valid for (hours)"
              value={grace}
              onChange={setGrace}
              error={graceError ?? undefined}
              min={GRACE_RULE.min}
              max={GRACE_RULE.max}
              integer
            />
            <div className="row">
              <ActionButton small primary disabled={Boolean(graceError)} pending={rotate.pending} onClick={() => void rotate.run()}>
                Issue new key
              </ActionButton>
              <button type="button" className="btn sm ghost" onClick={() => setMode('none')}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {mode === 'revoke' && (
          <div className="row">
            <span className="small">The site stops working within 30 s.</span>
            <ActionButton small danger pending={revoke.pending} onClick={() => void revoke.run()}>
              Confirm revoke
            </ActionButton>
            <button type="button" className="btn sm ghost" onClick={() => setMode('none')}>
              Cancel
            </button>
          </div>
        )}
        {rotate.error !== undefined && <SettingsError error={rotate.error} onReload={onChanged} />}
        {revoke.error !== undefined && <SettingsError error={revoke.error} onReload={onChanged} />}
      </td>
    </tr>
  );
}
