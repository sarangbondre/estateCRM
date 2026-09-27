// Work notifications (FR-NTF-1, R-6; LLD §4.8) and audit events (audit.recorded.v1). Titles use codes and generated
// labels only, never contact PII.
import type { Tx } from './ports.js';

export type NotificationKind =
  | 'match_suggested'
  | 'match_confirmed'
  | 'match_closed'
  | 'match_flagged'
  | 'srq_assigned'
  | 'srq_fulfilled'
  | 'enquiry'
  | 'offer_closed'
  | 'demand_exited'
  | 'deal_follow_up_overdue'
  | 'proposal_opened'
  | 'visit_scheduled'
  | 'dormant_revisit'
  | 'watchlist_task';

export interface NotifySpec {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  subject?: { type: string; id: string; code: string | null } | null;
  /** While an unread notification with this key exists, it is updated instead of inserting (throttle). */
  dedupeKey?: string | null;
  /** Title for the n-th throttled occurrence, e.g. n => `${n} new matches for DEM-000127`. */
  groupedTitle?: (count: number) => string;
}

export async function notify(tx: Tx, userId: string | null | undefined, spec: NotifySpec): Promise<void> {
  if (!userId) return;
  if (spec.dedupeKey) {
    const open = await tx.q.unreadByDedupeKey(userId, spec.dedupeKey);
    if (open) {
      const count = open.dedupe_count + 1;
      await tx.rows.update('notifications', open.id, {
        dedupe_count: count,
        title: (spec.groupedTitle ? spec.groupedTitle(count) : spec.title).slice(0, 200),
      });
      return;
    }
  }
  await tx.rows.insert('notifications', {
    user_id: userId,
    kind: spec.kind,
    title: spec.title.slice(0, 200),
    body: spec.body ?? null,
    subject_type: spec.subject?.type ?? null,
    subject_id: spec.subject?.id ?? null,
    subject_code: spec.subject?.code ?? null,
    dedupe_key: spec.dedupeKey ?? null,
    created_at: tx.now,
  });
}

/** audit.recorded.v1: details are IDs, codes, counts and field names only (never PII). */
export async function audit(
  tx: Tx,
  action: string,
  actorUserId: string,
  subject: { type: string; id: string },
  details: Record<string, string> = {},
  via: 'ui' | 'system' = 'ui',
): Promise<void> {
  await tx.events.emit(
    'audit.recorded.v1',
    { type: 'audit', id: tx.newId() },
    { action, actorUserId, subjectType: subject.type, subjectId: subject.id, via, details },
  );
}
