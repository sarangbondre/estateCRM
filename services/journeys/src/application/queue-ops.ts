// Queue item lifecycle (LLD §4.3): one open item per (section, subject), counters maintained in the same transaction,
// assignment policy (§4.3.5) and Should call ranking (§4.3.3).
import type { IsoDate } from '../domain/dates.js';
import { computeRank, pickLeastLoaded, roleForTeam, teamOf } from '../domain/queue.js';
import type { QueueReason, QueueSubjectType, RankFactors, Section, Team } from '../domain/queue.js';
import type { OfferViewRow, QueueItemRow } from './model.js';
import type { Tx } from './ports.js';
import type { CloseFilter } from './queries.js';
import { weights } from './settings.js';

export interface ItemSpec {
  section: Section;
  subjectType: QueueSubjectType;
  subjectId: string;
  subjectCode: string | null;
  offerId?: string | null;
  demandId?: string | null;
  assignee: string | null;
  reason: QueueReason;
  reasonRef?: string | null;
  priority?: number;
  dueAt?: Date | null;
  rank?: { score: number; factors: RankFactors } | null;
  nextCallDate?: IsoDate | null;
}

/** Opens (or refreshes) the single open item for a section and subject. */
export async function openItem(tx: Tx, spec: ItemSpec): Promise<QueueItemRow> {
  const existing = await tx.q.openItemFor(spec.section, spec.subjectType, spec.subjectId);
  if (existing) {
    const priority = Math.max(existing.priority, spec.priority ?? 0);
    const patch: Partial<QueueItemRow> = {
      priority,
      // a higher-priority reason wins; otherwise the newest reason (e.g. reconfirm → stale_public)
      reason: (spec.priority ?? 0) >= existing.priority ? spec.reason : existing.reason,
      reason_ref: spec.reasonRef ?? existing.reason_ref,
    };
    if (spec.dueAt && (!existing.due_at || spec.dueAt < existing.due_at)) patch.due_at = spec.dueAt;
    if (spec.rank) {
      patch.rank_score = spec.rank.score;
      patch.rank_factors = spec.rank.factors as unknown as Record<string, number>;
      patch.rank_dirty = false;
    }
    if (spec.subjectCode && !existing.subject_code) patch.subject_code = spec.subjectCode;
    return (await tx.rows.update('queue_items', existing.id, patch)) ?? existing;
  }
  const row = await tx.rows.insert('queue_items', {
    team: teamOf(spec.section),
    section: spec.section,
    subject_type: spec.subjectType,
    subject_id: spec.subjectId,
    subject_code: spec.subjectCode,
    offer_id: spec.offerId ?? null,
    demand_id: spec.demandId ?? null,
    assignee_user_id: spec.assignee,
    reason: spec.reason,
    reason_ref: spec.reasonRef ?? null,
    priority: spec.priority ?? 0,
    due_at: spec.dueAt ?? (spec.section === 'should_call' ? null : tx.now),
    rank_score: spec.rank?.score ?? (spec.section === 'should_call' ? 0 : null),
    rank_factors: (spec.rank?.factors as unknown as Record<string, number>) ?? null,
    rank_dirty: spec.section === 'should_call' && !spec.rank,
    next_call_date: spec.nextCallDate ?? null,
  });
  if (row.assignee_user_id) await tx.q.bumpCounters([{ userId: row.assignee_user_id, section: row.section, delta: 1 }], tx.now);
  return row;
}

/** Closes open items (done / cancelled) and keeps the counters in step. Returns the number closed. */
export async function closeItems(
  tx: Tx,
  filter: CloseFilter,
  status: 'done' | 'cancelled',
  reason: string,
): Promise<number> {
  const closed = await tx.q.closeOpenItems(filter, status, reason, tx.now);
  const deltas = closed
    .filter((c) => c.assignee_user_id)
    .map((c) => ({ userId: c.assignee_user_id as string, section: c.section, delta: -1 }));
  if (deltas.length) await tx.q.bumpCounters(deltas, tx.now);
  return closed.length;
}

/** Moves one open item to another assignee (counters follow). */
export async function moveItem(tx: Tx, item: QueueItemRow, assignee: string | null): Promise<void> {
  if (item.assignee_user_id === assignee) return;
  await tx.rows.update('queue_items', item.id, { assignee_user_id: assignee });
  const deltas = [];
  if (item.assignee_user_id) deltas.push({ userId: item.assignee_user_id, section: item.section, delta: -1 });
  if (assignee) deltas.push({ userId: assignee, section: item.section, delta: 1 });
  if (deltas.length) await tx.q.bumpCounters(deltas, tx.now);
}

/**
 * Assignment (LLD §4.3.5): the owner when known and active; else the least-loaded active agent of the team role;
 * else (assumption: pilot with a single Admin) the least-loaded active Manager/Admin; else unassigned.
 */
export async function resolveAssignee(tx: Tx, team: Team, preferred: string | null | undefined): Promise<string | null> {
  if (preferred) {
    const staff = await tx.rows.get('staff_users', preferred);
    if (!staff || staff.active) return preferred;
  }
  const memoKey = `assignee:${team}`;
  const cached = tx.memo.get(memoKey) as string | null | undefined;
  if (cached !== undefined) return cached;
  let pick: string | null = null;
  for (const roles of [[roleForTeam(team)], ['Manager', 'Admin']]) {
    const pool = await tx.q.loadOfActiveStaff(roles, team);
    pick = pickLeastLoaded(pool);
    if (pick) break;
  }
  tx.memo.set(memoKey, pick);
  return pick;
}

/** Should call rank for an offer (LLD §4.3.3). */
export async function rankOffer(
  tx: Tx,
  offer: OfferViewRow,
  boost: 'ageing' | 'stale_public' | 'none',
): Promise<{ score: number; factors: RankFactors }> {
  const w = (await weights(tx)).value;
  const cell =
    offer.segment && offer.micromarket
      ? await tx.q.demandGapCell(offer.segment, offer.deal_type, offer.micromarket)
      : undefined;
  const quality = offer.source_type ? await tx.q.sourceQuality(offer.source_type) : undefined;
  const r = computeRank(
    {
      lastSeenOn: offer.last_seen_on,
      today: tx.today,
      gap: cell ? cell.gap : null,
      sourceScore: quality ? quality.score : null,
      dealType: offer.deal_type,
      salePriceInrMin: offer.sale_price_inr_min,
      rentMonthlyInrMin: offer.rent_monthly_inr_min,
      band: cell ? { p10: cell.budget_p10, p25: cell.budget_p25, p75: cell.budget_p75, p90: cell.budget_p90 } : null,
    boost,
    },
    w,
  );
  return { score: r.rank, factors: r.factors };
}

/** Must call due time: event time + mustCallDueHours (BRD §5.2). */
export async function mustCallDue(tx: Tx, from: Date): Promise<Date> {
  const w = (await weights(tx)).value;
  return new Date(from.getTime() + w.mustCallDueHours * 3_600_000);
}
