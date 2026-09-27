'use client';
// Card framework (PRD §5.4): header (kicker + title + chips), body, footer with actions. Actions call the gateway with
// one Idempotency-Key per user action, show pending/done/error inline, and never run without a click (R-CHAT-1).
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { describeError, newIdempotencyKey } from '../lib/api';

export function Card({
  kicker,
  title,
  chips,
  children,
  footer,
  label,
}: {
  kicker: string;
  title?: ReactNode;
  chips?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Accessible name when the title is not plain text. */
  label?: string;
}) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={label ? undefined : `${id}-t`} aria-label={label}>
      <header className="card-h">
        <span className="k">{kicker}</span>
        {title !== undefined && <h3 id={`${id}-t`}>{title}</h3>}
        {chips}
      </header>
      {children !== undefined && <div className="card-b">{children}</div>}
      {footer !== undefined && <div className="card-f">{footer}</div>}
    </section>
  );
}

export function Chip({
  tone = 'plain',
  children,
}: {
  tone?: 'plain' | 'good' | 'warn' | 'bad' | 'supply' | 'demand';
  children: ReactNode;
}) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="row small muted">
      <span className="typing" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}…
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="row">
      <span className="err-note">{describeError(error)}</span>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Done({ children }: { children: ReactNode }) {
  return (
    <span className="done-note" role="status">
      ✓ {children}
    </span>
  );
}

/**
 * Runs `action(idempotencyKey)` on click. The key is kept until the action succeeds, so a retry after a network
 * error replays the same request (the owning service dedupes, R-3).
 */
export function useAction<T>(action: (idempotencyKey: string) => Promise<T>, onDone?: (result: T) => void) {
  const key = useRef<string>(newIdempotencyKey());
  const [state, setState] = useState<{ pending: boolean; error?: unknown }>({ pending: false });
  const run = async () => {
    if (state.pending) return;
    setState({ pending: true });
    try {
      const result = await action(key.current);
      key.current = newIdempotencyKey();
      setState({ pending: false });
      onDone?.(result);
    } catch (error) {
      setState({ pending: false, error });
    }
  };
  return { run, pending: state.pending, error: state.error };
}

export function ActionButton({
  children,
  onClick,
  pending,
  primary,
  danger,
  disabled,
  small,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  pending?: boolean;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  small?: boolean;
  type?: 'button' | 'submit';
}) {
  const cls = ['btn', primary && 'primary', danger && 'danger', small && 'sm'].filter(Boolean).join(' ');
  return (
    <button
      type={type}
      className={cls}
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

/** "How I got this" (R-CHAT-2): the query plan and filters behind an answer. */
export function HowIGotThis({ parts, note }: { parts: string[]; note?: string }) {
  return (
    <details className="how">
      <summary>How I got this</summary>
      <div>
        {parts.map((p) => (
          <code key={p}>{p}</code>
        ))}
      </div>
      {note && (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {note}
        </p>
      )}
    </details>
  );
}

/** Labeled form field; `children` is the control, which receives `id`. */
export function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  required?: boolean;
  hint?: string;
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
      {children(id)}
      {hint && <span className="faint">{hint}</span>}
    </div>
  );
}
