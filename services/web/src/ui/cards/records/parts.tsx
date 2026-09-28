'use client';
// Shared pieces of the records cards and panels: the "Show contact" reveal (records POST /v1/reveals, audit-logged,
// R-VIS-3), paged lists with "Load more", and a loading / error guard.
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { components } from '@11e/contracts/records';
import { call, newIdempotencyKey } from '../../lib/api';
import type { Resource } from '../../lib/api';
import { ActionButton, ErrorNote, Loading, useAction } from '../Card';
import { Select, usePaged } from '../common';
import { buildRevealRequest, REVEAL_PURPOSES } from './logic';
import type { RevealPurpose } from './logic';

type RevealResult = components['schemas']['RevealResult'];
type SubjectType = components['schemas']['RevealRequest']['subjectType'];

export interface RevealSubject {
  type: SubjectType;
  id: string;
  label: string;
}

/**
 * "Show contact": reveals the subjects' contact / unit fields for this view only. Values live in component memory
 * (never in card props, the conversation or logs) and are dropped on "Hide" or when the panel closes.
 */
export function RevealContact({ subjects, label = 'Show contact' }: { subjects: RevealSubject[]; label?: string }) {
  const [purpose, setPurpose] = useState<RevealPurpose | null>('call');
  const [shown, setShown] = useState<{ subject: RevealSubject; result: RevealResult }[] | null>(null);
  // One Idempotency-Key (UUID) per subject and purpose, kept until the reveal succeeds, so a retry is not a second view.
  const keys = useRef<Record<string, string>>({});
  const reveal = useAction(
    async () => {
      const out: { subject: RevealSubject; result: RevealResult }[] = [];
      for (const s of subjects) {
        const k = `${s.type}:${s.id}:${purpose ?? 'other'}`;
        keys.current[k] ??= newIdempotencyKey();
        const r = await call<RevealResult>('POST', '/v1/reveals', {
          body: buildRevealRequest(s.type, s.id, purpose ?? 'other'),
          idempotencyKey: keys.current[k],
        });
        out.push({ subject: s, result: r.data });
      }
      return out;
    },
    (out) => {
      keys.current = {};
      setShown(out);
    },
  );
  if (!subjects.length) return null;
  if (shown)
    return (
      <div className="box" aria-live="polite">
        {shown.map(({ subject, result }) => (
          <RevealedFields key={subject.id} label={subject.label} fields={result.fields ?? {}} />
        ))}
        <p className="small faint">Viewed for {purpose}; this view is audit-logged.</p>
        <button type="button" className="btn sm" onClick={() => setShown(null)}>
          Hide contact
        </button>
      </div>
    );
  return (
    <div className="row" style={{ alignItems: 'flex-end' }}>
      <Select
        label="Purpose"
        value={purpose}
        options={REVEAL_PURPOSES}
        onChange={(v) => setPurpose(v as RevealPurpose | null)}
        required
      />
      <ActionButton small onClick={reveal.run} pending={reveal.pending} disabled={!purpose}>
        {label}
      </ActionButton>
      {reveal.error !== undefined && <ErrorNote error={reveal.error} />}
    </div>
  );
}

function RevealedFields({ label, fields }: { label: string; fields: RevealResult['fields'] }) {
  const rows: [string, string][] = [];
  if (fields.name) rows.push(['Name', fields.name]);
  for (const p of fields.phones ?? []) rows.push(['Phone', p]);
  if (fields.whatsappPhone) rows.push(['WhatsApp', fields.whatsappPhone]);
  for (const e of fields.emails ?? []) rows.push(['Email', e]);
  if (fields.otherContact) rows.push(['Other', fields.otherContact]);
  if (fields.wing) rows.push(['Wing', fields.wing]);
  if (fields.unitNo) rows.push(['Unit', fields.unitNo]);
  if (fields.floorNo != null) rows.push(['Floor', String(fields.floorNo)]);
  return (
    <div>
      <div className="qh">{label}</div>
      {rows.length ? (
        <dl className="kv">
          {rows.map(([k, v], i) => (
            <div key={`${k}-${i}`} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd className="mono">{k === 'Phone' || k === 'WhatsApp' ? <a href={`tel:${v}`}>{v}</a> : v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="small muted">No contact details on file.</p>
      )}
    </div>
  );
}

/** Renders children once a resource has loaded; loading and error states otherwise. */
export function Loaded<T>({
  res,
  children,
  label,
}: {
  res: Resource<T>;
  children: (data: T) => ReactNode;
  label?: string;
}) {
  if (res.data !== undefined) return <>{children(res.data)}</>;
  if (res.error !== undefined) return <ErrorNote error={res.error} onRetry={res.reload} />;
  return <Loading {...(label ? { label } : {})} />;
}

/** A cursor-paged list (25 rows a page, then "Load more"). */
export function PagedList<T>({
  path,
  query,
  empty,
  render,
  title,
  filter,
}: {
  path: string | null;
  query?: Record<string, string | number | boolean | null | undefined>;
  empty: string;
  render: (item: T, index: number) => ReactNode;
  title?: string;
  filter?: (item: T) => boolean;
}) {
  const page = usePaged<T>(path, { limit: 25, ...(query ?? {}) });
  const items = filter ? page.items.filter(filter) : page.items;
  return (
    <div>
      {title && <div className="qh">{title}</div>}
      {items.map((it, i) => render(it, i))}
      {page.loading && <Loading />}
      {page.error !== undefined && <ErrorNote error={page.error} onRetry={() => void page.reload()} />}
      {!page.loading && page.error === undefined && items.length === 0 && <p className="small muted">{empty}</p>}
      {page.hasMore && !page.loading && (
        <button type="button" className="btn sm" onClick={() => void page.more()}>
          Load more
        </button>
      )}
    </div>
  );
}

/** A small follow-up button that sends a chat command (the resulting card acts only on a click, R-CHAT-1). */
export function SendButton({ text, children, send }: { text: string; children: ReactNode; send: (t: string) => void }) {
  return (
    <button type="button" className="btn sm" onClick={() => send(text)}>
      {children}
    </button>
  );
}

/** A chip list of strings, or "—". */
export function List({ values }: { values: readonly (string | null | undefined)[] | null | undefined }) {
  const v = (values ?? []).filter((x): x is string => typeof x === 'string' && x !== '');
  return v.length ? <>{v.join(', ')}</> : <>—</>;
}
