'use client';
// Settings → Micromarkets (WEB-08; US-34, R-13, CR-006 Z-7): the zone → micromarket → locality → sub-locality hierarchy
// with aliases and adjacency, and the launch area (enabled cities). Admin edits. Contract: records listMicromarkets,
// createMicromarket (Idempotency-Key), patchMicromarket (merge patch + If-Match), getLaunchArea / putLaunchArea
// (If-Match; 202, flags recomputed asynchronously).
import { useEffect, useState } from 'react';
import { call, useResource } from '../lib/api';
import { ActionButton, Chip, Done, Loading, useAction } from '../cards/Card';
import { Checkbox, Input, Select, usePaged } from '../cards/common';
import type { TabProps } from './types';
import { Section, SettingsError } from './shared';
import {
  LEVEL_LABEL,
  MICROMARKET_LEVELS,
  buildMicromarketInput,
  buildMicromarketPatch,
  micromarketDraft,
  parentLevel,
  validateMicromarket,
} from './logic';
import type { LaunchArea, Micromarket, MicromarketDraft, MicromarketLevel } from './logic';

const LEVEL_OPTIONS = MICROMARKET_LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l] ?? l }));

export function MicromarketsTab({ editable, shell }: TabProps) {
  const [level, setLevel] = useState<MicromarketLevel | null>('micromarket');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const query = { limit: 50, ...(level ? { level } : {}), ...(q.trim().length >= 2 ? { q: q.trim() } : {}) };
  const list = usePaged<Micromarket>('/v1/micromarkets', query);
  const names = new Map(list.items.map((m) => [m.id, m.name]));

  return (
    <>
      <LaunchAreaSection editable={editable} />
      <Section
        title="Hierarchy"
        note="Zone → micromarket → locality → sub-locality. Names and aliases resolve locations in uploads and quick add; adjacent micromarkets count as near for matching."
        actions={
          editable && (
            <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>
              {adding ? 'Close' : 'Add a node'}
            </button>
          )
        }
      >
        {editable && adding && (
          <MicromarketForm
            onSaved={(m) => {
              shell.toast(`${LEVEL_LABEL[m.level] ?? m.level} ${m.name} added`);
              setAdding(false);
              void list.reload();
            }}
          />
        )}
        <div className="filters row">
          <Select label="Level" value={level} options={LEVEL_OPTIONS} onChange={(v) => setLevel(v as MicromarketLevel | null)} placeholder="All levels" />
          <Input label="Search name or alias" value={q} onChange={setQ} placeholder="at least 2 letters" />
        </div>
        {list.error !== undefined && <SettingsError error={list.error} onReload={() => void list.reload()} />}
        <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Level</th>
                <th>City</th>
                <th>Aliases</th>
                <th>Launch area</th>
                {editable && (
                  <th>
                    <span className="sr-only">Edit</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {list.items.map((m) => (
                <MicromarketRow key={m.id} m={m} editable={editable} parentName={m.parentId ? names.get(m.parentId) : undefined} onSaved={() => void list.reload()} />
              ))}
              {!list.loading && list.items.length === 0 && (
                <tr>
                  <td colSpan={editable ? 6 : 5} className="muted">
                    Nothing found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {list.loading && <Loading label="Loading micromarkets" />}
        {list.hasMore && !list.loading && (
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void list.more()}>
            Load more
          </button>
        )}
      </Section>
    </>
  );
}

function MicromarketRow({ m, editable, parentName, onSaved }: { m: Micromarket; editable: boolean; parentName: string | undefined; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const aliases = m.aliases ?? [];
  return (
    <>
      <tr>
        <td>
          {m.name}
          {parentName && <div className="faint small">in {parentName}</div>}
        </td>
        <td>{LEVEL_LABEL[m.level] ?? m.level}</td>
        <td>{m.city}</td>
        <td className="small">{aliases.length ? aliases.slice(0, 8).join(', ') + (aliases.length > 8 ? ` +${aliases.length - 8}` : '') : '—'}</td>
        <td>{m.inLaunchArea ? <Chip tone="good">In</Chip> : <Chip>Outside</Chip>}</td>
        {editable && (
          <td>
            <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Close' : 'Edit'}
              <span className="sr-only"> {m.name}</span>
            </button>
          </td>
        )}
      </tr>
      {editable && open && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
            <MicromarketForm
              key={m.version}
              existing={m}
              onSaved={() => {
                setOpen(false);
                onSaved();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

const EMPTY: MicromarketDraft = { level: 'micromarket', name: '', city: 'Mumbai', parentId: null, aliases: '', adjacentIds: [] };

/** Create (no `existing`) or edit a node. Parent and adjacency choices come from the same list endpoint. */
function MicromarketForm({ existing, onSaved }: { existing?: Micromarket; onSaved: (m: Micromarket) => void }) {
  const [d, setD] = useState<MicromarketDraft>(() => (existing ? micromarketDraft(existing) : EMPTY));
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pLevel = parentLevel(d.level);
  const parents = usePaged<Micromarket>(pLevel ? '/v1/micromarkets' : null, pLevel ? { level: pLevel, limit: 100 } : undefined);
  const peers = usePaged<Micromarket>(d.level === 'micromarket' ? '/v1/micromarkets' : null, { level: 'micromarket', limit: 100 });
  const errors = tried ? validateMicromarket(d, !existing) : [];

  const save = useAction(
    (key) => {
      if (existing) {
        const patch = buildMicromarketPatch(existing, d);
        return call<Micromarket>('PATCH', `/v1/micromarkets/${encodeURIComponent(existing.id)}`, {
          body: patch ?? {},
          contentType: 'application/merge-patch+json',
          ifMatch: existing.version,
        }).then((r) => r.data);
      }
      return call<Micromarket>('POST', '/v1/micromarkets', { body: buildMicromarketInput(d), idempotencyKey: key }).then((r) => r.data);
    },
    (m) => onSaved(m),
  );

  const submit = () => {
    setTried(true);
    if (validateMicromarket(d, !existing).length) return;
    if (existing && !buildMicromarketPatch(existing, d)) return setNote('Nothing changed.');
    setNote(null);
    void save.run();
  };

  const parentOptions = parents.items.map((p) => ({ value: p.id, label: `${p.name} (${p.city})` }));
  const peerOptions = peers.items.filter((p) => p.id !== existing?.id);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0' }}
    >
      <div className="form-grid">
        {!existing && (
          <Select
            label="Level"
            value={d.level}
            options={LEVEL_OPTIONS}
            onChange={(v) => v && setD({ ...d, level: v as MicromarketLevel, parentId: null, adjacentIds: [] })}
            required
          />
        )}
        <Input label="Name" value={d.name} onChange={(v) => setD({ ...d, name: v })} required />
        {!existing && <Input label="City" value={d.city} onChange={(v) => setD({ ...d, city: v })} required />}
        {pLevel && (
          <Select
            label={`Parent ${LEVEL_LABEL[pLevel] ?? pLevel}`}
            value={d.parentId}
            options={parentOptions}
            onChange={(v) => setD({ ...d, parentId: v })}
            required={!existing}
          />
        )}
      </div>
      <Input label="Aliases (comma separated)" value={d.aliases} onChange={(v) => setD({ ...d, aliases: v })} placeholder="e.g. Andheri E, Andheri (E)" />
      {d.level === 'micromarket' && peerOptions.length > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted">Adjacent micromarkets (near for matching, up to 30)</legend>
          <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>
            {peerOptions.slice(0, 100).map((p) => (
              <Checkbox
                key={p.id}
                label={p.name}
                checked={d.adjacentIds.includes(p.id)}
                onChange={(on) =>
                  setD({ ...d, adjacentIds: on ? [...d.adjacentIds, p.id] : d.adjacentIds.filter((x) => x !== p.id) })
                }
              />
            ))}
          </div>
        </fieldset>
      )}
      {(errors.length > 0 || note) && (
        <div role="alert" className="err-note">
          {[...errors, ...(note ? [note] : [])].join(' ')}
        </div>
      )}
      <div className="row">
        <ActionButton type="submit" primary small pending={save.pending}>
          {existing ? 'Save changes' : 'Add'}
        </ActionButton>
        {existing && <span className="faint small">Existing records are re-resolved by a background job.</span>}
      </div>
      {save.error !== undefined && <SettingsError error={save.error} />}
    </form>
  );
}

function LaunchAreaSection({ editable }: { editable: boolean }) {
  const res = useResource<LaunchArea>('/v1/launch-area');
  const [cities, setCities] = useState<{ name: string; enabled: boolean }[]>([]);
  const [newCity, setNewCity] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (res.data) setCities((res.data.cities ?? []).map((c) => ({ name: c.name, enabled: c.enabled })));
  }, [res.data]);
  const dirty = JSON.stringify(cities) !== JSON.stringify((res.data?.cities ?? []).map((c) => ({ name: c.name, enabled: c.enabled })));
  const save = useAction(
    () => call<LaunchArea>('PUT', '/v1/launch-area', { body: { cities }, ...(res.data ? { ifMatch: res.data.version } : {}) }),
    () => {
      setDone(true);
      res.reload();
    },
  );

  const add = () => {
    const name = newCity.trim();
    if (!name || cities.some((c) => c.name.toLowerCase() === name.toLowerCase()) || cities.length >= 200) return;
    setCities([...cities, { name, enabled: true }]);
    setNewCity('');
    setDone(false);
  };

  return (
    <Section
      title="Launch area"
      note="Cities enabled for queues, matching and listings. Records outside are kept but flagged; flags are recomputed in the background after a change."
      actions={res.data?.recomputeStatus ? <Chip tone={res.data.recomputeStatus === 'done' ? 'good' : 'warn'}>Recompute {res.data.recomputeStatus}</Chip> : undefined}
    >
      {res.error !== undefined && !res.data ? (
        <SettingsError error={res.error} onReload={res.reload} />
      ) : !res.data ? (
        <Loading />
      ) : (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>
            {cities.length === 0 && <span className="muted small">No cities yet.</span>}
            {cities.map((c, i) =>
              editable ? (
                <Checkbox
                  key={c.name}
                  label={c.name}
                  checked={c.enabled}
                  onChange={(on) => {
                    setCities(cities.map((x, k) => (k === i ? { ...x, enabled: on } : x)));
                    setDone(false);
                  }}
                />
              ) : (
                <Chip key={c.name} tone={c.enabled ? 'good' : 'plain'}>
                  {c.name}: {c.enabled ? 'enabled' : 'off'}
                </Chip>
              ),
            )}
          </div>
          {editable && (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Input label="Add a city" value={newCity} onChange={setNewCity} placeholder="e.g. Thane" />
              <button type="button" className="btn sm" onClick={add} disabled={!newCity.trim()}>
                Add city
              </button>
              <ActionButton primary small disabled={!dirty} pending={save.pending} onClick={() => void save.run()}>
                Save launch area
              </ActionButton>
              {done && <Done>Saved; flags are being recomputed</Done>}
            </div>
          )}
          {save.error !== undefined && <SettingsError error={save.error} onReload={res.reload} />}
        </>
      )}
    </Section>
  );
}
