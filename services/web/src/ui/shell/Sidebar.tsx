'use client';
// Sidebar (prototype sideView, PRD §5.2): New chat, My queue with count, Dashboards, Desks, Quick add / Add supply,
// Upload, Review (reviewers), Recent chats, and the signed-in user with Settings, theme and Sign out.
import Link from 'next/link';
import type { operations as Journeys } from '@11e/contracts/journeys';
import { useResource } from '../lib/api';
import type { Ok } from '../lib/contract';
import { initials } from '../lib/format';
import { Icon } from './Icon';
import { useShell } from './ShellProvider';
import { SignOutButton } from './SignOutButton';
import { ThemeToggle } from './ThemeToggle';
import { Wordmark } from './Wordmark';

type MyQueue = Ok<Journeys['getMyQueue']>;
const AGENT_ROLES = new Set(['Admin', 'Manager', 'Demand agent', 'Supply agent']);

export function Sidebar() {
  const shell = useShell();
  const { me, conversations, current, panel, sideOpen } = shell;
  const hasQueue = AGENT_ROLES.has(me.role);
  const queue = useResource<MyQueue>(hasQueue ? '/v1/queues/me' : null, undefined, 60_000);
  const queueCount = queue.data?.sections.reduce((n, s) => n + s.count, 0);
  const isSupply = me.role === 'Supply agent';
  const reviewer =
    me.role === 'Admin' || me.role === 'Manager' || me.role === 'Data operator' || me.isDataOperator;
  const settings = me.role === 'Admin' || me.role === 'Manager';
  const recents = conversations.filter((c) => c.turns.length > 0);

  return (
    <nav className="side" aria-label="Main" data-closed={sideOpen ? undefined : ''} id="sidebar">
      <Wordmark />
      <button type="button" className="sbtn newchat" onClick={shell.newChat}>
        <Icon name="plus" />
        New chat
      </button>
      {hasQueue && (
        <button
          type="button"
          className={`sbtn ${panel?.kind === 'queue' ? 'on' : ''}`}
          onClick={() => shell.openPanel({ kind: 'queue', title: 'My queue' })}
          aria-pressed={panel?.kind === 'queue'}
        >
          <Icon name="queue" />
          My queue
          {queueCount !== undefined && (
            <span className="cnt" aria-label={`${queueCount} items`}>
              {queueCount}
            </span>
          )}
        </button>
      )}
      <button
        type="button"
        className="sbtn"
        onClick={() => shell.openPanel({ kind: 'dashboards', title: 'Dashboards' })}
      >
        <Icon name="dash" />
        Dashboards
      </button>
      <button
        type="button"
        className="sbtn"
        onClick={() => shell.openPanel({ kind: 'desks', title: 'Desks & Watchlist' })}
      >
        <Icon name="desk" />
        Desks &amp; Watchlist
      </button>
      {isSupply ? (
        <button type="button" className="sbtn" onClick={() => shell.send('/add supply')}>
          <Icon name="add" />
          Add supply
        </button>
      ) : (
        me.role !== 'Data operator' && (
          <button type="button" className="sbtn" onClick={() => shell.send('/add demand')}>
            <Icon name="add" />
            Quick add requirement
          </button>
        )
      )}
      <button type="button" className="sbtn" onClick={() => shell.send('/upload')}>
        <Icon name="up" />
        Upload a sheet
      </button>
      {reviewer && (
        <button type="button" className="sbtn" onClick={() => shell.send('/review')}>
          <Icon name="review" />
          Review
        </button>
      )}
      <h2 className="slabel">Recent chats</h2>
      <ul className="recents">
        {recents.length === 0 && (
          <li className="small faint" style={{ padding: '4px 10px' }}>
            No chats yet
          </li>
        )}
        {recents.map((c) => (
          <li key={c.id}>
            <Link
              href={`/chat/${c.id}`}
              className="sbtn"
              aria-current={current?.id === c.id ? 'page' : undefined}
              onClick={() => shell.setSideOpen(false)}
            >
              {c.title}
            </Link>
          </li>
        ))}
      </ul>
      <div className="me">
        {settings && (
          <Link href="/settings" className="sbtn">
            <Icon name="gear" />
            Settings
          </Link>
        )}
        <div className="me-row">
          <span className="avatar" aria-hidden="true">
            {initials(me.displayName)}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{me.displayName}</div>
            <div className="small muted">
              {me.role}
              {me.isDataOperator && me.role !== 'Data operator' ? ' · Data operator' : ''}
            </div>
          </div>
          <ThemeToggle />
        </div>
        <SignOutButton />
      </div>
    </nav>
  );
}
