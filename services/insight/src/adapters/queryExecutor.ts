// SQL compiler + executor (LLD §4.1 step 5): a validated plan → parameterised SQL over the template's column
// allow-list. Column expressions come only from the catalogue (constants); every value is a bound parameter; the
// tenant predicate is always first; statement_timeout 1.5 s. Lists: keyset cursor on (sort column, id) + a capped
// count (count(*) over LIMIT 10001).
import { sql } from 'kysely';
import type { Kysely, RawBuilder } from 'kysely';
import { withTransaction } from '@11e/db';
import { HttpError, decodeCursor, encodeCursor } from '@11e/http';
import type { ExecOptions, ExecResult, QueryExecutor } from '../application/ports.js';
import { addDays, istMidnight } from '../domain/dates.js';
import { ACTIVE_OFFER_STATUSES, DEMAND_LABEL_INPUTS, OFFER_LABEL_INPUTS } from '../domain/plans/catalogue.js';
import type { ResolvedFilter, ValidatedPlan } from '../domain/plans/validator.js';
import type { InsightDb } from './db.js';

export const COUNT_CAP = 10_000;
const STATEMENT_TIMEOUT_MS = 1_500;
const DAY_MS = 86_400_000;

/** Supply that can still meet demand (the gap's supply side). */
export const GAP_SUPPLY_STATUSES = ACTIVE_OFFER_STATUSES.filter((s) => s !== 'In process');

const col = (c: string) => sql.raw(c);
const arr = (values: unknown[]) => sql`${values}::text[]`;

function datetimeBound(v: unknown, end: boolean): Date | string {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return istMidnight(end ? addDays(s, 1) : s);
  return s;
}

function scalarCond(c: RawBuilder<unknown>, f: ResolvedFilter): RawBuilder<unknown> {
  const t = f.spec.type;
  const v = f.value;
  if (t === 'datetime') {
    switch (f.op) {
      case 'gte':
        return sql`${c} >= ${datetimeBound(v, false)}`;
      case 'lte':
        return sql`${c} < ${datetimeBound(v, true)}`;
      case 'between': {
        const [a, b] = v as unknown[];
        return sql`${c} >= ${datetimeBound(a, false)} and ${c} < ${datetimeBound(b, true)}`;
      }
      default:
        break;
    }
  }
  switch (f.op) {
    case 'eq':
      return sql`${c} = ${v}`;
    case 'in':
      return sql`${c} = any(${v as unknown[]})`;
    case 'gte':
      return sql`${c} >= ${v}`;
    case 'lte':
      return sql`${c} <= ${v}`;
    case 'between': {
      const [a, b] = v as unknown[];
      return sql`${c} between ${a} and ${b}`;
    }
    case 'is_null':
      return sql`${c} is null`;
    case 'not_null':
      return sql`${c} is not null`;
  }
}

export function filterCond(f: ResolvedFilter, now: Date): RawBuilder<unknown> {
  const s = f.spec;
  switch (s.shape) {
    case 'scalar':
      return scalarCond(col(s.column ?? ''), f);
    case 'array': {
      const c = col(s.column ?? '');
      if (f.op === 'eq') return sql`${c} @> ${arr([f.value])}`;
      if (f.op === 'in') return sql`${c} && ${arr(f.value as unknown[])}`;
      return scalarCond(c, f);
    }
    case 'range': {
      const lo = sql`coalesce(${col(s.min ?? '')}, ${col(s.max ?? '')})`;
      const hi = sql`coalesce(${col(s.max ?? '')}, ${col(s.min ?? '')})`;
      switch (f.op) {
        case 'eq':
          return sql`${lo} <= ${f.value} and ${hi} >= ${f.value}`;
        case 'gte':
          return sql`${hi} >= ${f.value}`;
        case 'lte':
          return sql`${lo} <= ${f.value}`;
        case 'between': {
          const [a, b] = f.value as unknown[];
          return sql`${hi} >= ${a} and ${lo} <= ${b}`;
        }
        case 'is_null':
          return sql`${lo} is null`;
        default:
          return sql`${lo} is not null`;
      }
    }
    case 'location': {
      const mm = col(s.column ?? '');
      const loc = col(s.localityColumn ?? '');
      const values = f.op === 'in' ? (f.value as unknown[]) : [f.value];
      if (s.arrays) return sql`(${mm} && ${arr(values)} or ${loc} && ${arr(values)})`;
      return sql`(${mm} = any(${values}) or ${loc} = any(${values}))`;
    }
    case 'days_since': {
      const c = col(s.column ?? '');
      const cutoff = new Date(now.getTime() - Number(f.value) * DAY_MS);
      return f.op === 'gte' ? sql`${c} <= ${cutoff}` : sql`${c} >= ${cutoff}`;
    }
  }
}

function fromClause(v: ValidatedPlan, tenantId: string): RawBuilder<unknown> {
  switch (v.template.base) {
    case 'offer':
      return sql`rm_offer b where b.tenant_id = ${tenantId} and b.code is not null and b.void_reason is null and b.merged_into_id is null`;
    case 'demand':
      return sql`rm_demand b where b.tenant_id = ${tenantId} and b.code is not null and b.void_reason is null and b.merged_into_id is null`;
    case 'match':
      return sql`rm_match b left join rm_demand d on d.tenant_id = b.tenant_id and d.id = b.demand_id where b.tenant_id = ${tenantId}`;
    case 'deal':
      return sql`rm_deal b where b.tenant_id = ${tenantId}`;
    case 'market_price':
      return sql`rm_market_price b where b.tenant_id = ${tenantId} and not b.void`;
    case 'daily_fact':
      return sql`rm_daily_fact b where b.tenant_id = ${tenantId}`;
    case 'upload':
      return sql`rm_upload b where b.tenant_id = ${tenantId}`;
    default:
      throw new Error(`base ${v.template.base} has no table`);
  }
}

function whereParts(v: ValidatedPlan, now: Date): RawBuilder<unknown>[] {
  const parts = v.filters.map((f) => filterCond(f, now));
  if (v.period) {
    const c = col(v.period.column);
    if (v.period.type === 'date') parts.push(sql`${c} between ${v.period.range.from} and ${v.period.range.to}`);
    else parts.push(sql`${c} >= ${istMidnight(v.period.range.from)} and ${c} < ${istMidnight(addDays(v.period.range.to, 1))}`);
  }
  if (v.me && v.template.meColumn) parts.push(sql`${col(v.template.meColumn)} = ${v.me}`);
  return parts;
}

const and = (parts: RawBuilder<unknown>[]) => (parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``);

export const metricKey = (key: string) => key.replace(':', '_');

function metricExpr(m: ValidatedPlan['metrics'][number]): RawBuilder<unknown> {
  if (m.fn === 'count' || !m.column) return sql`count(*)::bigint`;
  const c = col(m.column);
  switch (m.fn) {
    case 'avg':
      return sql`round(avg(${c}))::bigint`;
    case 'median':
      return sql`round(percentile_cont(0.5) within group (order by ${c}))::bigint`;
    case 'min':
      return sql`min(${c})`;
    case 'max':
      return sql`max(${c})`;
    default:
      return sql`sum(${c})`;
  }
}

const toJson = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
const clean = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toJson(v)]));

export function createQueryExecutor(db: Kysely<InsightDb>): QueryExecutor {
  const run = <T>(fn: (trx: Kysely<InsightDb>) => Promise<T>) =>
    withTransaction(db, (trx) => fn(trx as unknown as Kysely<InsightDb>), { statementTimeoutMs: STATEMENT_TIMEOUT_MS, retries: 0 }).catch(
      (err: unknown) => {
        if ((err as { code?: string }).code === '57014')
          throw new HttpError(503, 'query-timeout', { detail: 'the query took longer than 1.5 s' });
        throw err;
      },
    );

  async function cappedCount(trx: Kysely<InsightDb>, v: ValidatedPlan, tenantId: string, now: Date) {
    const r = await sql<{ n: number }>`select count(*)::int as n from (select 1 from ${fromClause(v, tenantId)}${and(
      whereParts(v, now),
    )} limit ${COUNT_CAP + 1}) x`.execute(trx);
    return Number(r.rows[0]?.n ?? 0);
  }

  return {
    async execute(tenantId, v, opts: ExecOptions): Promise<ExecResult> {
      const now = opts.now;
      return run(async (trx) => {
        const kind = v.template.kind;
        if (v.template.base === 'gap') return gap(trx, tenantId, v);
        if (kind === 'count') {
          const n = await cappedCount(trx, v, tenantId, now);
          return { rows: [{ count: Math.min(n, COUNT_CAP) }], total: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP, nextCursor: null };
        }
        if (kind === 'group' || kind === 'stats') {
          const groups = v.groupBy.map((g, i) => sql`${col(g.column)} as ${sql.ref(`g${i}`)}`);
          const metrics = v.metrics.map((m) => sql`${metricExpr(m)} as ${sql.ref(metricKey(m.key))}`);
          const select = sql.join([...groups, ...metrics]);
          const groupClause = groups.length ? sql` group by ${sql.join(v.groupBy.map((_, i) => sql.raw(String(i + 1))))}` : sql``;
          const first = v.metrics[0];
          const order = first && groups.length ? sql` order by ${sql.ref(metricKey(first.key))} desc nulls last` : sql``;
          const limit = Math.min(v.template.maxRows, opts.limit ?? v.template.maxRows);
          const r = await sql<Record<string, unknown>>`select ${select} from ${fromClause(v, tenantId)}${and(
            whereParts(v, now),
          )}${groupClause}${order} limit ${limit}`.execute(trx);
          const rows = r.rows.map((row) => {
            const out: Record<string, unknown> = {};
            v.groupBy.forEach((g, i) => (out[g.key] = toJson(row[`g${i}`])));
            for (const m of v.metrics) out[metricKey(m.key)] = row[metricKey(m.key)] === null ? null : Number(row[metricKey(m.key)]);
            return out;
          });
          return { rows, total: rows.length, capped: false, nextCursor: null };
        }
        // list
        const limit = Math.min(opts.limit ?? 25, v.template.maxRows);
        const sort = v.sort[0];
        const sortCol = sort ? col(sort.column) : sql`b.id`;
        const dir = sort?.dir ?? 'desc';
        const cursor = decodeCursor<{ s: unknown; id: string }>(opts.cursor ?? undefined);
        const parts = whereParts(v, now);
        if (cursor) {
          if (typeof cursor.id !== 'string') throw new HttpError(400, 'invalid-cursor');
          const cmp = dir === 'desc' ? sql`<` : sql`>`;
          parts.push(
            cursor.s === null || cursor.s === undefined
              ? sql`(${sortCol} is null and b.id ${cmp} ${cursor.id})`
              : sql`(${sortCol} ${cmp} ${cursor.s} or (${sortCol} = ${cursor.s} and b.id ${cmp} ${cursor.id}) or ${sortCol} is null)`,
          );
        }
        const labels = v.template.base === 'offer' ? OFFER_LABEL_INPUTS : v.template.base === 'demand' ? DEMAND_LABEL_INPUTS : null;
        const cols = v.template.columns.filter((c) => c.column).map((c) => sql`${col(c.column ?? '')} as ${sql.ref(c.key)}`);
        if (labels)
          cols.push(sql`${col(labels.dealType)} as "_deal_type"`, sql`${col(labels.market)} as "_market"`, sql`${col(labels.segment)} as "_segment"`);
        cols.push(sql`b.id as "_id"`, sql`${sortCol} as "_sort"`);
        const dirSql = sql.raw(dir);
        const r = await sql<Record<string, unknown>>`select ${sql.join(cols)} from ${fromClause(v, tenantId)}${and(parts)}
          order by ${sortCol} ${dirSql} nulls last, b.id ${dirSql} limit ${limit + 1}`.execute(trx);
        const page = r.rows.slice(0, limit);
        const last = page[page.length - 1];
        const nextCursor = r.rows.length > limit && last ? encodeCursor({ s: toJson(last['_sort']) ?? null, id: last['_id'] }) : null;
        const total = opts.withTotal ? await cappedCount(trx, v, tenantId, now) : null;
        return {
          rows: page.map((row) => clean(row)),
          total: total === null ? null : Math.min(total, COUNT_CAP),
          capped: total !== null && total > COUNT_CAP,
          nextCursor,
        };
      });
    },
  };
}

/** supply_demand_gap: open demand vs matching supply per micromarket, from the rollups. */
async function gap(trx: Kysely<InsightDb>, tenantId: string, v: ValidatedPlan): Promise<ExecResult> {
  const offerParts: RawBuilder<unknown>[] = [];
  const demandParts: RawBuilder<unknown>[] = [];
  for (const f of v.filters) {
    const c = f.spec.column ?? '';
    offerParts.push(scalarCond(col(c), f));
    demandParts.push(scalarCond(col(c === 'deal_type' ? 'deal_type_primary' : c), f));
  }
  const r = await sql<{ micromarket: string | null; open_demand: number; supply: number }>`
    with dem as (
      select coalesce(micromarket, '') as micromarket, sum(n)::bigint as n from rm_demand_rollup
       where tenant_id = ${tenantId} and exit_type is null and commercial_status is distinct from 'Closed'${and(demandParts)}
       group by 1),
    sup as (
      select coalesce(micromarket, '') as micromarket, sum(n)::bigint as n from rm_offer_rollup
       where tenant_id = ${tenantId} and commercial_status = any(${GAP_SUPPLY_STATUSES})${and(offerParts)}
       group by 1)
    select coalesce(dem.micromarket, sup.micromarket) as micromarket,
           coalesce(dem.n, 0)::int as open_demand, coalesce(sup.n, 0)::int as supply
      from dem full join sup on dem.micromarket = sup.micromarket
     where coalesce(dem.n, 0) > coalesce(sup.n, 0)
     order by coalesce(dem.n, 0) - coalesce(sup.n, 0) desc, 1
     limit ${v.template.maxRows}`.execute(trx);
  const rows = r.rows.map((x) => ({ micromarket: x.micromarket || null, open_demand: x.open_demand, supply: x.supply, gap: x.open_demand - x.supply }));
  return { rows, total: rows.length, capped: false, nextCursor: null };
}
