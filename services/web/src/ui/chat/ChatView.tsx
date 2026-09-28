'use client';
// A conversation page: the thread and the composer.
import Link from 'next/link';
import { Composer } from '../shell/Composer';
import { useShell } from '../shell/ShellProvider';
import { Thread } from './Thread';

export function ChatView({ id }: { id: string }) {
  const { conversations } = useShell();
  const conversation = conversations.find((c) => c.id === id);
  return (
    <>
      <div className="scroll">
        {conversation ? (
          <Thread conversation={conversation} />
        ) : (
          <div className="thread">
            <p className="muted">
              This chat is empty or was opened in another tab. <Link href="/">Start a new chat</Link> or type
              below.
            </p>
          </div>
        )}
      </div>
      <Composer />
    </>
  );
}
