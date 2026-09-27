// Postgres implementation of the application ports (Rows, Queries, EventSink, WorkQueue, TxRunner). Every business
// query filters on tenant_id and runs on an index listed in the LLD / migrations; every list is bounded.
import { sql, tenantScope, withTransaction } from '@11e/db';
import type { Kysely, Transaction } from '@11e/db';
import { queueSend, writeEvent } from '@11e/outbox';
import type { EventType } from '@11e/outbox';
import type { RawBuilder } from 'kysely';
import { istDate } from '../domain/dates.js';
import { DEMAND_SECTIONS, SUPPLY_SECTIONS } from '../domain/queue.js';
import type { NewRow, TableName, Tables } from '../application/model.js';
import type { EventSink, Rows, Tx, TxMeta, TxRunner, WorkMessage, WorkQueue } from '../application/ports.js';
import type { CloseFilter, Queries, RepointTarget, SectionItem } from '../application/queries.js';
import { SCHEMA, SERVICE } from '../config.js';
import type { JourneysDb } from './db.js';
import { uuidv7 } from './ids.js';

type Db = Kysely<JourneysDb> | Transaction<JourneysDb>;
type Loose = Kysely<Record<string, Record<string, unknown>>>;

const VERSIONED = new Set<string>([
  'life_curve',
  'offer_journey',
  'demand_journey',
  'capacities',
  'queue_items',
  'sourcing_requests',
  'proposals',
  'site_visits',
  'deals',
  'watchlist_tasks',
  'settings',
]);
const IDENT = /^[a-z_]+$/;
const ident = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`bad identifier ${name}`);
  return sql.ref(name);
};
const WORK_QUEUE = 'q_journeys_work';

async function rowsOf<T>(q: RawBuilder<T>, db: Db): Promise<T[]> {
  return (await q.execute(db)).rows;
}
async function firstOf<T>(q: RawBuilder<T>, db: Db): Promise<T | undefined> {
  return (await q.execute(db)).rows[0];
}
const uuidArray = (ids: readonly string[]) => sql`${[...ids]}::uuid[]`;
const textArray = (v: readonly string[]) => sql`${[...v]}::text[]`;

function makeRows(db: Db, tenantId: string, newId: () => string, now: () => Date): Rows {
  const scope = tenantScope(db as unknown as Loose, tenantId);
  return {
    async get(table, id, opts) {
      let q = scope.selectFrom(table as never).selectAll().where(sql.ref('id') as never, '=', id as never);
      if (opts?.forUpdate) q = q.forUpdate();
      return (await q.executeTakeFirst()) as never;
    },
    async getMany(table, ids) {
      if (!ids.length) return [];
      return (await scope
        .selectFrom(table as never)
        .selectAll()
        .where(sql`id = any(${uuidArray(ids)})` as never)
        .execute()) as never;
    },
    async byCode(table, code) {
      return (await scope
        .selectFrom(table as never)
        .selectAll()
        .where(sql.ref('code') as never, '=', code as never)
        .executeTakeFirst()) as never;
    },
    async insert<T extends TableName>(table: T, row: NewRow<T>) {
      const values = { id: newId(), ...(row as Record<string, unknown>) };
      return (await scope
        .insertInto(table as never, values as never)
        .returningAll()
        .executeTakeFirstOrThrow()) as unknown as Tables[T];
    },
    async update(table, id, patch, opts) {
      const set: Record<string, unknown> = { ...(patch as Record<string, unknown>), updated_at: now() };
      delete set['id'];
      delete set['tenant_id'];
      if (VERSIONED.has(table)) set['version'] = sql`version + 1`;
      let q = scope
        .updateTable(table as never)
        .set(set as never)
        .where(sql.ref('id') as never, '=', id as never);
      if (opts?.expectedVersion !== undefined) q = q.where(sql.ref('version') as never, '=', opts.expectedVersion as never);
      return (await q.returningAll().executeTakeFirst()) as never;
    },
  };
}

function makeEvents(db: Db, tenantId: string, correlationId: string, now: () => Date): EventSink {
  return {
    async emit(type, aggregate, data) {
      let version = 1;
      if (aggregate.type !== 'audit') {
        const r = await firstOf(
          sql<{ version: number }>`insert into aggregate_versions (id, tenant_id, aggregate_type, version)
            values (${aggregate.id}, ${tenantId}, ${aggregate.type}, 1)
            on conflict (id) do update set version = aggregate_versions.version + 1, updated_at = now()
            returning version`,
          db,
        );
        version = r?.version ?? 1;
      }
      await writeEvent(db, {
        eventType: type as EventType,
        tenantId,
        aggregateType: aggregate.type,
        aggregateId: aggregate.id,
        aggregateVersion: version,
        data: data as never,
        correlationId,
        producer: SERVICE,
        occurredAt: now(),
      });
    },
  };
}

function makeWork(db: Db): WorkQueue {
  return {
    async send(msg: WorkMessage) {
      await queueSend(db, SCHEMA, WORK_QUEUE, msg);
    },
  };
}

const SUPPLY = [...SUPPLY_SECTIONS] as string[];
const DEMAND = [...DEMAND_SECTIONS] as string[];

function closeWhere(t: string, f: CloseFilter) {
  const parts = [sql`tenant_id = ${t}`, sql`status = 'open'`];
  if (f.ids?.length) parts.push(sql`id = any(${uuidArray(f.ids)})`);
  if (f.subjectId) parts.push(sql`subject_id = ${f.subjectId}`);
  if (f.offerId) parts.push(sql`offer_id = ${f.offerId}`);
  if (f.demandId) parts.push(sql`demand_id = ${f.demandId}`);
  if (f.sections?.length) parts.push(sql`section = any(${textArray(f.sections)})`);
  return sql.join(parts, sql` and `);
}

function makeQueries(db: Db, t: string): Queries {
  const q: Queries = {
    async nextCode(prefix) {
      const r = await firstOf(
        sql<{ v: number }>`insert into code_sequences (tenant_id, prefix, next_value) values (${t}, ${prefix}, 2)
          on conflict (tenant_id, prefix) do update set next_value = code_sequences.next_value + 1, updated_at = now()
          returning next_value - 1 as v`,
        db,
      );
      const width = { SRQ: 3, PROP: 4, VIS: 4, DEAL: 4, CALL: 6 }[prefix];
      return `${prefix}-${String(r?.v ?? 1).padStart(width, '0')}`;
    },
    async settingsByKind(kind) {
      return firstOf(sql<Tables['settings']>`select * from settings where tenant_id = ${t} and kind = ${kind}`, db);
    },

    // ------------------------------------------------------------------------------------------------ queue
    async openItemFor(section, subjectType, subjectId) {
      return firstOf(
        sql<Tables['queue_items']>`select * from queue_items where tenant_id = ${t} and section = ${section}
          and subject_type = ${subjectType} and subject_id = ${subjectId} and status = 'open' for update`,
        db,
      );
    },
    async closeOpenItems(filter, status, reason, now) {
      if (!filter.ids?.length && !filter.subjectId && !filter.offerId && !filter.demandId) return [];
      return rowsOf(
        sql<Tables['queue_items']>`update queue_items set status = ${status}, closed_at = ${now}, closed_reason = ${reason},
          updated_at = ${now}, version = version + 1
          where id in (select id from queue_items where ${closeWhere(t, filter)} limit 500)
          returning *`,
        db,
      );
    },
    async openItemsOf(f, limit) {
      const cond = f.offerId ? sql`offer_id = ${f.offerId}` : f.demandId ? sql`demand_id = ${f.demandId}` : sql`subject_id = ${f.subjectId ?? null}`;
      return rowsOf(
        sql<Tables['queue_items']>`select * from queue_items where tenant_id = ${t} and status = 'open' and ${cond}
          order by id limit ${limit}`,
        db,
      );
    },
    async openItemsOfAssignee(userId, limit) {
      return rowsOf(
        sql<Tables['queue_items']>`select * from queue_items where tenant_id = ${t} and assignee_user_id = ${userId}
          and status = 'open' order by id limit ${limit}`,
        db,
      );
    },
    async unassignedOpenItems(team, limit) {
      return rowsOf(
        sql<Tables['queue_items']>`select * from queue_items where tenant_id = ${t} and assignee_user_id is null
          and section = any(${textArray(team === 'supply' ? SUPPLY : DEMAND)}) and status = 'open' order by id limit ${limit}`,
        db,
      );
    },
    async bumpCounters(deltas, now) {
      const merged = new Map<string, { userId: string; section: string; delta: number }>();
      for (const d of deltas) {
        const k = `${d.userId}|${d.section}`;
        const m = merged.get(k);
        if (m) m.delta += d.delta;
        else merged.set(k, { ...d });
      }
      for (const d of merged.values()) {
        if (!d.delta) continue;
        await sql`insert into queue_counters (id, tenant_id, user_id, section, open_count, changed_at)
            values (${uuidv7()}, ${t}, ${d.userId}, ${d.section}, greatest(0, ${d.delta}), ${now})
            on conflict (tenant_id, user_id, section) do update
            set open_count = greatest(0, queue_counters.open_count + ${d.delta}), changed_at = ${now}, updated_at = ${now}`.execute(db);
      }
    },
    async countersOf(userId) {
      return rowsOf(sql<Tables['queue_counters']>`select * from queue_counters where tenant_id = ${t} and user_id = ${userId}`, db);
    },
    async overdueCount(userId, section, now) {
      const r = await firstOf(
        sql<{ n: number }>`select count(*)::int as n from (select 1 from queue_items where tenant_id = ${t}
          and assignee_user_id = ${userId} and section = ${section} and status = 'open' and due_at < ${now} limit 10000) x`,
        db,
      );
      return r?.n ?? 0;
    },
    async eligibleShouldCount(userId, today, cap) {
      const r = await firstOf(
        sql<{ n: number }>`select count(*)::int as n from (select 1 from queue_items where tenant_id = ${t}
          and assignee_user_id = ${userId} and section = 'should_call' and status = 'open'
          and (next_call_date is null or next_call_date <= ${today}) limit ${cap}) x`,
        db,
      );
      return r?.n ?? 0;
    },
    async sectionItems(userId, section, ranked, today, after, limit) {
      let keyset = sql`true`;
      if (after && ranked)
        keyset = sql`(qi.rank_score < ${after['r']} or (qi.rank_score = ${after['r']} and qi.id > ${after['id']}))`;
      else if (after)
        keyset = sql`(qi.priority < ${after['p']} or (qi.priority = ${after['p']} and (qi.due_at > ${after['d']}
          or (qi.due_at = ${after['d']} and qi.id > ${after['id']}))))`;
      const order = ranked ? sql`qi.rank_score desc, qi.id` : sql`qi.priority desc, qi.due_at, qi.id`;
      const callable = ranked ? sql`and (qi.next_call_date is null or qi.next_call_date <= ${today})` : sql``;
      return rowsOf(
        sql<SectionItem>`select qi.*, lc.stage as life_stage, lc.day_count as day_count,
            case when ov.id is null then null else json_build_object('deal_type', ov.deal_type, 'property_types', ov.property_types,
              'micromarket', ov.micromarket, 'area_sqft_min', ov.area_sqft_min, 'sale_price_inr_min', ov.sale_price_inr_min,
              'rent_monthly_inr_min', ov.rent_monthly_inr_min) end as summary_offer,
            case when dv.id is null then null else json_build_object('deal_types', dv.deal_types, 'property_types', dv.property_types,
              'micromarkets', dv.micromarkets, 'budget_inr_max', dv.budget_inr_max, 'rent_monthly_inr_max', dv.rent_monthly_inr_max) end as summary_demand
          from queue_items qi
          left join life_curve lc on lc.tenant_id = qi.tenant_id and lc.subject_type = qi.subject_type and lc.subject_id = qi.subject_id
          left join offer_view ov on ov.id = qi.offer_id and ov.tenant_id = qi.tenant_id
          left join demand_view dv on dv.id = qi.demand_id and dv.tenant_id = qi.tenant_id
          where qi.tenant_id = ${t} and qi.assignee_user_id = ${userId} and qi.section = ${section} and qi.status = 'open'
            ${callable} and ${keyset}
          order by ${order} limit ${limit}`,
        db,
      );
    },
    async markRankDirty(f) {
      if (f.offerId) {
        const r = await sql`update queue_items set rank_dirty = true where tenant_id = ${t} and offer_id = ${f.offerId}
          and section = 'should_call' and status = 'open' and not rank_dirty`.execute(db);
        return Number(r.numAffectedRows ?? 0);
      }
      if (f.all) {
        const r = await sql`update queue_items set rank_dirty = true where id in (select id from queue_items where tenant_id = ${t}
          and section = 'should_call' and status = 'open' and not rank_dirty limit 20000)`.execute(db);
        return Number(r.numAffectedRows ?? 0);
      }
      return 0;
    },
    async dirtyRankItems(limit) {
      return rowsOf(
        sql<Tables['queue_items']>`select * from queue_items where tenant_id = ${t} and rank_dirty and status = 'open'
          order by id limit ${limit} for update skip locked`,
        db,
      );
    },
    async loadOfActiveStaff(roles, team) {
      const rows = await rowsOf(
        sql<{ user_id: string; open_count: number }>`select s.id as user_id, coalesce(sum(c.open_count), 0)::int as open_count
          from staff_users s left join queue_counters c on c.tenant_id = s.tenant_id and c.user_id = s.id
            and c.section = any(${textArray(team === 'supply' ? SUPPLY : DEMAND)})
          where s.tenant_id = ${t} and s.role = any(${textArray(roles)}) and s.active
          group by s.id order by s.id limit 200`,
        db,
      );
      return rows.map((r) => ({ userId: r.user_id, openCount: r.open_count }));
    },
    async activeStaffByRole(roles, limit) {
      return rowsOf(
        sql<Tables['staff_users']>`select * from staff_users where tenant_id = ${t} and role = any(${textArray(roles)}) and active
          order by id limit ${limit}`,
        db,
      );
    },
    async changedCounterUsers(limit) {
      const rows = await rowsOf(
        sql<{ user_id: string }>`select distinct user_id from (select user_id from queue_counters where tenant_id = ${t}
          and changed_at > coalesce(emitted_at, '-infinity'::timestamptz) order by changed_at limit ${limit * 20}) x limit ${limit}`,
        db,
      );
      return rows.map((r) => r.user_id);
    },
    async markCountersEmitted(userId, at) {
      await sql`update queue_counters set emitted_at = ${at} where tenant_id = ${t} and user_id = ${userId}`.execute(db);
    },
    async reconcileCounters(userId) {
      await sql`update queue_counters c set open_count = coalesce(x.n, 0), updated_at = now()
        from (select s.section, (select count(*)::int from queue_items qi where qi.tenant_id = ${t} and qi.assignee_user_id = ${userId}
                and qi.section = s.section and qi.status = 'open') as n
              from queue_counters s where s.tenant_id = ${t} and s.user_id = ${userId}) x
        where c.tenant_id = ${t} and c.user_id = ${userId} and c.section = x.section and c.open_count <> coalesce(x.n, 0)`.execute(db);
    },

    // ------------------------------------------------------------------------------------ subjects, projections
    async curveBySubject(subjectType, subjectId) {
      return firstOf(
        sql<Tables['life_curve']>`select * from life_curve where tenant_id = ${t} and subject_type = ${subjectType}
          and subject_id = ${subjectId}`,
        db,
      );
    },
    async dueCurves(today, limit) {
      return rowsOf(
        sql<Tables['life_curve']>`select * from life_curve where tenant_id = ${t} and frozen = false
          and next_change_on is not null and next_change_on <= ${today}
          order by next_change_on, id limit ${limit} for update skip locked`,
        db,
      );
    },
    async offersOfProject(projectId, limit) {
      return rowsOf(
        sql<Tables['offer_view']>`select * from offer_view where tenant_id = ${t} and project_id = ${projectId}
          order by captured_on, id limit ${limit}`,
        db,
      );
    },
    async linkContacts(subjectType, subjectId, personIds) {
      for (const p of personIds.slice(0, 50)) {
        await sql`insert into subject_contacts (id, tenant_id, person_id, subject_type, subject_id)
          values (${uuidv7()}, ${t}, ${p}, ${subjectType}, ${subjectId}) on conflict do nothing`.execute(db);
      }
    },
    async subjectsOfPerson(personId, limit) {
      return rowsOf(
        sql<Tables['subject_contacts']>`select * from subject_contacts where tenant_id = ${t} and person_id = ${personId}
          order by id limit ${limit}`,
        db,
      );
    },
    async linkMatchOffers(matchId, demandId, offerIds) {
      for (const o of offerIds.slice(0, 20)) {
        await sql`insert into match_offers (id, tenant_id, match_id, offer_id, demand_id)
          values (${uuidv7()}, ${t}, ${matchId}, ${o}, ${demandId}) on conflict do nothing`.execute(db);
      }
    },
    async countMatchesOfDemand(demandId, statuses) {
      const r = await firstOf(
        sql<{ n: number }>`select count(*)::int as n from match_view where tenant_id = ${t} and demand_id = ${demandId}
          and status = any(${textArray(statuses)})`,
        db,
      );
      return r?.n ?? 0;
    },
    async matchesOfDemand(demandId, statuses, limit) {
      return rowsOf(
        sql<Tables['match_view']>`select * from match_view where tenant_id = ${t} and demand_id = ${demandId}
          and status = any(${textArray(statuses)}) order by id limit ${limit}`,
        db,
      );
    },
    async confirmedMatchesOfOffer(offerId, limit) {
      return rowsOf(
        sql<Tables['match_view']>`select m.* from match_offers mo join match_view m on m.id = mo.match_id and m.tenant_id = mo.tenant_id
          where mo.tenant_id = ${t} and mo.offer_id = ${offerId} and m.status = 'Confirmed' order by m.id limit ${limit}`,
        db,
      );
    },
    async offerEngagements(offerId, today) {
      void today;
      const r = await firstOf(
        sql<{
          open_deal: boolean;
          visit: boolean;
          proposal: boolean;
          confirmed: number;
          open_matches: number;
        }>`with m as (
            select m.id, m.demand_id, m.status from match_offers mo
            join match_view m on m.id = mo.match_id and m.tenant_id = mo.tenant_id
            where mo.tenant_id = ${t} and mo.offer_id = ${offerId} limit 500),
          c as (select m.* from m join demand_journey dj on dj.id = m.demand_id and dj.tenant_id = ${t}
            where m.status = 'Confirmed' and dj.exit_type is null)
          select
            exists (select 1 from deals d where d.tenant_id = ${t} and d.offer_id = ${offerId}
              and d.stage not in ('Closed', 'Cancelled')) as open_deal,
            exists (select 1 from c join site_visits v on v.tenant_id = ${t} and v.demand_id = c.demand_id
              where v.status = 'Completed' and coalesce(v.outcome, '') not in ('Client no-show', 'Owner no-show')
              and ${offerId}::uuid = any(case when cardinality(v.visited_offer_ids) > 0 then v.visited_offer_ids else v.offer_ids end)) as visit,
            exists (select 1 from c join proposal_options po on po.tenant_id = ${t} and po.match_id = c.id
              join proposals p on p.id = po.proposal_id and p.tenant_id = ${t}
              where p.status = 'Sent' and ${offerId}::uuid = any(po.offer_ids)) as proposal,
            (select count(*)::int from c) as confirmed,
            (select count(*)::int from m where m.status in ('Suggested', 'Confirmed')) as open_matches`,
        db,
      );
      return {
        hasOpenDeal: !!r?.open_deal,
        hasCompletedVisit: !!r?.visit,
        hasSentProposal: !!r?.proposal,
        hasConfirmedMatch: (r?.confirmed ?? 0) > 0,
        openMatchCount: r?.open_matches ?? 0,
        confirmedMatchCount: r?.confirmed ?? 0,
      };
    },
    async demandEngagements(demandId) {
      const r = await firstOf(
        sql<{ open_deal: boolean; visit: boolean; proposal: boolean; confirmed: boolean; srq: boolean }>`select
          exists (select 1 from deals where tenant_id = ${t} and demand_id = ${demandId} and stage not in ('Closed', 'Cancelled')) as open_deal,
          exists (select 1 from site_visits where tenant_id = ${t} and demand_id = ${demandId} and status = 'Completed'
            and coalesce(outcome, '') <> 'Client no-show') as visit,
          exists (select 1 from proposals where tenant_id = ${t} and demand_id = ${demandId} and status = 'Sent') as proposal,
          exists (select 1 from match_view where tenant_id = ${t} and demand_id = ${demandId} and status = 'Confirmed') as confirmed,
          exists (select 1 from sourcing_requests where tenant_id = ${t} and demand_id = ${demandId}
            and status in ('Open', 'In progress')) as srq`,
        db,
      );
      return {
        hasOpenDeal: !!r?.open_deal,
        hasCompletedVisit: !!r?.visit,
        hasSentProposal: !!r?.proposal,
        hasConfirmedMatch: !!r?.confirmed,
        hasOpenSourcingRequest: !!r?.srq,
      };
    },
    async ownersOfConfirmedMatchOffers(demandId) {
      const rows = await rowsOf(
        sql<{ owner: string }>`select distinct o.owner_user_id as owner from match_view m
          join match_offers mo on mo.match_id = m.id and mo.tenant_id = m.tenant_id
          join offer_view o on o.id = mo.offer_id and o.tenant_id = m.tenant_id
          where m.tenant_id = ${t} and m.demand_id = ${demandId} and m.status = 'Confirmed' and o.owner_user_id is not null
          limit 100`,
        db,
      );
      return rows.map((r) => r.owner);
    },
    async watchlistTaskOfItem(itemId) {
      return firstOf(
        sql<Tables['watchlist_tasks']>`select * from watchlist_tasks where tenant_id = ${t} and watchlist_item_id = ${itemId}`,
        db,
      );
    },
    async capacityOf(userId) {
      return firstOf(sql<Tables['capacities']>`select * from capacities where tenant_id = ${t} and user_id = ${userId}`, db);
    },

    // ------------------------------------------------------------------------------- demand gap, source quality
    async demandGapCell(segment, dealType, micromarket) {
      return firstOf(
        sql<Tables['demand_gap']>`select * from demand_gap where tenant_id = ${t} and segment = ${segment}
          and deal_type = ${dealType} and micromarket = ${micromarket}`,
        db,
      );
    },
    async sourceQuality(sourceType) {
      return firstOf(
        sql<Tables['source_quality']>`select * from source_quality where tenant_id = ${t} and source_type = ${sourceType}`,
        db,
      );
    },
    async adjustGapCells(cells, demandDelta, supplyDelta, now) {
      for (const c of cells) {
        await sql`insert into demand_gap (id, tenant_id, segment, deal_type, micromarket, open_demand, matching_supply, gap, computed_at)
          values (${uuidv7()}, ${t}, ${c.segment}, ${c.dealType}, ${c.micromarket}, greatest(0, ${demandDelta}), greatest(0, ${supplyDelta}),
            greatest(0, ${demandDelta}) - greatest(0, ${supplyDelta}), ${now})
          on conflict (tenant_id, segment, deal_type, micromarket) do update set
            open_demand = greatest(0, demand_gap.open_demand + ${demandDelta}),
            matching_supply = greatest(0, demand_gap.matching_supply + ${supplyDelta}),
            gap = greatest(0, demand_gap.open_demand + ${demandDelta}) - greatest(0, demand_gap.matching_supply + ${supplyDelta}),
            updated_at = ${now}`.execute(db);
        // Items in the cell rank again (bounded; the nightly refresh covers the rest).
        await sql`update queue_items set rank_dirty = true where id in (
            select qi.id from offer_view o join queue_items qi on qi.tenant_id = o.tenant_id and qi.offer_id = o.id
            where o.tenant_id = ${t} and o.segment = ${c.segment} and o.deal_type = ${c.dealType} and o.micromarket = ${c.micromarket}
              and qi.section = 'should_call' and qi.status = 'open' and not qi.rank_dirty limit 500)`.execute(db);
      }
    },
    async recomputeDemandGap(now, today) {
      const r = await sql`insert into demand_gap (id, tenant_id, segment, deal_type, micromarket, open_demand, matching_supply, gap,
            budget_p10, budget_p25, budget_p75, budget_p90, computed_at)
          select gen_random_uuid(), ${t}, cell.segment, cell.deal_type, cell.micromarket, coalesce(d.n, 0), coalesce(s.n, 0),
            coalesce(d.n, 0) - coalesce(s.n, 0), d.p10, d.p25, d.p75, d.p90, ${now}
          from (
            select distinct dv.segment, dt as deal_type, mm as micromarket from demand_view dv
              cross join lateral unnest(dv.deal_types) dt cross join lateral unnest(dv.micromarkets) mm
              where dv.tenant_id = ${t} and dv.segment is not null and not dv.outside_launch_area
            union
            select distinct segment, deal_type, micromarket from offer_view
              where tenant_id = ${t} and segment is not null and micromarket is not null and not outside_launch_area
          ) cell
          left join (
            select dv.segment, dt as deal_type, mm as micromarket, count(*)::int as n,
              percentile_disc(0.10) within group (order by case when dt = 'Lease' then dv.rent_monthly_inr_max else dv.budget_inr_max end) as p10,
              percentile_disc(0.25) within group (order by case when dt = 'Lease' then dv.rent_monthly_inr_max else dv.budget_inr_max end) as p25,
              percentile_disc(0.75) within group (order by case when dt = 'Lease' then dv.rent_monthly_inr_max else dv.budget_inr_max end) as p75,
              percentile_disc(0.90) within group (order by case when dt = 'Lease' then dv.rent_monthly_inr_max else dv.budget_inr_max end) as p90
            from demand_view dv join demand_journey dj on dj.id = dv.id and dj.tenant_id = dv.tenant_id
              left join life_curve lc on lc.tenant_id = dv.tenant_id and lc.subject_type = 'demand' and lc.subject_id = dv.id
              cross join lateral unnest(dv.deal_types) dt cross join lateral unnest(dv.micromarkets) mm
            where dv.tenant_id = ${t} and not dv.voided and not dv.outside_launch_area and dv.merged_into is null
              and dj.exit_type is null and dj.commercial_status <> 'Closed' and coalesce(lc.stage, 'Fresh') <> 'Expired'
            group by 1, 2, 3
          ) d on d.segment = cell.segment and d.deal_type = cell.deal_type and d.micromarket = cell.micromarket
          left join (
            select o.segment, o.deal_type, o.micromarket, count(*)::int as n
            from offer_view o join offer_journey oj on oj.id = o.id and oj.tenant_id = o.tenant_id
              left join life_curve lc on lc.tenant_id = o.tenant_id and lc.subject_type = 'offer' and lc.subject_id = o.id
            where o.tenant_id = ${t} and not o.voided and o.merged_into is null
              and oj.commercial_status in ('Upcoming', 'Available') and coalesce(lc.stage, 'Fresh') <> 'Expired'
            group by 1, 2, 3
          ) s on s.segment = cell.segment and s.deal_type = cell.deal_type and s.micromarket = cell.micromarket
          on conflict (tenant_id, segment, deal_type, micromarket) do update set open_demand = excluded.open_demand,
            matching_supply = excluded.matching_supply, gap = excluded.gap, budget_p10 = excluded.budget_p10,
            budget_p25 = excluded.budget_p25, budget_p75 = excluded.budget_p75, budget_p90 = excluded.budget_p90,
            computed_at = excluded.computed_at, updated_at = excluded.computed_at`.execute(db);
      void today;
      return Number(r.numAffectedRows ?? 0);
    },
    async recomputeSourceQuality(now, since) {
      const r = await sql`insert into source_quality (id, tenant_id, source_type, captured_90d, verified_or_matched_90d, score, computed_at)
          select gen_random_uuid(), ${t}, o.source_type, count(*)::int,
            count(*) filter (where o.record_stage in ('Verified', 'Qualified') or oj.confirmed_match_count > 0 or oj.open_match_count > 0)::int,
            round(((count(*) filter (where o.record_stage in ('Verified', 'Qualified') or oj.confirmed_match_count > 0
              or oj.open_match_count > 0) + 2.5) / (count(*) + 5.0))::numeric, 3), ${now}
          from offer_view o left join offer_journey oj on oj.id = o.id and oj.tenant_id = o.tenant_id
          where o.tenant_id = ${t} and o.source_type is not null and o.captured_on >= ${since}
          group by o.source_type
          on conflict (tenant_id, source_type) do update set captured_90d = excluded.captured_90d,
            verified_or_matched_90d = excluded.verified_or_matched_90d, score = excluded.score,
            computed_at = excluded.computed_at, updated_at = excluded.computed_at`.execute(db);
      return Number(r.numAffectedRows ?? 0);
    },

    // ------------------------------------------------------------------------------------------ engagements
    async openSourcingRequestsOfDemand(demandId) {
      return rowsOf(
        sql<Tables['sourcing_requests']>`select * from sourcing_requests where tenant_id = ${t} and demand_id = ${demandId}
          and status in ('Open', 'In progress') order by id limit 20`,
        db,
      );
    },
    async openDealOfDemand(demandId) {
      return firstOf(
        sql<Tables['deals']>`select * from deals where tenant_id = ${t} and demand_id = ${demandId}
          and stage not in ('Closed', 'Cancelled') limit 1`,
        db,
      );
    },
    async openDealsOfOffer(offerId, limit) {
      return rowsOf(
        sql<Tables['deals']>`select * from deals where tenant_id = ${t} and offer_id = ${offerId}
          and stage not in ('Closed', 'Cancelled') order by id limit ${limit}`,
        db,
      );
    },
    async dealOfMatch(matchId) {
      return firstOf(sql<Tables['deals']>`select * from deals where tenant_id = ${t} and match_id = ${matchId} order by id desc limit 1`, db);
    },
    async proposalOptions(proposalId) {
      return rowsOf(
        sql<Tables['proposal_options']>`select * from proposal_options where tenant_id = ${t} and proposal_id = ${proposalId}
          order by position limit 20`,
        db,
      );
    },
    async replaceProposalOptions(proposalId, options) {
      await sql`delete from proposal_options where tenant_id = ${t} and proposal_id = ${proposalId}`.execute(db);
      for (const o of options) {
        await sql`insert into proposal_options (id, tenant_id, proposal_id, position, match_id, offer_ids)
          values (${uuidv7()}, ${t}, ${proposalId}, ${o.position}, ${o.matchId}, ${uuidArray(o.offerIds)})`.execute(db);
      }
    },
    async activeLink(proposalId) {
      return firstOf(
        sql<Tables['proposal_links']>`select * from proposal_links where tenant_id = ${t} and proposal_id = ${proposalId}
          and revoked_at is null order by created_at desc limit 1`,
        db,
      );
    },
    async linkByHash(hash) {
      // The token is globally unique; the tenant comes from the row (public page, LLD §3.5 proposal_links_token).
      return firstOf(sql<Tables['proposal_links']>`select * from proposal_links where token_hash = ${hash}`, db);
    },
    async revokeLinks(proposalId, at) {
      const r = await sql`update proposal_links set revoked_at = ${at}, updated_at = ${at} where tenant_id = ${t}
        and proposal_id = ${proposalId} and revoked_at is null`.execute(db);
      return Number(r.numAffectedRows ?? 0);
    },
    async recordLinkOpen(link, at, ipHash, uaFamily) {
      await sql`insert into proposal_link_opens (id, tenant_id, link_id, opened_at, ip_hash, ua_family)
        values (${uuidv7()}, ${link.tenant_id}, ${link.id}, ${at}, ${ipHash}, ${uaFamily})`.execute(db);
      const r = await firstOf(
        sql<Tables['proposal_links']>`update proposal_links set open_count = open_count + 1, last_opened_at = ${at}, updated_at = ${at}
          where id = ${link.id} and tenant_id = ${link.tenant_id} returning *`,
        db,
      );
      return r ?? link;
    },
    async openProposalIdsOfOffer(offerId, limit) {
      const rows = await rowsOf(
        sql<{ id: string }>`select distinct p.id from match_offers mo
          join proposal_options po on po.tenant_id = mo.tenant_id and po.match_id = mo.match_id
          join proposals p on p.id = po.proposal_id and p.tenant_id = mo.tenant_id
          where mo.tenant_id = ${t} and mo.offer_id = ${offerId} and p.status in ('Preparing', 'Ready', 'Sent') limit ${limit}`,
        db,
      );
      return rows.map((r) => r.id);
    },
    async dealEvents(dealId, limit) {
      return rowsOf(
        sql<Tables['deal_events']>`select * from deal_events where tenant_id = ${t} and deal_id = ${dealId} order by at, id limit ${limit}`,
        db,
      );
    },
    async leaseRenewalOfDeal(dealId) {
      return firstOf(sql<Tables['lease_renewals']>`select * from lease_renewals where tenant_id = ${t} and deal_id = ${dealId}`, db);
    },
    async visitsOfDemand(demandId, statuses, limit) {
      return rowsOf(
        sql<Tables['site_visits']>`select * from site_visits where tenant_id = ${t} and demand_id = ${demandId}
          and status = any(${textArray(statuses)}) order by scheduled_at, id limit ${limit}`,
        db,
      );
    },

    // ------------------------------------------------------------------------------------------------ lists
    async listCalls(f, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (f.subjectId) conds.push(sql`subject_id = ${f.subjectId}`);
      if (f.personId) conds.push(sql`person_id = ${f.personId}`);
      if (f.loggedBy) conds.push(sql`logged_by = ${f.loggedBy}`);
      if (f.from) conds.push(sql`logged_at >= ${f.from}`);
      if (f.to) conds.push(sql`logged_at < ${f.to}`);
      if (after) conds.push(sql`(logged_at < ${after['k']} or (logged_at = ${after['k']} and id < ${after['id']}))`);
      return rowsOf(
        sql<Tables['calls']>`select * from calls where ${sql.join(conds, sql` and `)} order by logged_at desc, id desc limit ${limit}`,
        db,
      );
    },
    async callsLoggedSince(userId, since) {
      const r = await firstOf(
        sql<{ n: number }>`select count(*)::int as n from calls where tenant_id = ${t} and logged_by = ${userId} and logged_at >= ${since}`,
        db,
      );
      return r?.n ?? 0;
    },
    async listCapacities(team, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (team) conds.push(sql`team = ${team}`);
      if (after) conds.push(sql`user_id > ${after['id']}`);
      return rowsOf(
        sql<Tables['capacities']>`select * from capacities where ${sql.join(conds, sql` and `)} order by user_id limit ${limit}`,
        db,
      );
    },
    async listSourcingRequests(f, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (f['status']) conds.push(sql`status = ${f['status'] as string}`);
      if (f['assigneeUserId']) conds.push(sql`assignee_user_id = ${f['assigneeUserId'] as string}`);
      if (f['requestedBy']) conds.push(sql`requested_by = ${f['requestedBy'] as string}`);
      if (f['demandId']) conds.push(sql`demand_id = ${f['demandId'] as string}`);
      if (after) conds.push(sql`(due_date > ${after['k']} or (due_date = ${after['k']} and id > ${after['id']}))`);
      return rowsOf(
        sql<Tables['sourcing_requests']>`select * from sourcing_requests where ${sql.join(conds, sql` and `)}
          order by due_date, id limit ${limit}`,
        db,
      );
    },
    async listProposals(f, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (f['demandId']) conds.push(sql`demand_id = ${f['demandId'] as string}`);
      if (f['status']) conds.push(sql`status = ${f['status'] as string}`);
      if (f['createdBy']) conds.push(sql`created_by = ${f['createdBy'] as string}`);
      if (after) conds.push(sql`(created_at < ${after['k']} or (created_at = ${after['k']} and id < ${after['id']}))`);
      return rowsOf(
        sql<Tables['proposals']>`select * from proposals where ${sql.join(conds, sql` and `)} order by created_at desc, id desc limit ${limit}`,
        db,
      );
    },
    async listSiteVisits(f, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (f['demandId']) conds.push(sql`demand_id = ${f['demandId'] as string}`);
      if (f['offerId']) conds.push(sql`offer_ids @> array[${f['offerId'] as string}]::uuid[]`);
      if (f['attendeeUserId']) conds.push(sql`attendee_user_ids @> array[${f['attendeeUserId'] as string}]::uuid[]`);
      if (f['status']) conds.push(sql`status = ${f['status'] as string}`);
      if (f['from']) conds.push(sql`scheduled_at >= ${f['from'] as string}`);
      if (f['to']) conds.push(sql`scheduled_at < ${f['to'] as string}`);
      if (after) conds.push(sql`(scheduled_at > ${after['k']} or (scheduled_at = ${after['k']} and id > ${after['id']}))`);
      return rowsOf(
        sql<Tables['site_visits']>`select * from site_visits where ${sql.join(conds, sql` and `)} order by scheduled_at, id limit ${limit}`,
        db,
      );
    },
    async listDeals(f, today, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      const stage = f['stage'] as string | undefined;
      const openList = !stage || (stage !== 'Closed' && stage !== 'Cancelled');
      if (stage) conds.push(sql`stage = ${stage}`);
      else conds.push(sql`stage not in ('Closed', 'Cancelled')`);
      if (f['demandId']) conds.push(sql`demand_id = ${f['demandId'] as string}`);
      if (f['offerId']) conds.push(sql`offer_id = ${f['offerId'] as string}`);
      if (f['ownerUserId']) conds.push(sql`owner_user_id = ${f['ownerUserId'] as string}`);
      if (f['followUpDue']) conds.push(sql`follow_up_date <= ${today} and stage not in ('Closed', 'Cancelled')`);
      if (openList) {
        if (after) conds.push(sql`(follow_up_date > ${after['k']} or (follow_up_date = ${after['k']} and id > ${after['id']}))`);
        return rowsOf(
          sql<Tables['deals']>`select * from deals where ${sql.join(conds, sql` and `)} order by follow_up_date, id limit ${limit}`,
          db,
        );
      }
      if (after) conds.push(sql`(updated_at < ${after['k']} or (updated_at = ${after['k']} and id < ${after['id']}))`);
      return rowsOf(
        sql<Tables['deals']>`select * from deals where ${sql.join(conds, sql` and `)} order by updated_at desc, id desc limit ${limit}`,
        db,
      );
    },
    async listLeaseRenewals(f, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (f['status']) conds.push(sql`status = ${f['status'] as string}`);
      if (f['dueBefore']) conds.push(sql`due_on <= ${f['dueBefore'] as string}`);
      if (after) conds.push(sql`(due_on > ${after['k']} or (due_on = ${after['k']} and id > ${after['id']}))`);
      return rowsOf(
        sql<Tables['lease_renewals']>`select * from lease_renewals where ${sql.join(conds, sql` and `)} order by due_on, id limit ${limit}`,
        db,
      );
    },
    async listNotifications(userId, unreadOnly, after, limit) {
      const conds = [sql`tenant_id = ${t}`, sql`user_id = ${userId}`];
      if (unreadOnly) conds.push(sql`read_at is null`);
      if (after) conds.push(sql`(created_at < ${after['k']} or (created_at = ${after['k']} and id < ${after['id']}))`);
      return rowsOf(
        sql<Tables['notifications']>`select * from notifications where ${sql.join(conds, sql` and `)}
          order by created_at desc, id desc limit ${limit}`,
        db,
      );
    },
    async unreadCount(userId) {
      const r = await firstOf(
        sql<{ n: number }>`select count(*)::int as n from notifications where tenant_id = ${t} and user_id = ${userId} and read_at is null`,
        db,
      );
      return r?.n ?? 0;
    },
    async unreadByDedupeKey(userId, key) {
      return firstOf(
        sql<Tables['notifications']>`select * from notifications where tenant_id = ${t} and user_id = ${userId}
          and dedupe_key = ${key} and read_at is null for update`,
        db,
      );
    },
    async markRead(userId, ids, upTo, at) {
      const cond = ids ? sql`id = any(${uuidArray(ids)})` : sql`created_at <= ${upTo ?? at}`;
      const r = await sql`update notifications set read_at = ${at}, updated_at = ${at} where id in (
          select id from notifications where tenant_id = ${t} and user_id = ${userId} and read_at is null and ${cond} limit 5000)`.execute(db);
      return Number(r.numAffectedRows ?? 0);
    },
    async listWatchlistTasks(f, today, after, limit) {
      const conds = [sql`tenant_id = ${t}`];
      if (f['status']) conds.push(sql`status = ${f['status'] as string}`);
      if (f['assigneeUserId']) conds.push(sql`assignee_user_id = ${f['assigneeUserId'] as string}`);
      if (f['deadlineWithinDays'] !== undefined && f['deadlineWithinDays'] !== null)
        conds.push(sql`deadline_date <= (${today}::date + ${Number(f['deadlineWithinDays'])}::int)`);
      if (after) {
        conds.push(
          after['k'] === null
            ? sql`(deadline_date is null and id > ${after['id']})`
            : sql`(deadline_date > ${after['k']} or deadline_date is null or (deadline_date = ${after['k']} and id > ${after['id']}))`,
        );
      }
      return rowsOf(
        sql<Tables['watchlist_tasks']>`select * from watchlist_tasks where ${sql.join(conds, sql` and `)}
          order by deadline_date nulls last, id limit ${limit}`,
        db,
      );
    },
    async subjectStates(subjectType, since, after, limit) {
      const table = subjectType === 'offer' ? sql`offer_journey` : sql`demand_journey`;
      const exit = subjectType === 'offer' ? sql`null::text` : sql`j.exit_type`;
      const conds = [sql`j.tenant_id = ${t}`];
      if (since) conds.push(sql`j.updated_at >= ${since}`);
      if (after) conds.push(sql`(j.updated_at > ${after['k']} or (j.updated_at = ${after['k']} and j.id > ${after['id']}))`);
      return rowsOf(
        sql<{ id: string; commercial_status: string; exit_type: string | null; stage: string | null; day_count: number | null; version: number; updated_at: Date }>`
          select j.id, j.commercial_status, ${exit} as exit_type, lc.stage, lc.day_count, j.version, j.updated_at
          from ${table} j left join life_curve lc on lc.tenant_id = j.tenant_id and lc.subject_type = ${subjectType} and lc.subject_id = j.id
          where ${sql.join(conds, sql` and `)} order by j.updated_at, j.id limit ${limit}`,
        db,
      );
    },

    // -------------------------------------------------------------------------------------------------- jobs
    async dueLeaseRenewals(today, limit) {
      return rowsOf(
        sql<Tables['lease_renewals']>`select * from lease_renewals where tenant_id = ${t} and status = 'scheduled'
          and due_on <= ${today} order by due_on, id limit ${limit} for update skip locked`,
        db,
      );
    },
    async dueDormantRevisits(today, after, limit) {
      const keyset = after ? sql`and (revisit_date > ${after['k']} or (revisit_date = ${after['k']} and id > ${after['id']}))` : sql``;
      return rowsOf(
        sql<{ id: string; revisit_date: string }>`select id, revisit_date from demand_journey where tenant_id = ${t}
          and exit_type = 'Dormant' and revisit_date <= ${today} ${keyset} order by revisit_date, id limit ${limit}`,
        db,
      );
    },
    async overdueDeals(today, after, limit) {
      const keyset = after ? sql`and (follow_up_date > ${after['k']} or (follow_up_date = ${after['k']} and id > ${after['id']}))` : sql``;
      return rowsOf(
        sql<Tables['deals']>`select * from deals where tenant_id = ${t} and stage not in ('Closed', 'Cancelled')
          and follow_up_date < ${today} ${keyset} order by follow_up_date, id limit ${limit}`,
        db,
      );
    },
    async overdueSourcingRequests(today, after, limit) {
      const keyset = after ? sql`and (due_date > ${after['k']} or (due_date = ${after['k']} and id > ${after['id']}))` : sql``;
      return rowsOf(
        sql<Tables['sourcing_requests']>`select * from sourcing_requests where tenant_id = ${t} and status in ('Open', 'In progress')
          and due_date < ${today} ${keyset} order by due_date, id limit ${limit}`,
        db,
      );
    },
    async jobCursor(job, runDate) {
      return firstOf(
        sql<{ cursor: string | null; processed: number; done: boolean }>`select cursor, processed, done from job_runs
          where job = ${job} and run_date = ${runDate} and tenant_id = ${t}`,
        db,
      );
    },
    async saveJobCursor(job, runDate, cursor, processed, done, now) {
      await sql`insert into job_runs (id, tenant_id, job, run_date, cursor, processed, done, started_at, finished_at)
        values (${uuidv7()}, ${t}, ${job}, ${runDate}, ${cursor}, ${processed}, ${done}, ${now}, ${done ? now : null})
        on conflict (job, run_date, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update
        set cursor = excluded.cursor, processed = job_runs.processed + excluded.processed, done = excluded.done,
          finished_at = excluded.finished_at, updated_at = now()`.execute(db);
    },
    async purgeBefore(kind, before, limit) {
      switch (kind) {
        case 'notifications': {
          const r = await sql`delete from notifications where id in (select id from notifications where tenant_id = ${t}
            and created_at < ${before} limit ${limit})`.execute(db);
          return { count: Number(r.numAffectedRows ?? 0), paths: [] };
        }
        case 'link_opens': {
          const r = await sql`delete from proposal_link_opens where id in (select id from proposal_link_opens where tenant_id = ${t}
            and opened_at < ${before} limit ${limit})`.execute(db);
          return { count: Number(r.numAffectedRows ?? 0), paths: [] };
        }
        case 'pii_notes': {
          let n = 0;
          for (const [table, col] of [
            ['calls', 'notes'],
            ['sourcing_requests', 'notes'],
            ['site_visits', 'notes'],
            ['deal_events', 'note'],
            ['proposals', 'cover_note'],
          ] as const) {
            const r = await sql`update ${ident(table)} set ${ident(col)} = null where id in (select id from ${ident(table)}
              where tenant_id = ${t} and ${ident(col)} is not null and updated_at < ${before} limit ${limit})`.execute(db);
            n += Number(r.numAffectedRows ?? 0);
          }
          return { count: n, paths: [] };
        }
        case 'snapshots': {
          const rows = await rowsOf(
            sql<{ pdf_path: string | null }>`with old as (select id, pdf_path from proposals where tenant_id = ${t}
                and snapshot is not null and created_at < ${before} limit ${limit} for update)
              update proposals set snapshot = null, pdf_path = null, pdf_status = 'none', updated_at = now()
              from old where proposals.id = old.id returning old.pdf_path as pdf_path`,
            db,
          );
          return { count: rows.length, paths: rows.map((r) => r.pdf_path).filter((p): p is string => !!p) };
        }
      }
    },

    async rearmCurves(categoryKeys, afterId, today, limit) {
      const rows = await rowsOf(
        sql<{ id: string }>`select id from life_curve where tenant_id = ${t} and category_key = any(${textArray(categoryKeys)})
          and frozen = false ${afterId ? sql`and id > ${afterId}` : sql``} order by id limit ${limit}`,
        db,
      );
      if (!rows.length) return null;
      await sql`update life_curve set next_change_on = ${today} where tenant_id = ${t} and id = any(${uuidArray(rows.map((r) => r.id))})
        and stage <> 'Paused' and (next_change_on is null or next_change_on > ${today})`.execute(db);
      return rows.length < limit ? null : (rows.at(-1)?.id ?? null);
    },

    // ------------------------------------------------------------------------------------------------ merges
    async repoint(mergeId, target: RepointTarget, from, to, limit) {
      const table = ident(target.table);
      const col = ident(target.column);
      const match = target.kind === 'array' ? sql`${from}::uuid = any(${col})` : sql`${col} = ${from}`;
      const next = target.kind === 'array' ? sql`array_replace(${col}, ${from}::uuid, ${to}::uuid)` : sql`${to}::uuid`;
      const r = await sql`with target as (
          select id, ${col} as old from ${table} where tenant_id = ${t} and ${match} order by id limit ${limit} for update),
        logged as (
          insert into merge_log (id, tenant_id, merge_id, table_name, row_id, before)
          select gen_random_uuid(), ${t}, ${mergeId}, ${target.table}, target.id,
            jsonb_build_object(${target.column}::text, to_jsonb(target.old), '__to', ${to}::text, '__from', ${from}::text)
          from target)
        update ${table} set ${col} = ${next}, updated_at = now() from target where ${table}.id = target.id`.execute(db);
      return Number(r.numAffectedRows ?? 0);
    },
    async logBefore(mergeId, table, rowId, before) {
      await sql`insert into merge_log (id, tenant_id, merge_id, table_name, row_id, before)
        values (${uuidv7()}, ${t}, ${mergeId}, ${table}, ${rowId}, ${JSON.stringify(before)}::jsonb)`.execute(db);
    },
    async restoreMerge(mergeId, limit) {
      const logs = await rowsOf(
        sql<{ id: string; table_name: string; row_id: string; before: Record<string, unknown> }>`select id, table_name, row_id, before
          from merge_log where tenant_id = ${t} and merge_id = ${mergeId} and undone_at is null order by created_at desc, id desc limit ${limit}`,
        db,
      );
      const survivors = new Set<string>();
      for (const log of logs) {
        const table = ident(log.table_name);
        const to = typeof log.before['__to'] === 'string' ? (log.before['__to'] as string) : null;
        const from = typeof log.before['__from'] === 'string' ? (log.before['__from'] as string) : null;
        if (to) survivors.add(to);
        for (const [col, value] of Object.entries(log.before)) {
          if (col.startsWith('__')) continue;
          if (to && from) {
            // re-pointed columns: restore only where the row still holds the survivor (newer edits win)
            const isArray = Array.isArray(value);
            if (isArray) {
              await sql`update ${table} set ${ident(col)} = array_replace(${ident(col)}, ${to}::uuid, ${from}::uuid)
                where tenant_id = ${t} and id = ${log.row_id}`.execute(db);
            } else {
              await sql`update ${table} set ${ident(col)} = ${from}::uuid where tenant_id = ${t} and id = ${log.row_id}
                and ${ident(col)} = ${to}::uuid`.execute(db);
            }
          } else {
            await sql`update ${table} set ${ident(col)} = (jsonb_populate_record(null::${table}, ${JSON.stringify({ [col]: value })}::jsonb)).${ident(col)}
              where tenant_id = ${t} and id = ${log.row_id}`.execute(db);
          }
        }
        await sql`update merge_log set undone_at = now() where id = ${log.id}`.execute(db);
      }
      return [...survivors];
    },
  };
  return q;
}

/** Builds the transaction-bound ports for one tenant. */
export function makeTx(db: Db, tenantId: string, now: Date, correlationId: string): Tx {
  const clock = () => now;
  return {
    tenantId,
    now,
    today: istDate(now),
    correlationId,
    rows: makeRows(db, tenantId, () => uuidv7(), clock),
    q: makeQueries(db, tenantId),
    events: makeEvents(db, tenantId, correlationId, clock),
    work: makeWork(db),
    newId: () => uuidv7(),
    memo: new Map(),
  };
}

export function createTxRunner(db: Kysely<JourneysDb>, clock: () => Date): TxRunner {
  return {
    run(tenantId, meta: TxMeta, fn) {
      return withTransaction(db, (trx) => fn(makeTx(trx, tenantId, clock(), meta.correlationId)), {
        statementTimeoutMs: meta.statementTimeoutMs ?? 2000,
      });
    },
    async tenants() {
      // loose index scan over life_curve_subject: distinct tenants without reading every row
      const r = await sql<{ tenant_id: string }>`with recursive t as (
          (select tenant_id from life_curve order by tenant_id limit 1)
          union all
          select (select tenant_id from life_curve where tenant_id > t.tenant_id order by tenant_id limit 1) from t where t.tenant_id is not null)
        select tenant_id from t where tenant_id is not null`.execute(db);
      return r.rows.map((x) => x.tenant_id);
    },
  };
}

/** For callers that already hold a transaction (event drains): build the ports on it. */
export const txOn = (trx: Transaction<JourneysDb>, tenantId: string, now: Date, correlationId: string) =>
  makeTx(trx, tenantId, now, correlationId);
