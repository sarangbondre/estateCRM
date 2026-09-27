'use client';
// A conversation: user messages and assistant turns made of text and cards (prototype msgView).
import { useEffect, useRef } from 'react';
import { cardFor } from '../cards/registry';
import type { Conversation } from '../shell/types';
import { useShell } from '../shell/ShellProvider';

export function Thread({ conversation }: { conversation: Conversation }) {
  const shell = useShell();
  const end = useRef<HTMLDivElement>(null);
  const turns = conversation.turns.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  return (
    <div className="thread" aria-live="polite" aria-relevant="additions">
      {conversation.turns.map((t) =>
        t.role === 'user' ? (
          <div key={t.id} className="u-msg">
            <span className="sr-only">You: </span>
            {t.text}
          </div>
        ) : (
          <div key={t.id} className="a-msg">
            <span className="a-ico" aria-hidden="true">
              11
            </span>
            <div className="a-body">
              <span className="sr-only">Assistant:</span>
              {t.blocks.map((b, i) => {
                if (b.type === 'text') return <p key={i}>{b.text}</p>;
                const CardView = cardFor(b.card.kind);
                return (
                  <CardView
                    key={b.card.id}
                    spec={b.card}
                    shell={shell}
                    patch={(props) => shell.patchCard(conversation.id, b.card.id, props)}
                  />
                );
              })}
            </div>
          </div>
        ),
      )}
      <div ref={end} />
    </div>
  );
}
