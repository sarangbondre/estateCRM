'use client';
// Shared insight views: the data table (C-03 in chat, P-07 in the panel), figures, the Excel export button
// (US-32, insight createExport) and the proposed-action card (R-CHAT-1: nothing runs until the click; the request goes
// through web's gateway with the card's own Idempotency-Key and the owning service re-checks permissions).
import { useId, useState } from 'react';
import type { operations } from '@11e/contracts/insight';
import { call } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { count, date, inr } from '../../lib/format';
import type { ShellActions } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, useAction } from '../Card';
import { RecordLink } from '../common';
import { actionAvailability, buildActionRequest, cleanFileName, fieldKind, humanize } from './logic';
import type { ActionPart, AnswerPart, Column, QueryPlan, Row, SortDir } from './logic';

export function Cell({ value, type, shell }: { value: unknown; type: Column['type'] | string; shell: ShellActions }) {
  if (value === null || value === undefined || value === '') return <>—</>;
  switch (type) {
    case 'inr':
      return <>{inr(Number(value))}</>;
    case 'number':
    case 'integer':
      return <>{typeof value === 'number' ? count(value) : String(value)}</>;
    case 'date':
      return <>{date(String(value))}</>;
    case 'datetime':
      return <>{date(String(value), true)}</>;
    case 'boolean':
      return <>{value === true ? 'Yes' : value === false ? 'No' : String(value)}</>;
    case 'code':
      return <RecordLink code={String(value)} shell={shell} />;
    case 'user':
      return <span className="mono small">{String(value).slice(0, 8)}</span>;
    default:
      return <>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</>;
  }
}

const NUMERIC = new Set(['number', 'integer', 'inr']);

/** A result table (prototype .tw table). Sorting is optional (P-07); rows are capped by the caller. */
export function DataTable({
  columns,
  rows,
  shell,
  caption,
  sort,
  onSort,
}: {
  columns: readonly Column[];
  rows: readonly Row[];
  shell: ShellActions;
  caption?: string;
  sort?: { key: string; dir: SortDir } | null;
  onSort?: (key: string) => void;
}) {
  if (!columns.length) return <p className="small muted">No columns in this result.</p>;
  return (
    <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table">
      <table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th key={c.key} scope="col" className={NUMERIC.has(c.type) ? 'n' : undefined} aria-sort={ariaSort}>
                  {onSort ? (
                    <button type="button" className="btn ghost sm" style={{ padding: 0, font: 'inherit', textTransform: 'inherit' }} onClick={() => onSort(c.key)}>
                      {c.label || c.key}
                      {active ? (sort?.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : (
                    c.label || c.key
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="muted">
                No rows.
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className={NUMERIC.has(c.type) ? 'n' : undefined}>
                    <Cell value={r[c.key]} type={c.type} shell={shell} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const UNIT: Record<string, (v: number) => string> = {
  inr: inr,
  inr_per_month: (v) => `${inr(v)} / month`,
  sqft: (v) => `${count(v)} sq ft`,
  days: (v) => `${count(v)} days`,
  pct: (v) => `${Number(v.toFixed(1))}%`,
  count: count,
};

export const formatFigure = (value: number | null | undefined, unit?: string | null): string =>
  value == null || !Number.isFinite(value) ? '—' : (UNIT[unit ?? 'count'] ?? count)(value);

/** C-02 answer card from the stream: text and headline figures (prototype .kpis). */
export function AnswerFigures({ part }: { part: AnswerPart }) {
  const figures = (part.figures ?? []).slice(0, 8);
  return (
    <Card kicker="Answer">
      {part.text && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{part.text}</p>}
      {figures.length > 0 && (
        <div className="kpis">
          {figures.map((f, i) => (
            <div className="kpi" key={`${f.label ?? ''}-${i}`}>
              <div className="l">{f.label ?? '—'}</div>
              <div className="v">{formatFigure(f.value, f.unit)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** "Excel" (US-32): a background export of the same plan; shows the export code and offers to track it. */
export function ExportButton({
  plan,
  shell,
  sourceMessageId,
  fileName,
  small = true,
}: {
  plan: QueryPlan | null | undefined;
  shell: ShellActions;
  sourceMessageId?: string | null;
  fileName?: string;
  small?: boolean;
}) {
  const [started, setStarted] = useState<{ code: string } | null>(null);
  const action = useAction(
    (key) => {
      const body: Body<operations['createExport']> = {
        plan: plan as QueryPlan,
        includeContacts: false,
        ...(fileName && cleanFileName(fileName) ? { fileName: cleanFileName(fileName) } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
      };
      return call<Ok<operations['createExport']>>('POST', '/v1/exports', { body, idempotencyKey: key });
    },
    (r) => setStarted({ code: r.data?.code ?? r.data?.exportId ?? '' }),
  );
  if (!plan) return null;
  if (started)
    return (
      <span className="row">
        <Done>Export {started.code} started. You&apos;ll get a notification when it&apos;s ready.</Done>
        <button type="button" className="btn sm" onClick={() => shell.addCards([{ kind: 'exports', props: started.code ? { export: started.code } : {} }])}>
          Track it
        </button>
      </span>
    );
  return (
    <>
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <ActionButton small={small} onClick={action.run} pending={action.pending}>
        Excel
      </ActionButton>
    </>
  );
}

/** A proposed change from chat (C-04…C-21 as ProposedActionCard). Applies only on click. */
export function ProposedAction({
  part,
  shell,
  doneText,
  onDone,
}: {
  part: ActionPart;
  shell: ShellActions;
  doneText?: string;
  onDone: (text: string) => void;
}) {
  const editable = (part.editableFields ?? []).filter((f) => fieldKind(part.payload?.[f]) !== 'readonly');
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const available = actionAvailability(part, shell.me.role);
  const request = buildActionRequest(part, edits);

  const action = useAction(
    () => {
      if (typeof request === 'string') return Promise.reject(new Error(request));
      return call<Record<string, unknown> | undefined>(request.method, request.path, {
        body: request.body,
        idempotencyKey: request.idempotencyKey,
        contentType: request.contentType,
        ...(request.ifMatch !== undefined ? { ifMatch: request.ifMatch.replace(/^"|"$/g, '') } : {}),
      });
    },
    (r) => {
      const d = r.data;
      const code = d && typeof d === 'object' ? (d.code ?? d.displayCode ?? null) : null;
      onDone(`Done${code ? `: ${String(code)}` : ''}.`);
    },
  );

  const readOnlyFields = Object.entries(part.payload ?? {}).filter(([k]) => !editable.includes(k));

  return (
    <Card
      kicker={`Proposed · ${part.cardType ?? 'action'}`}
      title={part.title || humanize(part.targetOperation ?? 'action')}
      chips={<Chip tone="plain">{part.targetService}</Chip>}
      footer={
        doneText ? (
          <Done>{doneText}</Done>
        ) : (
          <>
            {action.error !== undefined && <ErrorNote error={action.error} />}
            {!available.ok && <span className="small muted">{available.reason}</span>}
            {typeof request === 'string' && <span className="small bd">{request}</span>}
            <span className="grow" />
            <ActionButton primary onClick={action.run} pending={action.pending} disabled={!available.ok || typeof request === 'string'}>
              Apply
            </ActionButton>
          </>
        )
      }
    >
      {part.summary && <p style={{ margin: 0 }}>{part.summary}</p>}
      {readOnlyFields.length > 0 && (
        <dl className="kv">
          {readOnlyFields.slice(0, 12).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{humanize(k)}</dt>
              <dd>{v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {editable.length > 0 && !doneText && (
        <div className="form-grid">
          {editable.map((f) => (
            <EditableField
              key={f}
              name={f}
              original={part.payload?.[f]}
              value={f in edits ? edits[f] : part.payload?.[f]}
              onChange={(v) => setEdits((e) => ({ ...e, [f]: v }))}
            />
          ))}
        </div>
      )}
      <p className="small faint" style={{ margin: 0 }}>
        Nothing changes until you click Apply.
      </p>
    </Card>
  );
}

function EditableField({
  name,
  original,
  value,
  onChange,
}: {
  name: string;
  original: unknown;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const kind = fieldKind(original);
  const id = `${useId()}-${name}`;
  if (kind === 'boolean')
    return (
      <div className="check">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id}>{humanize(name)}</label>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor={id}>{humanize(name)}</label>
      <input
        id={id}
        type={kind === 'number' ? 'number' : 'text'}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (kind === 'number') onChange(raw.trim() === '' || Number.isNaN(Number(raw)) ? null : Number(raw));
          else onChange(raw === '' && original === null ? null : raw);
        }}
      />
    </div>
  );
}
