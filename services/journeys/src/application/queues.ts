// Queue queries and commands (PRD §4.2, §4.3, D-10, US-12, US-19; LLD §4.3.4–4.3.6): My queue summary, section pages
// in computed order, daily plan, bulk reassign and capacities.
import { istStartOfDay, addDays } from '../domain/dates.js';
import {
  ALL_SECTIONS,
  DEFAULT_DAILY_CAPACITY,
  DEMAND_SECTIONS,
  SUPPLY_SECTIONS,
  dailyPlan,
  demandSummary,
  isRankedSection,
  offerSummary,
  teamForRole,
  teamOf,
} from '../domain/queue.js';
import type { Section, Team } from '../domain/queue.js';
import { JourneyError, notFoundErr, notOwnerErr, versionMismatchErr } from './errors.js';
import type { CapacityRow } from './model.js';
import { audit } from './notify.js';
import type { Tx } from './ports.js';
import type { Position, SectionItem } from './queries.js';
import { moveItem } from './queue-ops.js';

export interface Caller {
  userId: string;
  role: string;
}
const isManager = (c: Caller) => c.role === 'Admin' || c.role === 'Manager';

export interface CapacityView {
  userId: string;
  team: Team;
  dailyCalls: number;
  updatedBy: string | null;
  updatedAt: string | null;
  version: number;
}

export const toCapacity = (c: CapacityRow): CapacityView => ({
  userId: c.user_id,
  team: c.team,
  dailyCalls: c.daily_calls,
  updatedBy: c.updated_by,
  updatedAt: c.updated_at.toISOString(),
  version: c.version,
});

async function teamsOf(tx: Tx, userId: string, role: string | null): Promise<{ teams: Team[]; capacity: CapacityRow | undefined }> {
  const capacity = await tx.q.capacityOf(userId);
  if (role === 'Admin' || role === 'Manager') return { teams: ['supply', 'demand'], capacity };
  if (capacity) return { teams: [capacity.team], capacity };
  const t = role ? teamForRole(role) : null;
  return { teams: t ? [t] : ['supply', 'demand'], capacity };
}

/** Daily plan inputs (D-10): capacity (default 40 on first read), open Must call, calls logged today (IST). */
async function planOf(tx: Tx, userId: string, capacity: number, openMust: number) {
  const calls = await tx.q.callsLoggedSince(userId, istStartOfDay(tx.today));
  const eligible = await tx.q.eligibleShouldCount(userId, tx.today, Math.max(0, capacity));
  return { calls, ...dailyPlan(capacity, openMust, calls, eligible) };
}

export async function queueSummary(tx: Tx, userId: string, role: string | null) {
  const { teams, capacity } = await teamsOf(tx, userId, role);
  const dailyCalls = capacity?.daily_calls ?? DEFAULT_DAILY_CAPACITY;
  const counters = new Map((await tx.q.countersOf(userId)).map((c) => [c.section, c.open_count]));
  const sections = ALL_SECTIONS.filter((s) => teams.includes(teamOf(s)));
  const openMust = counters.get('must_call') ?? 0;
  const plan = await planOf(tx, userId, dailyCalls, openMust);
  const out = [];
  for (const s of sections) {
    const count = counters.get(s) ?? 0;
    const overdue = count && !isRankedSection(s) ? await tx.q.overdueCount(userId, s, tx.now) : 0;
    out.push({
      section: s,
      team: teamOf(s),
      count,
      overdue,
      plannedToday: s === 'must_call' ? openMust : s === 'should_call' ? plan.plannedShould : null,
    });
  }
  return {
    userId,
    capacity: dailyCalls,
    callsLoggedToday: plan.calls,
    plannedToday: teams.includes('supply') ? plan.plannedToday : 0,
    unreadNotifications: await tx.q.unreadCount(userId),
    sections: out,
    generatedAt: tx.now.toISOString(),
  };
}

export async function userKnown(tx: Tx, userId: string): Promise<{ role: string | null } | null> {
  const staff = await tx.rows.get('staff_users', userId);
  if (staff) return { role: staff.role };
  if (await tx.q.capacityOf(userId)) return { role: null };
  if ((await tx.q.countersOf(userId)).length) return { role: null };
  return null;
}

type Cursor = Position & { n?: number };

export function queueItemView(i: SectionItem, now: Date, planned: boolean) {
  const summary = i.summary_offer
    ? offerSummary({
        dealType: i.summary_offer.deal_type,
        propertyTypes: i.summary_offer.property_types ?? [],
        micromarket: i.summary_offer.micromarket,
        locality: i.summary_offer.locality ?? null,
        areaSqftMin: i.summary_offer.area_sqft_min,
        salePriceInrMin: i.summary_offer.sale_price_inr_min,
        rentMonthlyInrMin: i.summary_offer.rent_monthly_inr_min,
      })
    : i.summary_demand
      ? demandSummary({
          dealTypes: i.summary_demand.deal_types ?? [],
          propertyTypes: i.summary_demand.property_types ?? [],
          micromarkets: i.summary_demand.micromarkets ?? [],
          budgetInrMax: i.summary_demand.budget_inr_max,
          rentMonthlyInrMax: i.summary_demand.rent_monthly_inr_max,
        })
      : undefined;
  const f = i.rank_factors as Record<string, number> | null;
  return {
    id: i.id,
    section: i.section,
    subjectType: i.subject_type,
    subjectId: i.subject_id,
    subjectCode: i.subject_code ?? i.subject_id.slice(0, 8),
    offerId: i.offer_id,
    demandId: i.demand_id,
    reason: i.reason,
    reasonRef: i.reason_ref,
    ...(summary ? { summary } : {}),
    dueAt: i.due_at ? i.due_at.toISOString() : null,
    overdue: !!i.due_at && i.due_at < now,
    rank: i.rank_score,
    rankFactors: f
      ? {
          freshness: f['freshness'] ?? 0,
          demandGap: f['demandGap'] ?? 0,
          sourceQuality: f['sourceQuality'] ?? 0,
          priceBand: f['priceBand'] ?? 0,
          boost: f['boost'] ?? 0,
        }
      : null,
    lifeStage: (i.life_stage as 'Fresh' | null) ?? null,
    dayCount: i.day_count,
    attempts: i.attempts,
    nextCallDate: i.next_call_date,
    assigneeUserId: i.assignee_user_id,
    plannedToday: planned,
    status: i.status,
  };
}

/** One page of a section in computed order (must_call/date sections: priority, due; should_call: rank). */
export async function sectionPage(
  tx: Tx,
  userId: string,
  section: Section,
  after: Cursor | undefined,
  limit: number,
  plannedOnly: boolean,
) {
  const ranked = isRankedSection(section);
  let slots = Number.POSITIVE_INFINITY;
  if (ranked) {
    const capacity = (await tx.q.capacityOf(userId))?.daily_calls ?? DEFAULT_DAILY_CAPACITY;
    const counters = await tx.q.countersOf(userId);
    const openMust = counters.find((c) => c.section === 'must_call')?.open_count ?? 0;
    slots = (await planOf(tx, userId, capacity, openMust)).shouldSlots;
  }
  const seen = after?.n ?? 0;
  const take = plannedOnly && ranked ? Math.max(0, Math.min(limit, slots - seen)) : limit;
  const rows = take > 0 ? await tx.q.sectionItems(userId, section, ranked, tx.today, after, take + 1) : [];
  const page = rows.slice(0, take);
  const endOfToday = istStartOfDay(addDays(tx.today, 1));
  const items = page.map((r, idx) =>
    queueItemView(
      r,
      tx.now,
      ranked ? seen + idx < slots : section === 'must_call' || (!!r.due_at && r.due_at < endOfToday),
    ),
  );
  const last = page.at(-1);
  const more = rows.length > take && (!plannedOnly || !ranked || seen + take < slots);
  const nextCursor: Cursor | null =
    more && last
      ? ranked
        ? { r: last.rank_score, id: last.id, n: seen + page.length }
        : { p: last.priority, d: last.due_at ? last.due_at.toISOString() : null, id: last.id }
      : null;
  return { items, next: nextCursor };
}

/** Bulk reassign (≤ 100 open items) by a Manager/Admin (C-19). */
export async function reassign(tx: Tx, caller: Caller, itemIds: readonly string[], assignee: string) {
  const staff = await tx.rows.get('staff_users', assignee);
  if (staff && !staff.active) throw new JourneyError(409, 'conflict', 'the assignee is not active');
  const items = await tx.rows.getMany('queue_items', itemIds);
  const byId = new Map(items.map((i) => [i.id, i]));
  const skipped: string[] = [];
  let reassigned = 0;
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item || item.status !== 'open') {
      skipped.push(id);
      continue;
    }
    await moveItem(tx, item, assignee);
    reassigned++;
  }
  await audit(tx, 'queue_items.reassigned', caller.userId, { type: 'user', id: assignee }, { count: String(reassigned) });
  return { reassigned, ...(skipped.length ? { skipped } : {}) };
}

export async function getCapacity(tx: Tx, caller: Caller, userId: string): Promise<CapacityView> {
  if (!isManager(caller) && caller.userId !== userId) throw notOwnerErr('agents may read only their own capacity');
  const row = await tx.q.capacityOf(userId);
  if (row) return toCapacity(row);
  const known = userId === caller.userId ? { role: caller.role } : await userKnown(tx, userId);
  if (!known) throw notFoundErr('user');
  return {
    userId,
    team: (known.role && teamForRole(known.role)) || 'supply',
    dailyCalls: DEFAULT_DAILY_CAPACITY,
    updatedBy: null,
    updatedAt: null,
    version: 0,
  };
}

export async function putCapacity(
  tx: Tx,
  caller: Caller,
  userId: string,
  body: { team: Team; dailyCalls: number },
  expectedVersion: number | undefined,
): Promise<CapacityView> {
  const row = await tx.q.capacityOf(userId);
  let saved: CapacityRow | undefined;
  if (!row) {
    if (expectedVersion !== undefined && expectedVersion !== 0) throw versionMismatchErr();
    saved = await tx.rows.insert('capacities', { user_id: userId, team: body.team, daily_calls: body.dailyCalls, updated_by: caller.userId });
  } else {
    saved = await tx.rows.update(
      'capacities',
      row.id,
      { team: body.team, daily_calls: body.dailyCalls, updated_by: caller.userId },
      expectedVersion === undefined ? {} : { expectedVersion },
    );
    if (!saved) throw versionMismatchErr();
  }
  await audit(tx, 'capacity.updated', caller.userId, { type: 'user', id: userId }, { team: body.team, dailyCalls: String(body.dailyCalls) });
  return toCapacity(saved);
}

export const SUPPLY = SUPPLY_SECTIONS;
export const DEMAND = DEMAND_SECTIONS;
