'use client';
// Home (PRD §5.3, prototype homeView): greeting, Today tiles for the role (C-01), composer and suggestions.
import { useResource } from '../lib/api';
import { greeting } from '../lib/format';
import { Composer } from '../shell/Composer';
import { useShell } from '../shell/ShellProvider';
import { suggestionsFor, tilesFor } from './tiles';
import type { MyQueue } from './tiles';

const QUEUE_ROLES = new Set(['Admin', 'Manager', 'Demand agent', 'Supply agent']);

export function HomeView() {
  const shell = useShell();
  const { me } = shell;
  const queue = useResource<MyQueue>(QUEUE_ROLES.has(me.role) ? '/v1/queues/me' : null, undefined, 60_000);
  const tiles = tilesFor(me.role, queue.data);
  const first = me.displayName.split(/\s+/)[0] ?? me.displayName;

  return (
    <>
      <div className="home">
        <h2>
          {greeting()}, {first}
        </h2>
        {tiles.length > 0 && (
          <section aria-labelledby="today">
            <h3 id="today" className="slabel" style={{ padding: '0 0 6px' }}>
              Today
            </h3>
            <div className="attn">
              {tiles.map((t) => (
                <button key={t.label} type="button" onClick={() => shell.send(t.action)}>
                  <b aria-hidden={t.count === undefined}>{t.count ?? '–'}</b>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            {queue.error !== undefined && (
              <p className="small faint">Queue counts are not available right now.</p>
            )}
          </section>
        )}
      </div>
      <Composer home />
      <div className="home" style={{ paddingTop: 0 }}>
        <div className="sugg" role="group" aria-label="Suggestions">
          {suggestionsFor(me.role).map((s) => (
            <button key={s} type="button" onClick={() => shell.send(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
