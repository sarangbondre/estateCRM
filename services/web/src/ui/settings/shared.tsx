'use client';
// Settings building blocks (WEB-08, PRD §5.5): friendly RFC 7807 errors, a validated number input, the numeric
// settings form state (load → edit → validate against the contract → PUT with If-Match) and section headings.
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, call, describeError, useResource } from '../lib/api';
import { ErrorNote, useAction } from '../cards/Card';
import { SETTINGS_ERRORS, applyDraft, isDirty, toDraft } from './logic';
import type { Draft, NumField } from './logic';

/** Problem codes of these settings shown as plain sentences; others fall back to the shared describeError. */
export function SettingsError({ error, onReload }: { error: unknown; onReload?: () => void }) {
  const code = error instanceof ApiError ? error.code : null;
  const friendly = code ? SETTINGS_ERRORS[code] : undefined;
  if (!friendly) return <ErrorNote error={error} {...(onReload ? { onRetry: onReload } : {})} />;
  return (
    <div role="alert" className="row">
      <span className="err-note">{friendly}</span>
      {code === 'version-mismatch' && onReload && (
        <button type="button" className="btn sm" onClick={onReload}>
          Reload
        </button>
      )}
    </div>
  );
}

export const errorText = (error: unknown): string => {
  const code = error instanceof ApiError ? error.code : null;
  return (code && SETTINGS_ERRORS[code]) || describeError(error);
};

/** A number input with a visible label, contract min/max and an inline validation message. */
export function NumberInput({
  label,
  value,
  onChange,
  error,
  min,
  max,
  integer,
  disabled,
  hideLabel,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  min?: number;
  max?: number | undefined;
  integer?: boolean | undefined;
  disabled?: boolean;
  /** Visually hidden label (table cells); still read by screen readers. */
  hideLabel?: boolean;
  hint?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        step={integer ? 1 : 'any'}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : undefined}
        onChange={(e) => onChange(e.target.value)}
        style={hideLabel ? { width: 80, textAlign: 'right' } : undefined}
      />
      {hint && !error && <span className="faint">{hint}</span>}
      {error && (
        <span id={`${id}-e`} className="err-note">
          {error}
        </span>
      )}
    </div>
  );
}

/** A heading inside a tab panel with an optional line of explanation. */
export function Section({ title, note, children, actions }: { title: string; note?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row">
        <h3 id={id} style={{ margin: 0, fontSize: 15 }}>
          {title}
        </h3>
        {actions && <span style={{ marginLeft: 'auto' }}>{actions}</span>}
      </div>
      {note && <p className="small muted" style={{ margin: 0 }}>{note}</p>}
      {children}
    </section>
  );
}

export interface NumericSettings<T> {
  data: T | undefined;
  loading: boolean;
  loadError: unknown;
  reload: () => void;
  draft: Draft;
  set: (path: string, value: string) => void;
  errors: Record<string, string>;
  dirty: boolean;
  save: () => void;
  saving: boolean;
  saveError: unknown;
  saved: boolean;
  reset: () => void;
}

/**
 * Loads a versioned settings object, keeps a string draft of its numeric fields and saves it with PUT + If-Match
 * (row version → 412 version-mismatch). `validate` runs the contract rules before anything is sent.
 */
export function useNumericSettings<T extends { version: number }>(
  path: string,
  fields: readonly NumField[],
  validate: (d: Draft) => Record<string, string>,
): NumericSettings<T> {
  const res = useResource<T>(path);
  const [draft, setDraft] = useState<Draft>({});
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [data, setData] = useState<T | undefined>(undefined);

  useEffect(() => {
    if (res.data) {
      setData(res.data);
      setDraft(toDraft(res.data, fields));
      setTouched(false);
    }
  }, [res.data, fields]);

  const errors = touched ? validate(draft) : {};
  const action = useAction(
    async () => {
      if (!data) throw new Error('Nothing loaded.');
      const r = await call<T>('PUT', path, { body: applyDraft(data, draft, fields), ifMatch: data.version });
      return r.data;
    },
    (updated) => {
      if (updated && typeof updated === 'object') {
        setData(updated);
        setDraft(toDraft(updated, fields));
      } else res.reload();
      setTouched(false);
      setSaved(true);
    },
  );

  return {
    data,
    loading: res.loading && !data,
    loadError: data ? undefined : res.error,
    reload: res.reload,
    draft,
    set: (p, v) => {
      setDraft((d) => ({ ...d, [p]: v }));
      setTouched(true);
      setSaved(false);
    },
    errors,
    dirty: data ? isDirty(data, draft, fields) : false,
    save: () => {
      setTouched(true);
      if (Object.keys(validate(draft)).length === 0) void action.run();
    },
    saving: action.pending,
    saveError: action.error,
    saved,
    reset: () => {
      if (data) setDraft(toDraft(data, fields));
      setTouched(false);
    },
  };
}
