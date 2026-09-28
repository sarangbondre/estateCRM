'use client';
// Shared building blocks for cards and panels (prototype classes): tabs, key/value lists, controlled selects, status
// axes, life-curve bar, record links, paged lists.
import { useCallback, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { call } from '../lib/api';
import type { Query } from '../lib/api';
import { useVocabulary, valuesOf } from '../lib/vocabulary';
import type { ShellActions } from '../shell/types';
import { panelForCode } from '../chat/intents';

/** ARIA tabs (prototype .tabs). */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (t: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          id={`${id}-${t}`}
          aria-selected={t === value}
          tabIndex={t === value ? 0 : -1}
          onClick={() => onChange(t)}
          onKeyDown={(e) => {
            const i = tabs.indexOf(value);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length]!);
            if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length]!);
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/** Definition list (prototype dl.kv). Empty values render as "—". */
export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Labelled select from a fixed list (controlled vocabularies, enums). */
export function Select({
  label,
  value,
  options,
  onChange,
  required,
  placeholder = 'Choose…',
  disabled,
}: {
  label: string;
  value: string | null | undefined;
  options: readonly (string | { value: string; label: string })[];
  onChange: (v: string | null) => void;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        required={required}
        disabled={disabled}
        aria-required={required || undefined}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => {
          const v = typeof o === 'string' ? o : o.value;
          const l = typeof o === 'string' ? o : o.label;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
    </div>
  );
}

/** Select over a vocabulary field (e.g. `deal_type`), narrowed by segment when the field has per-segment values. */
export function VocabSelect(props: {
  field: string;
  label: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  segment?: string | null;
  required?: boolean;
  disabled?: boolean;
}) {
  const { vocab } = useVocabulary();
  const { field, segment, ...rest } = props;
  return <Select {...rest} options={valuesOf(vocab, field, segment)} />;
}

/** Text / number input with a label. */
export function Input({
  label,
  value,
  onChange,
  type = 'text',
  required,
  placeholder,
  inputMode,
  min,
  max,
}: {
  label: string;
  value: string | number | null | undefined;
  onChange: (v: string) => void;
  type?: 'text' | 'number' | 'date' | 'tel' | 'email' | 'datetime-local';
  required?: boolean;
  placeholder?: string;
  inputMode?: 'numeric' | 'decimal' | 'tel' | 'email' | 'text';
  min?: number | string;
  max?: number | string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        inputMode={inputMode}
        min={min}
        max={max}
      />
    </div>
  );
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** A status axis (prototype axis()): steps, the current one highlighted. */
export function Axis({ name, steps, current }: { name: string; steps: readonly string[]; current: string | null | undefined }) {
  const i = current ? steps.indexOf(current) : -1;
  return (
    <div className="axis">
      <span className="axis-n">{name}</span>
      <div className="steps" role="list" aria-label={`${name}: ${current ?? 'not started'}`}>
        {steps.map((s, k) => (
          <span key={s} role="listitem" className={`st ${k < i ? 'done' : k === i ? 'cur' : ''}`} aria-current={k === i ? 'step' : undefined}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

const STAGE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'plain'> = {
  Fresh: 'good',
  Ageing: 'warn',
  Stale: 'bad',
  Expired: 'bad',
  Paused: 'plain',
};

/** Life-curve stage chip (Fresh / Ageing / Stale / Expired / Paused) with the day count. */
export function LifeStage({ stage, day }: { stage: string | null | undefined; day?: number | null }) {
  if (!stage) return null;
  return (
    <span className={`chip ${STAGE_TONE[stage] ?? 'plain'}`}>
      {stage}
      {day != null ? ` · day ${day}` : ''}
    </span>
  );
}

/** A record code that opens its side panel (P-02…P-05). */
export function RecordLink({ code, shell }: { code: string | null | undefined; shell: ShellActions }) {
  if (!code) return <>—</>;
  const panel = panelForCode(code);
  if (!panel) return <span className="mono">{code}</span>;
  return (
    <button type="button" className="btn ghost sm mono" style={{ padding: '0 2px' }} onClick={() => shell.openPanel(panel)}>
      {code}
    </button>
  );
}

/** Cursor pagination (conventions §4): first page, then "Load more". */
export function usePaged<T>(path: string | null, query?: Query) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error?: unknown; done: boolean }>({ loading: path !== null, done: false });
  const key = JSON.stringify([path, query]);

  const fetchPage = useCallback(
    async (after: string | null, replace: boolean) => {
      if (!path) return;
      setState((s) => ({ ...s, loading: true }));
      try {
        const r = await call<{ items: T[]; nextCursor: string | null }>('GET', path, {
          query: { ...(query ?? {}), ...(after ? { cursor: after } : {}) },
        });
        setItems((prev) => (replace ? r.data.items : [...prev, ...r.data.items]));
        setCursor(r.data.nextCursor);
        setState({ loading: false, done: !r.data.nextCursor });
      } catch (error) {
        setState({ loading: false, error, done: false });
      }
    },
    [key],
  );

  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  return {
    items,
    loading: state.loading,
    error: state.error,
    hasMore: !state.done && cursor !== null,
    more: () => cursor && fetchPage(cursor, false),
    reload: () => fetchPage(null, true),
  };
}

/** Parses a number field from an input ("" → null). */
export const numOrNull = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
