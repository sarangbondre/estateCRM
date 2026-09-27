// rollup-reconcile (LLD §3.2): recompute one tenant's rollup counters from the base tables in one transaction.
// The dims_hash expression matches readModelStore.dimsHash (fixed column order, '∅' for null, U+001F separator).
import { sql } from 'kysely';
import type { Kysely, RawBuilder } from 'kysely';
import { withTransaction } from '@11e/db';
import { DEMAND_DIMS, OFFER_DIMS } from '../domain/readmodel/rollupKeys.js';
import type { InsightDb } from './db.js';

const hashOf = (cols: RawBuilder<unknown>[]) =>
  sql`md5(concat_ws(E'\\x1f', ${sql.join(cols.map((c) => sql`coalesce((${c})::text, '∅')`))}))`;

export async function reconcileRollups(db: Kysely<InsightDb>, tenantId: string): Promise<{ offers: number; demands: number }> {
  return withTransaction(
    db,
    async (trx) => {
      const offerCols = OFFER_DIMS.map((c) => sql.ref(c));
      await sql`delete from rm_offer_rollup where tenant_id = ${tenantId}`.execute(trx);
      const offers = await sql`
        insert into rm_offer_rollup (tenant_id, dims_hash, ${sql.join(OFFER_DIMS.map((c) => sql.ref(c)))}, n)
        select ${tenantId}::uuid, ${hashOf(offerCols)}, ${sql.join(offerCols)}, count(*)
          from rm_offer
         where tenant_id = ${tenantId} and code is not null and void_reason is null and merged_into_id is null
         group by ${sql.join(offerCols)}`.execute(trx);

      const demandExpr = DEMAND_DIMS.map((c) => (c === 'micromarket' ? sql`micromarkets[1]` : sql.ref(c)));
      await sql`delete from rm_demand_rollup where tenant_id = ${tenantId}`.execute(trx);
      const demands = await sql`
        insert into rm_demand_rollup (tenant_id, dims_hash, ${sql.join(DEMAND_DIMS.map((c) => sql.ref(c)))}, n)
        select ${tenantId}::uuid, ${hashOf(demandExpr)}, ${sql.join(demandExpr)}, count(*)
          from rm_demand
         where tenant_id = ${tenantId} and code is not null and void_reason is null and merged_into_id is null
         group by ${sql.join(demandExpr)}`.execute(trx);
      return { offers: Number(offers.numAffectedRows ?? 0), demands: Number(demands.numAffectedRows ?? 0) };
    },
    { statementTimeoutMs: 50_000, retries: 0 },
  );
}
