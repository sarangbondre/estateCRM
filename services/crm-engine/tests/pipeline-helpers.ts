// Event delivery and pipeline settling for integration tests (no global queue draining: other test files share it).
import { randomUUID } from 'node:crypto';
import { sql } from '@11e/db';
import type { Transaction } from '@11e/db';
import type { EventEnvelope, EventType } from '@11e/outbox';
import { eventHandlers } from '../src/adapters/events.js';
import type { CrmEngineDb } from '../src/adapters/db.js';
import { processDirtySubject } from '../src/application/pipeline.js';
import type { Harness } from './helpers.js';

export function envelopeFor<T extends EventType>(
  h: Harness,
  type: T,
  aggregateId: string,
  version: number,
  data: EventEnvelope<T>['data'],
  producer = 'records',
): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    eventType: type,
    schemaVersion: 1,
    occurredAt: h.now.value.toISOString(),
    correlationId: 'test',
    producer,
    tenantId: h.tenant,
    aggregateType: type.split('.')[0] as string,
    aggregateId,
    aggregateVersion: version,
    data,
  };
}

/** Delivers one event to its handler inside a committed transaction (as the drain does). */
export async function deliver<T extends EventType>(h: Harness, e: EventEnvelope<T>): Promise<void> {
  const handler = eventHandlers(h.deps)[e.eventType] as unknown as (
    ev: EventEnvelope<T>,
    ctx: { trx: Transaction<CrmEngineDb>; attempt: number },
  ) => Promise<void>;
  await h.tx((_s, trx) => handler(e, { trx, attempt: 1 }));
}

/** Runs the re-score pipeline for this tenant's dirty subjects until none are left. */
export async function settle(h: Harness, maxRounds = 20): Promise<number> {
  let done = 0;
  for (let round = 0; round < maxRounds; round++) {
    const pending = await h.tx((_s, trx) =>
      sql<{ subject_type: 'offer' | 'demand'; subject_id: string }>`select subject_type, subject_id
        from ${sql.table('rescore_pending')} where tenant_id = ${h.tenant}
        order by case subject_type when 'offer' then 0 else 1 end, enqueued_at limit 200`.execute(trx),
    );
    if (!pending.rows.length) return done;
    for (const p of pending.rows) {
      await h.tx((store) => processDirtySubject(store, h.deps.clock, h.tenant, p.subject_type, p.subject_id));
      done++;
    }
  }
  return done;
}

export interface OutboxRow {
  type: string;
  aggregateId: string;
  version: number;
  data: Record<string, unknown>;
}

/** Events this tenant wrote to the outbox, oldest first. */
export async function outbox(h: Harness, eventType?: string): Promise<OutboxRow[]> {
  const r = await h.tx((_s, trx) =>
    sql<{
      event_type: string;
      aggregate_id: string;
      aggregate_version: number;
      payload: { data: Record<string, unknown> };
    }>`
      select event_type, aggregate_id, aggregate_version, payload from ${sql.table('outbox')}
      where tenant_id = ${h.tenant} ${eventType ? sql`and event_type = ${eventType}` : sql``}
      order by occurred_at, aggregate_version`.execute(trx),
  );
  return r.rows.map((x) => ({
    type: x.event_type,
    aggregateId: x.aggregate_id,
    version: x.aggregate_version,
    data: x.payload.data,
  }));
}

export interface MatchRow {
  id: string;
  code: string;
  demand_id: string;
  offer_ids: string[];
  is_bundle: boolean;
  bundle_id: string | null;
  score: number;
  rank: number | null;
  flags: string[];
  status: string;
  closed_reason: string | null;
  closed_by_deal_id: string | null;
  open_deal_id: string | null;
  version: number;
}

export async function matchesOf(h: Harness, demandId: string): Promise<MatchRow[]> {
  const r = await h.tx((_s, trx) =>
    sql<MatchRow>`select id, code, demand_id, offer_ids, is_bundle, bundle_id, score, rank, flags, status, closed_reason,
        closed_by_deal_id, open_deal_id, version
      from ${sql.table('matches')} where tenant_id = ${h.tenant} and demand_id = ${demandId}
      order by score desc, id`.execute(trx),
  );
  return r.rows;
}

// --- event data builders (synthetic, PII-free) ---------------------------------------------------------------------------
export const officeFacts = (offerId: string, over: Record<string, unknown> = {}) => ({
  offerId,
  code: `INV-${offerId.slice(0, 5)}`,
  propertyId: randomUUID(),
  dealType: 'Lease',
  segment: 'Commercial',
  propertyTypes: ['Office'],
  areaSqftMin: 6000,
  areaSqftMax: 6000,
  areaBasis: 'Builtup' as const,
  rentMonthlyInrMin: 900_000,
  micromarket: 'Andheri East',
  locality: 'Marol',
  possessionStatus: 'Ready',
  ...over,
});

export const officeDemandFacts = (demandId: string, over: Record<string, unknown> = {}) => ({
  demandId,
  code: `DEM-${demandId.slice(0, 6)}`,
  dealTypes: ['Lease'],
  segment: 'Commercial',
  propertyTypes: ['Office'],
  areaSqftMin: 5000,
  areaSqftMax: 7000,
  areaBasis: 'Builtup' as const,
  rentMonthlyInrMin: 800_000,
  rentMonthlyInrMax: 1_000_000,
  micromarkets: ['Andheri East'],
  localities: ['Marol'],
  ...over,
});
