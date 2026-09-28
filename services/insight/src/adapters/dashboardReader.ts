// DashboardReader: aggregates for the dashboards from the rollups, daily facts and small tables (LLD §4.8). Every
// query leads with tenant_id and is served by a tenant-first index; grouping columns come from constant allow-lists.
import { sql } from 'kysely';
import type { Kysely, RawBuilder } from 'kysely';
import type { DashboardReader, DimFilter } from '../application/ports.js';
import { istMidnight, addDays } from '../domain/dates.js';
import type { InsightDb } from './db.js';

const OFFER_DIM_COLUMNS: Record<keyof DimFilter, string | null> = {
  segment: 'segment',
  dealType: 'deal_type',
  market: 'market',
  propertyType: 'property_type_primary',
  micromarket: 'micromarket',
  ownerUserId: 'owner_user_id',
  saleMode: 'sale_mode',
  tenancyStatus: 'tenancy_status',
};
const DEMAND_DIM_COLUMNS: Record<keyof DimFilter, string | null> = {
  ...OFFER_DIM_COLUMNS,
  dealType: 'deal_type_primary',
  saleMode: null,
  tenancyStatus: null,
};
const FACT_DIM_COLUMNS: Record<keyof DimFilter, string | null> = {
  ...OFFER_DIM_COLUMNS,
  propertyType: null,
  saleMode: null,
  tenancyStatus: null,
};
const GROUPABLE = new Set([
  'segment',
  'deal_type',
  'deal_type_primary',
  'market',
  'property_type_primary',
  'micromarket',
  'life_stage',
  'commercial_status',
  'record_stage',
  'publication_level',
  'source_type',
  'sale_mode',
  'tenancy_status',
  'exit_type',
]);

function dimWhere(f: DimFilter, map: Record<keyof DimFilter, string | null>): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [];
  for (const [k, v] of Object.entries(f) as [keyof DimFilter, string | undefined][]) {
    const c = map[k];
    if (v !== undefined && c) parts.push(sql`${sql.ref(c)} = ${v}`);
  }
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

function groupCols(by: readonly string[]) {
  for (const c of by) if (!GROUPABLE.has(c)) throw new Error(`not groupable: ${c}`);
  return by;
}

const num = (v: unknown) => Number(v ?? 0);

export function createDashboardReader(db: Kysely<InsightDb>): DashboardReader {
  const rollup = async (table: 'rm_offer_rollup' | 'rm_demand_rollup', tenantId: string, extra: RawBuilder<unknown>, by: readonly string[]) => {
    const cols = groupCols(by);
    const select = cols.length ? sql`${sql.join(cols.map((c) => sql.ref(c)))}, ` : sql``;
    const group = cols.length ? sql` group by ${sql.join(cols.map((c) => sql.ref(c)))}` : sql``;
    const r = await sql<Record<string, string | null> & { n: string }>`
      select ${select}coalesce(sum(n), 0)::bigint as n from ${sql.table(table)}
       where tenant_id = ${tenantId}${extra}${group}`.execute(db);
    return r.rows.map((row) => ({ ...row, n: num(row.n) })) as unknown as (Record<string, string | null> & { n: number })[];
  };
  const range = (column: string, from: string, to: string) =>
    sql`${sql.ref(column)} >= ${istMidnight(from)} and ${sql.ref(column)} < ${istMidnight(addDays(to, 1))}`;

  return {
    offerRollup: (tenantId, f, by, statuses) =>
      rollup(
        'rm_offer_rollup',
        tenantId,
        sql`${dimWhere(f, OFFER_DIM_COLUMNS)}${statuses ? sql` and commercial_status = any(${[...statuses]})` : sql``}`,
        by,
      ),
    demandRollup: (tenantId, f, by) =>
      rollup(
        'rm_demand_rollup',
        tenantId,
        sql` and exit_type is null and commercial_status is distinct from 'Closed'${dimWhere(f, DEMAND_DIM_COLUMNS)}`,
        by,
      ),
    async facts(tenantId, metrics, r, f, by) {
      const res = await sql<{ key: string | null; n: string }>`
        select ${sql.ref(by)} as key, sum(n)::bigint as n from rm_daily_fact
         where tenant_id = ${tenantId} and metric = any(${[...metrics]}) and day between ${r.from} and ${r.to}${dimWhere(f, FACT_DIM_COLUMNS)}
         group by 1 order by 2 desc limit 200`.execute(db);
      return res.rows.map((x) => ({ key: x.key, n: num(x.n) }));
    },
    async queueCounts(tenantId, userId) {
      const res = await sql<{ section: string; n: string }>`
        select e.key as section, sum((e.value)::bigint)::bigint as n
          from rm_queue_counts q, jsonb_each_text(q.counts) e
         where q.tenant_id = ${tenantId}${userId ? sql` and q.user_id = ${userId}` : sql``}
         group by e.key`.execute(db);
      return Object.fromEntries(res.rows.map((x) => [x.section, num(x.n)]));
    },
    async openSourcingRequests(tenantId) {
      const r = await sql<{ n: number }>`select count(*)::int as n from rm_sourcing_request
        where tenant_id = ${tenantId} and status = any(${['open', 'in_progress']})`.execute(db);
      return num(r.rows[0]?.n);
    },
    async siteVisitsScheduled(tenantId, r) {
      const res = await sql<{ n: number }>`select count(*)::int as n from rm_site_visit
        where tenant_id = ${tenantId} and ${range('scheduled_for', r.from, r.to)}`.execute(db);
      return num(res.rows[0]?.n);
    },
    async followUpsDue(tenantId, today, ownerUserId) {
      const res = await sql<{ n: number }>`select count(*)::int as n from rm_deal
        where tenant_id = ${tenantId} and status = 'open' and follow_up_date <= ${today}${ownerUserId ? sql` and owner_user_id = ${ownerUserId}` : sql``}`.execute(db);
      return num(res.rows[0]?.n);
    },
    async stock(tenantId) {
      const res = await sql<{ properties: number | null; projects: number }>`
        select (select property_count from rm_state where tenant_id = ${tenantId}) as properties,
               (select count(*)::int from rm_project where tenant_id = ${tenantId}) as projects`.execute(db);
      const row = res.rows[0];
      return { properties: row?.properties === null || row?.properties === undefined ? null : num(row.properties), projects: num(row?.projects) };
    },
    async deskItems(tenantId) {
      const res = await sql<{ record_scope: string | null; side: string | null; sector: string | null; participant_role: string | null; with_property: boolean; n: number }>`
        select record_scope, side, sector, participant_role, (linked_property_id is not null) as with_property, count(*)::int as n
          from rm_desk_item where tenant_id = ${tenantId} and status <> 'archived'
         group by 1, 2, 3, 4, 5 limit 1000`.execute(db);
      return res.rows.map((x) => ({ ...x, n: num(x.n) }));
    },
    async watchlist(tenantId, today, horizon) {
      const [by, soon, open] = await Promise.all([
        sql<{ key: string | null; n: number }>`select signal_type as key, count(*)::int as n from rm_watchlist_item
          where tenant_id = ${tenantId} group by 1 order by 2 desc limit 50`.execute(db),
        sql<{ n: number }>`select count(*)::int as n from rm_watchlist_item
          where tenant_id = ${tenantId} and task_open and deadline_date between ${today} and ${horizon}`.execute(db),
        sql<{ n: number }>`select count(*)::int as n from rm_watchlist_item where tenant_id = ${tenantId} and task_open`.execute(db),
      ]);
      return { bySignal: by.rows.map((x) => ({ key: x.key, n: num(x.n) })), deadlinesSoon: num(soon.rows[0]?.n), openTasks: num(open.rows[0]?.n) };
    },
    async uploads(tenantId, r) {
      const [bySource, reasons, repeats] = await Promise.all([
        sql<{ source: string | null; uploads: number; accepted: string; rejected: string; needs_review: string; last_started_at: Date | null }>`
          select source_type as source, count(*)::int as uploads, coalesce(sum(accepted), 0)::bigint as accepted,
                 coalesce(sum(rejected), 0)::bigint as rejected, coalesce(sum(needs_review), 0)::bigint as needs_review,
                 max(started_at) as last_started_at
            from rm_upload where tenant_id = ${tenantId} and ${range('started_at', r.from, r.to)}
           group by 1 order by 1 limit 50`.execute(db),
        sql<{ key: string; n: string }>`
          select e.key, sum((e.value)::bigint)::bigint as n
            from rm_upload u, jsonb_each_text(u.rejection_reasons) e
           where u.tenant_id = ${tenantId} and ${range('u.started_at', r.from, r.to)}
           group by 1 order by 2 desc limit 20`.execute(db),
        sql<{ n: string | null }>`
          select sum(s.count)::bigint as n from rm_upload u join rm_row_stat s on s.tenant_id = u.tenant_id and s.upload_id = u.id
           where u.tenant_id = ${tenantId} and ${range('u.started_at', r.from, r.to)} and s.possible_repeat`.execute(db),
      ]);
      return {
        bySource: bySource.rows.map((x) => ({
          source: x.source,
          uploads: num(x.uploads),
          accepted: num(x.accepted),
          rejected: num(x.rejected),
          needsReview: num(x.needs_review),
          lastStartedAt: x.last_started_at,
        })),
        rejectionReasons: reasons.rows.map((x) => ({ key: x.key, n: num(x.n) })),
        possibleRepeats: num(repeats.rows[0]?.n),
      };
    },
    async reviewOpenByReason(tenantId) {
      const r = await sql<{ key: string | null; n: number }>`select reason_code as key, count(*)::int as n from rm_review_item
        where tenant_id = ${tenantId} and status = 'open' group by 1 order by 2 desc limit 50`.execute(db);
      return r.rows.map((x) => ({ key: x.key, n: num(x.n) }));
    },
    async mergeCandidates(tenantId, r) {
      const res = await sql<{ key: string; n: number }>`select kind as key, count(*)::int as n from rm_merge_candidate
        where tenant_id = ${tenantId} and ${range('raised_at', r.from, r.to)} group by 1`.execute(db);
      return res.rows.map((x) => ({ key: x.key, n: num(x.n) }));
    },
    async sideDefaulted(tenantId, r) {
      const res = await sql<{ key: string | null; n: string }>`
        select coalesce(u.code, s.upload_id::text) as key, sum(s.count)::bigint as n
          from rm_upload u join rm_row_stat s on s.tenant_id = u.tenant_id and s.upload_id = u.id
         where u.tenant_id = ${tenantId} and ${range('u.started_at', r.from, r.to)} and s.review_reason_code = 'side_defaulted'
         group by 1 order by 2 desc limit 20`.execute(db);
      return res.rows.map((x) => ({ key: x.key, n: num(x.n) }));
    },
  };
}
