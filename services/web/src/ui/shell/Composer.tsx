'use client';
// Composer with "/" quick actions (prototype composer()). The "/" menu is an ARIA combobox: arrows move, Enter picks,
// Escape closes.
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { slashSuggestions } from '../lib/intent';
import { Icon } from './Icon';
import { useShell } from './ShellProvider';

export function Composer({ home = false }: { home?: boolean }) {
  const { send } = useShell();
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const options = dismissed ? [] : slashSuggestions(draft);
  const open = options.length > 0;

  const submit = (text: string) => {
    if (!text.trim()) return;
    send(text);
    setDraft('');
    setActive(0);
    setDismissed(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const pick = options[Math.min(active, options.length - 1)];
      // Enter on an exact command sends it; otherwise it completes the highlighted command.
      if (pick && draft.trim() !== pick.command) {
        e.preventDefault();
        if (e.key === 'Tab') {
          setDraft(`${pick.command} `);
          return;
        }
        submit(pick.command);
      }
    }
  };

  return (
    <div className="composer-wrap">
      {open && (
        <ul className="slash" id={listId} role="listbox" aria-label="Quick actions">
          {options.map((o, i) => (
            <li
              key={o.command}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                submit(o.command);
              }}
            >
              <b>{o.command}</b>
              <span className="muted">{o.label}</span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <input
          ref={input}
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(0);
            setDismissed(false);
          }}
          onKeyDown={onKey}
          placeholder={
            home
              ? 'Ask, log a call, add a requirement… or type / for actions'
              : 'Reply, or type / for actions'
          }
          autoComplete="off"
          aria-label="Message"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          maxLength={2000}
        />
        <div className="tools">
          <button
            type="button"
            className="ibtn"
            onClick={() => submit('/upload')}
            title="Upload a sheet"
            aria-label="Upload a sheet"
          >
            <Icon name="clip" />
          </button>
          <button
            type="button"
            className="ibtn"
            aria-label="Show actions"
            onClick={() => {
              setDraft('/');
              setDismissed(false);
              input.current?.focus();
            }}
          >
            <Icon name="slash" />
          </button>
          <span className="small faint">All 11estates data</span>
          <button type="submit" className="ibtn send" aria-label="Send">
            <Icon name="send" />
          </button>
        </div>
      </form>
      {!home && <p className="hint">The assistant proposes. Nothing changes until you click.</p>}
    </div>
  );
}
