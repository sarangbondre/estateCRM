'use client';
// Notification bell (R-6, web LLD §4.7): web's upload/export/user notifications and journeys' work notifications,
// merged client-side by createdAt. Polls every 30 s and on window focus (no push channel in Phase 1, A-W5).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { operations as Journeys } from '@11e/contracts/journeys';
import type { operations as Web } from '@11e/contracts/web';
import { call, get, newIdempotencyKey } from '../lib/api';
import type { Ok } from '../lib/contract';
import { relative } from '../lib/format';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useShell } from './ShellProvider';

type WebList = Ok<Web['listMyNotifications']>;
type WorkList = Ok<Journeys['listNotifications']>;

type WebKind = WebList['items'][number]['kind'];
type WorkKind = WorkList['items'][number]['kind'];
interface KindMeta {
  label: string;
  icon: IconName;
}

/** Label and icon per kind. Exhaustive over both contracts, so a new kind fails the type check until it is added. */
const WEB_KINDS: Record<WebKind, KindMeta> = {
  upload_completed: { label: 'Upload', icon: 'up' },
  upload_failed: { label: 'Upload failed', icon: 'close' },
  export_ready: { label: 'Export', icon: 'file' },
  export_failed: { label: 'Export failed', icon: 'close' },
  role_changed: { label: 'Account', icon: 'gear' },
  account_reactivated: { label: 'Account', icon: 'gear' },
};
const WORK_KINDS: Record<WorkKind, KindMeta> = {
  match_suggested: { label: 'New match', icon: 'review' },
  match_confirmed: { label: 'Match confirmed', icon: 'review' },
  match_closed: { label: 'Match closed', icon: 'review' },
  match_flagged: { label: 'Match flagged', icon: 'review' },
  srq_assigned: { label: 'Sourcing request', icon: 'desk' },
  srq_fulfilled: { label: 'Sourcing fulfilled', icon: 'desk' },
  enquiry: { label: 'Enquiry', icon: 'send' },
  offer_closed: { label: 'Offer closed', icon: 'file' },
  demand_exited: { label: 'Demand exited', icon: 'file' },
  deal_follow_up_overdue: { label: 'Deal follow-up', icon: 'bell' },
  proposal_opened: { label: 'Proposal opened', icon: 'file' },
  visit_scheduled: { label: 'Site visit', icon: 'desk' },
  dormant_revisit: { label: 'Dormant revisit', icon: 'queue' },
  watchlist_task: { label: 'Watchlist task', icon: 'queue' },
  // CR-012
  queue_reassigned: { label: 'Queue reassigned', icon: 'queue' },
  proposal_failed: { label: 'Proposal failed', icon: 'close' },
  demand_touch: { label: 'Demand touch', icon: 'add' },
};
const FALLBACK: KindMeta = { label: 'Notice', icon: 'bell' };

/** Label and icon of a notification kind (pure; exported for tests). Unknown kinds (a newer service) get a generic one. */
export function kindMeta(source: 'web' | 'journeys', kind: string): KindMeta {
  const map: Record<string, KindMeta> = source === 'web' ? WEB_KINDS : WORK_KINDS;
  return map[kind] ?? FALLBACK;
}

export interface BellItem {
  id: string;
  source: 'web' | 'journeys';
  kind: string;
  title: string;
  code: string | null;
  createdAt: string;
  read: boolean;
}

/** Merge both lists newest first (pure; exported for tests). */
export function mergeNotifications(web: WebList['items'], work: WorkList['items']): BellItem[] {
  return [
    ...web.map((n) => ({
      id: n.notificationId,
      source: 'web' as const,
      kind: n.kind,
      title: n.title,
      code: n.subjectCode ?? null,
      createdAt: n.createdAt,
      read: Boolean(n.readAt),
    })),
    ...work.map((n) => ({
      id: n.id,
      source: 'journeys' as const,
      kind: n.kind,
      title: n.title,
      code: n.subjectCode ?? null,
      createdAt: n.createdAt,
      read: Boolean(n.readAt),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function NotificationBell() {
  const shell = useShell();
  const [items, setItems] = useState<BellItem[]>([]);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [web, work] = await Promise.all([
      get<WebList>('/v1/me/notifications', { limit: 20 }).catch(() => undefined),
      get<WorkList>('/v1/notifications', { limit: 20 }).catch(() => undefined),
    ]);
    setItems(mergeNotifications(web?.items ?? [], work?.items ?? []));
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = items.filter((i) => !i.read).length;

  const markRead = async (list: BellItem[]) => {
    const web = list.filter((i) => i.source === 'web' && !i.read).map((i) => i.id);
    const work = list.filter((i) => i.source === 'journeys' && !i.read).map((i) => i.id);
    await Promise.all([
      web.length
        ? call('POST', '/v1/me/notifications/read', {
            body: { ids: web },
            idempotencyKey: newIdempotencyKey(),
          })
        : null,
      work.length ? call('POST', '/v1/notifications/mark-read', { body: { ids: work } }) : null,
    ]).catch(() => undefined);
    setItems((all) => all.map((i) => (list.some((l) => l.id === i.id) ? { ...i, read: true } : i)));
  };

  return (
    <div className="bell" ref={box}>
      <button
        type="button"
        className="ibtn"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="dot" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="popover" id={panelId} role="region" aria-label="Notifications">
          <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <b className="grow small">Notifications</b>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void markRead(items)}
              disabled={!unread}
            >
              Mark all read
            </button>
          </div>
          {items.length === 0 && (
            <p className="small muted" style={{ padding: 12, margin: 0 }}>
              Nothing new.
            </p>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((n) => {
              const meta = kindMeta(n.source, n.kind);
              return (
                <li key={`${n.source}:${n.id}`} style={{ borderBottom: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    className="sbtn"
                    style={{
                      whiteSpace: 'normal',
                      alignItems: 'flex-start',
                      flexDirection: 'column',
                      gap: 2,
                      borderRadius: 0,
                    }}
                    onClick={() => {
                      void markRead([n]);
                      setOpen(false);
                      if (n.code) shell.send(`open ${n.code}`);
                    }}
                  >
                    <span className="small muted row" style={{ gap: 4, alignItems: 'center' }}>
                      <Icon name={meta.icon} />
                      {meta.label}
                    </span>
                    <span style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</span>
                    <span className="small faint">{relative(n.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
