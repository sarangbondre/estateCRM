// ENG-01: the PII-free matchable projection built from events (LLD §3.2, §5.2), on the local database.
import { randomUUID } from 'node:crypto';
import { sql } from '@11e/db';
import type { EventEnvelope, EventType } from '@11e/outbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventHandlers } from '../../src/adapters/events.js';
import type { CrmEngineDb } from '../../src/adapters/db.js';
import { ProjectionGapError } from '../../src/application/projection.js';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { SOURCE } from '../unit/fixtures.js';
import type { Transaction } from '@11e/db';

let h: Harness;
let handlers: ReturnType<typeof eventHandlers>;
beforeAll(async () => {
  h = await harness();
  handlers = eventHandlers(h.deps);
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
});
afterAll(() => h.close());

function envelope<T extends EventType>(
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
    occurredAt: new Date().toISOString(),
    correlationId: 'test',
    producer,
    tenantId: h.tenant,
    aggregateType: type.split('.')[0] as string,
    aggregateId,
    aggregateVersion: version,
    data,
  };
}

async function deliver<T extends EventType>(e: EventEnvelope<T>) {
  const handler = handlers[e.eventType] as unknown as (
    ev: EventEnvelope<T>,
    ctx: { trx: Transaction<CrmEngineDb>; attempt: number },
  ) => Promise<void>;
  await h.tx((_s, trx) => handler(e, { trx, attempt: 1 }));
}

const offerFacts = (offerId: string, over: Record<string, unknown> = {}) => ({
  offerId,
  code: `INV-${offerId.slice(0, 5)}`,
  propertyId: randomUUID(),
  dealType: 'Lease',
  segment: 'Commercial',
  propertyTypes: ['Office'],
  areaSqftMin: 5000,
  areaSqftMax: 5000,
  areaBasis: 'Builtup' as const,
  rentMonthlyInrMin: 850_000,
  micromarket: 'Andheri East',
  locality: 'Marol',
  possessionStatus: 'Available From',
  possessionDate: '2027-02',
  furnishing: 'Furnished',
  contactPersonIds: [randomUUID()],
  buildingKey: 'bk-opaque-hash-1',
  ...over,
});

const row = (table: 'offer_mx' | 'demand_mx', id: string) =>
  h.tx((_s, trx) =>
    sql<Record<string, unknown>>`select * from ${sql.table(table)} where id = ${id}`
      .execute(trx)
      .then((r) => r.rows[0]),
  );

describe('offer projection', () => {
  it('offer.created.v1 → offer_mx with derived path, price key, period and candidate keys; subject marked dirty', async () => {
    const id = randomUUID();
    await deliver(envelope('offer.created.v1', id, 1, offerFacts(id)));
    const r = await row('offer_mx', id);
    expect(r).toMatchObject({
      code: `INV-${id.slice(0, 5)}`,
      deal_type: 'Lease',
      mm_path: ['loc-marol', 'mm-andheri-east'],
      zone: 'Western Suburbs',
      price_key: '850000',
      possession_date_raw: '2027-02',
      building_key: 'bk-opaque-hash-1',
      is_matchable: true,
      facts_version: 1,
      price_version: 1,
    });
    expect(r?.['match_keys']).toEqual([
      `${h.tenant}|Commercial|Lease|loc-marol`,
      `${h.tenant}|Commercial|Lease|mm-andheri-east`,
    ]);
    const pending = await h.tx((_s, trx) =>
      sql<{
        reasons: string[];
      }>`select reasons from ${sql.table('rescore_pending')} where subject_id = ${id}`.execute(trx),
    );
    expect(pending.rows[0]?.reasons).toEqual(['offer.created']);
  });

  it('ignores stale and duplicate facts; applies newer ones; a gap in the stream is applied', async () => {
    const id = randomUUID();
    await deliver(envelope('offer.created.v1', id, 1, offerFacts(id)));
    await deliver(
      envelope('offer.updated.v1', id, 5, offerFacts(id, { areaSqftMin: 5500, areaSqftMax: 5500 })),
    );
    await deliver(envelope('offer.updated.v1', id, 3, offerFacts(id, { areaSqftMin: 1, areaSqftMax: 1 })));
    const r = await row('offer_mx', id);
    expect(r).toMatchObject({ area_sqft_min: '5500', facts_version: 5 });
  });

  it('price group: an older price change never overwrites newer full facts; a newer one applies', async () => {
    const id = randomUUID();
    await deliver(envelope('offer.created.v1', id, 1, offerFacts(id)));
    await deliver(envelope('offer.updated.v1', id, 4, offerFacts(id, { rentMonthlyInrMin: 900_000 })));
    await deliver(
      envelope('offer.price_changed.v1', id, 3, {
        offerId: id,
        previous: {},
        current: { rentMonthlyInrMin: 700_000 },
      }),
    );
    expect(await row('offer_mx', id)).toMatchObject({ rent_monthly_inr_min: '900000', price_version: 4 });
    await deliver(
      envelope('offer.price_changed.v1', id, 6, {
        offerId: id,
        previous: { rentMonthlyInrMin: 900_000 },
        current: { rentMonthlyInrMin: 950_000, unitCount: 3 },
      }),
    );
    expect(await row('offer_mx', id)).toMatchObject({
      rent_monthly_inr_min: '950000',
      price_key: '950000',
      unit_count: 3,
      price_version: 6,
    });
    // later full facts with an older version than the price group keep the newer price
    await deliver(
      envelope('offer.updated.v1', id, 5, offerFacts(id, { rentMonthlyInrMin: 1, locality: 'Chakala' })),
    );
    expect(await row('offer_mx', id)).toMatchObject({
      rent_monthly_inr_min: '950000',
      locality: 'Chakala',
      facts_version: 5,
    });
  });

  it('journeys axes use their own versions and survive out-of-order delivery', async () => {
    const id = randomUUID();
    await deliver(envelope('offer.created.v1', id, 1, offerFacts(id)));
    await deliver(
      envelope(
        'lifecycle.stage_changed.v1',
        id,
        3,
        { subjectType: 'offer', subjectId: id, from: 'Ageing', to: 'Stale', day: 61 },
        'journeys',
      ),
    );
    await deliver(
      envelope(
        'lifecycle.stage_changed.v1',
        id,
        2,
        { subjectType: 'offer', subjectId: id, from: 'Fresh', to: 'Ageing', day: 31 },
        'journeys',
      ),
    );
    expect(await row('offer_mx', id)).toMatchObject({
      life_stage: 'Stale',
      life_version: 3,
      is_matchable: true,
    });
    await deliver(
      envelope(
        'lifecycle.stage_changed.v1',
        id,
        4,
        { subjectType: 'offer', subjectId: id, from: 'Stale', to: 'Expired', day: 91 },
        'journeys',
      ),
    );
    expect(await row('offer_mx', id)).toMatchObject({ life_stage: 'Expired', is_matchable: false });
    await deliver(
      envelope(
        'offer.confirmed.v1',
        id,
        5,
        { offerId: id, confirmedAt: new Date().toISOString(), how: 'call' },
        'journeys',
      ),
    );
    expect(await row('offer_mx', id)).toMatchObject({ life_stage: 'Fresh', is_matchable: true });
    await deliver(
      envelope(
        'offer.commercial_status_changed.v1',
        id,
        6,
        { offerId: id, from: 'Available', to: 'Closed' },
        'journeys',
      ),
    );
    expect(await row('offer_mx', id)).toMatchObject({
      commercial_status: 'Closed',
      commercial_version: 6,
      is_matchable: false,
    });
    // records facts after journeys changes keep the journeys-owned groups
    await deliver(envelope('offer.updated.v1', id, 2, offerFacts(id)));
    expect(await row('offer_mx', id)).toMatchObject({ life_stage: 'Fresh', commercial_status: 'Closed' });
  });

  it('offer.retired.v1 makes the offer Inactive; offer.voided.v1 voids it', async () => {
    const id = randomUUID();
    await deliver(envelope('offer.created.v1', id, 1, offerFacts(id)));
    await deliver(envelope('offer.retired.v1', id, 2, { offerId: id, reason: 'already_gone' }, 'journeys'));
    expect(await row('offer_mx', id)).toMatchObject({ commercial_status: 'Inactive', is_matchable: false });
    const v = randomUUID();
    await deliver(envelope('offer.created.v1', v, 1, offerFacts(v)));
    await deliver(envelope('offer.voided.v1', v, 2, { offerId: v, reason: 'side_changed' }));
    expect(await row('offer_mx', v)).toMatchObject({ voided: true, is_matchable: false });
  });

  it('a journeys event for an offer not projected yet is retried (projection gap)', async () => {
    const id = randomUUID();
    await expect(
      deliver(
        envelope(
          'lifecycle.stage_changed.v1',
          id,
          2,
          { subjectType: 'offer', subjectId: id, from: 'Fresh', to: 'Ageing', day: 31 },
          'journeys',
        ),
      ),
    ).rejects.toBeInstanceOf(ProjectionGapError);
  });

  it('price_sheet.applied.v1 stamps the sheet date on changed offers', async () => {
    const id = randomUUID();
    await deliver(
      envelope(
        'offer.created.v1',
        id,
        1,
        offerFacts(id, {
          dealType: 'Sale',
          market: 'Primary',
          salePriceInrMin: 24_000_000,
          rentMonthlyInrMin: undefined,
        }),
      ),
    );
    await deliver(
      envelope('price_sheet.applied.v1', randomUUID(), 1, {
        projectId: randomUUID(),
        priceSheetId: randomUUID(),
        sheetDate: '2026-09-30',
        changedOfferIds: [id],
      }),
    );
    const r = await row('offer_mx', id);
    expect(r?.['price_sheet_date']).toBeInstanceOf(Date);
    expect(r?.['price_key']).toBe('24000000');
  });
});

describe('demand projection', () => {
  const demandFacts = (demandId: string, over: Record<string, unknown> = {}) => ({
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
    moveInBy: '2026-12-01',
    moveInFrom: '2026-10-15',
    statedTags: { furnishing: 'Furnished' },
    contactPersonIds: [randomUUID()],
    ...over,
  });

  it('demand.created.v1 → demand_mx with the expanded micromarkets and candidate keys', async () => {
    const id = randomUUID();
    await deliver(envelope('demand.created.v1', id, 1, demandFacts(id)));
    const r = await row('demand_mx', id);
    expect(r).toMatchObject({
      is_matchable: true,
      accepts_new: true,
      stated_tags: { furnishing: 'Furnished' },
    });
    expect(r?.['mm_expanded']).toEqual([
      'loc-chakala',
      'loc-marol',
      'loc-midc',
      'loc-saki-naka',
      'mm-andheri-east',
      'sub-marol-naka',
    ]);
    expect((r?.['match_keys'] as string[]).length).toBe(6);
  });

  it('status group: exited, reactivated, Closed; life stage Stale stops new suggestions', async () => {
    const id = randomUUID();
    await deliver(envelope('demand.created.v1', id, 1, demandFacts(id)));
    await deliver(
      envelope(
        'lifecycle.stage_changed.v1',
        id,
        2,
        { subjectType: 'demand', subjectId: id, from: 'Ageing', to: 'Stale', day: 61 },
        'journeys',
      ),
    );
    expect(await row('demand_mx', id)).toMatchObject({ is_matchable: true, accepts_new: false });
    await deliver(
      envelope(
        'demand.exited.v1',
        id,
        3,
        { demandId: id, exit: 'Lost', competingTerms: 'Powai, 2 months rent free' },
        'journeys',
      ),
    );
    expect(await row('demand_mx', id)).toMatchObject({ exit_type: 'Lost', is_matchable: false });
    await deliver(envelope('demand.reactivated.v1', id, 4, { demandId: id }, 'journeys'));
    expect(await row('demand_mx', id)).toMatchObject({ exit_type: null });
    await deliver(
      envelope(
        'demand.status_changed.v1',
        id,
        5,
        { demandId: id, from: 'In process', to: 'Closed' },
        'journeys',
      ),
    );
    expect(await row('demand_mx', id)).toMatchObject({ commercial_status: 'Closed', is_matchable: false });
  });
});

describe('reference data', () => {
  it('micromarkets.updated.v1 records the requested version and queues micromarket-refresh', async () => {
    await deliver(envelope('micromarkets.updated.v1', randomUUID(), 7, { version: 7 }));
    const r = await h.tx((_s, trx) =>
      sql<{
        mm_requested_version: number;
      }>`select mm_requested_version from ${sql.table('reference_state')} where tenant_id = ${h.tenant}`.execute(
        trx,
      ),
    );
    expect(r.rows[0]?.mm_requested_version).toBe(7);
  });
  it('vocabulary.released.v1 caches the release', async () => {
    await deliver(envelope('vocabulary.released.v1', randomUUID(), 1, { version: 'v0.6', checksum: 'abc' }));
    const r = await h.tx((_s, trx) =>
      sql<{
        version: string;
        active: boolean;
      }>`select version, active from ${sql.table('vocabulary_cache')} where tenant_id = ${h.tenant}`.execute(
        trx,
      ),
    );
    expect(r.rows).toEqual([{ version: 'v0.6', active: true }]);
  });
});

describe('PII-free by design (LLD §7, conventions §9)', () => {
  // conventions §9 PII inventory + LLD §7 exclusions (names, contacts, free text, building / unit details)
  const DENY_EXACT = new Set([
    'name',
    'contact_name',
    'sender_name',
    'display_name',
    'company_name',
    'building_name',
    'society_name',
    'other_contact',
    'raw_text',
    'text_variants',
    'note',
    'notes',
    'description',
    'comment',
    'comments',
    'unit',
    'unit_no',
    'unit_number',
    'wing',
    'floor',
    'floor_no',
    'exact_floor',
    'address',
    'street',
    'contact_person_ids',
    'person_id',
    'person_ids',
    'competing_terms',
    'free_text',
  ]);
  const DENY_PART = /(phone|email|whatsapp)/;
  const isPii = (c: string) => DENY_EXACT.has(c) || DENY_PART.test(c);
  it('no column of the crm_engine schema is on the PII deny-list', async () => {
    const cols = await h.tx((_s, trx) =>
      sql<{
        table_name: string;
        column_name: string;
      }>`select table_name, column_name from information_schema.columns
        where table_schema = 'crm_engine' order by table_name, column_name`.execute(trx),
    );
    const offenders = cols.rows
      .filter((c) => isPii(c.column_name))
      // reference data: micromarket place names are not personal data; job_leases.name is the job name
      .filter((c) => !(c.table_name === 'micromarket_nodes' && c.column_name === 'name'))
      .filter((c) => !(c.table_name === 'job_leases' && c.column_name === 'name'))
      .filter((c) => !(c.table_name === 'schema_migrations' && c.column_name === 'name'));
    expect(offenders).toEqual([]);
    const tables = new Set(cols.rows.map((c) => c.table_name));
    expect(tables.has('offer_mx') && tables.has('demand_mx')).toBe(true);
  });

  it('contact person ids from the facts are never stored', async () => {
    const id = randomUUID();
    const contact = randomUUID();
    await deliver(envelope('offer.created.v1', id, 1, offerFacts(id, { contactPersonIds: [contact] })));
    const r = await row('offer_mx', id);
    expect(JSON.stringify(r)).not.toContain(contact);
  });
});
