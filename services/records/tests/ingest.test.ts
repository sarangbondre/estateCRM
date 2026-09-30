// REC-05 ingestion of rows.classified.v1 with rows fetched from a fake intake (R-2 client port): routing by
// record_scope/side (Z-8), one offer per deal type, source ads + split children (Z-3), sightings, persons by phone,
// demand touches, desks, idempotent re-uploads by external ref + content hash, staff edits win (CR-006),
// possible_repeat_of (Z-4) and the migration map (Z-5). Synthetic rows from @11e/testing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from '@11e/testing';
import { BatchNotFoundError } from '../src/application/ports.js';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { FakeIntake, supplyRow, toIntakeRow } from './support/intake.js';

const intake = new FakeIntake();
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ intake });
});
afterAll(() => h.close());

async function ingest(tenant: string, rows: ReturnType<typeof toIntakeRow>[], opts: { migrationApplied?: boolean; uploadId?: string } = {}) {
  const uploadId = opts.uploadId ?? randomUUID();
  intake.add(uploadId, 1, rows);
  await h.deliver({
    eventType: 'rows.classified.v1',
    tenantId: tenant,
    data: { uploadId, batchNo: 1, ...(opts.migrationApplied ? { migrationApplied: true } : {}), rows: rows.map((r) => ({ rowId: r.rowId, externalRef: r.externalRef, contentHash: r.contentHash })) },
  });
  return uploadId;
}

const rows = async <T>(tenant: string, fn: (tx: Parameters<Parameters<Harness['appCtx']['uow']['run']>[1]>[0]) => Promise<T>) =>
  h.appCtx.uow.run({ tenantId: tenant, correlationId: 'test' }, fn);

describe('rows.classified.v1', () => {
  it('Sale|Lease supply row → property + two offers (Enriched, uploaded), source ad, sightings, person by phone', async () => {
    const t = await readyTenant(h);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'a1', deal_type: 'Sale|Lease', rent_monthly_inr_min: 70_000 }))]);
    const sup = await h.staff(t, 'Supply agent');
    const offers = await h.call('GET', '/v1/offers?limit=10', sup);
    expect(offers.body.items).toHaveLength(2);
    const [a, b] = offers.body.items as Record<string, unknown>[];
    expect(new Set([a?.['dealType'], b?.['dealType']])).toEqual(new Set(['Sale', 'Lease']));
    expect(a).toMatchObject({ recordStage: 'Enriched', captureMode: 'uploaded', sourceType: 'Channel', externalRef: 'a1' });
    const sale = (offers.body.items ?? []).find((o) => o['dealType'] === 'Sale');
    const lease = (offers.body.items ?? []).find((o) => o['dealType'] === 'Lease');
    expect(sale?.['salePriceInrMin']).toBe(20_000_000);
    expect(sale?.['rentMonthlyInrMin']).toBeNull();
    expect(lease?.['rentMonthlyInrMin']).toBe(70_000);
    expect((sale?.['micromarket'] as { name: string }).name).toBe('Powai');
    const ads = await h.call('GET', '/v1/source-ads', sup);
    expect(ads.body.items?.[0]).toMatchObject({ externalRef: 'a1', hasRawText: true, splitCount: 0 });
    const people = await h.call('GET', '/v1/people', sup);
    expect(people.body.items?.[0]?.['phonesMasked']).toEqual(['+91 90•••••001']);
    const created = await h.events(t, 'offer.created.v1');
    expect(created).toHaveLength(2);
    expect(created.every((e) => e.data['recordStage'] === 'Enriched' && (e.data['contactPersonIds'] as string[]).length === 1)).toBe(true);
    expect((await h.call('GET', `/v1/properties/${String(sale?.['propertyId'])}/sightings`, sup)).body.items).toHaveLength(2);
  });

  it('is idempotent per batch, per ref + content hash; changes update facts but staff edits win', async () => {
    const t = await readyTenant(h);
    const first = toIntakeRow(supplyRow({ record_id: 'b1' }));
    const uploadId = await ingest(t, [first]);
    // Same batch again (processed_events would stop it; the upload_batches ledger does too).
    await h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId, batchNo: 1, rows: [] } });
    expect(await h.events(t, 'offer.created.v1')).toHaveLength(1);
    // Re-upload, same content: sighting and times seen only.
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'b1' }))]);
    const sup = await h.staff(t, 'Supply agent');
    const [offer] = (await h.call('GET', '/v1/offers', sup)).body.items as Record<string, unknown>[];
    expect(offer?.['timesSeen']).toBe(2);
    expect(await h.events(t, 'offer.updated.v1')).toHaveLength(0);
    // Staff edits the price; the next upload changes price and furnishing: price stays, furnishing updates.
    await h.call('PATCH', `/v1/offers/${String(offer?.['id'])}`, sup, { salePriceInrMin: 19_000_000 });
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'b1', sale_price_inr_min: 25_000_000, furnishing: 'Furnished' }))]);
    const after = await h.call('GET', `/v1/offers/${String(offer?.['id'])}`, sup);
    expect(after.body['salePriceInrMin']).toBe(19_000_000);
    expect(after.body['furnishing']).toBe('Furnished');
    expect((await h.call('GET', '/v1/offers', sup)).body.items).toHaveLength(1);
  });

  it('split children share one source ad and are never dedup candidates of each other', async () => {
    const t = await readyTenant(h);
    const kid = (i: number) => toIntakeRow(supplyRow({ record_id: `s${i}`, parent_record_id: 'ad-parent', split_index: `${i} of 2`, phones: '+919000100002' }));
    await ingest(t, [kid(1), kid(2)]);
    const sup = await h.staff(t, 'Supply agent');
    const ads = await h.call('GET', '/v1/source-ads?hasSplits=true', sup);
    expect(ads.body.items).toHaveLength(1);
    expect(ads.body.items?.[0]).toMatchObject({ externalRef: 'ad-parent', splitCount: 2 });
    expect((ads.body.items?.[0]?.['children'] as unknown[]).length).toBe(2);
    expect((await h.call('GET', '/v1/merge-candidates', await h.staff(t, 'Manager'))).body.items).toHaveLength(0);
    expect((await h.call('GET', '/v1/properties', sup)).body.items).toHaveLength(2);
  });

  it('demand rows: a repeat by the same phone becomes a touch; blank side waits unrouted', async () => {
    const t = await readyTenant(h);
    const dem = (id: string) =>
      toIntakeRow(supplyRow({ record_id: id, side: 'Demand', deal_type: 'Lease', sale_price_inr_min: null, rent_monthly_inr_min: 80_000, rent_monthly_inr_max: 100_000, phones: '+919000100003' }));
    await ingest(t, [dem('d1')]);
    await ingest(t, [dem('d2'), toIntakeRow(supplyRow({ record_id: 'u1', side: null }))]);
    const m = await h.staff(t, 'Manager');
    const demands = await h.call('GET', '/v1/demands', m);
    expect(demands.body.items).toHaveLength(1);
    expect(demands.body.items?.[0]).toMatchObject({ touchCount: 2, recordStage: 'Enriched', captureMode: 'uploaded' });
    const touches = await h.events(t, 'demand.touch_added.v1');
    expect(touches.map((e) => e.data['isFirstTouch'])).toEqual([true, false]);
    const waiting = await rows(t, (tx) => tx.store.find('unrouted_rows', { status: 'waiting' }));
    expect(waiting.map((w) => w.external_ref)).toEqual(['u1']);
    expect((await h.call('GET', '/v1/offers', m)).body.items).toHaveLength(0);
  });

  it('non-property scopes go to desks (D-14 business with property also creates the offer)', async () => {
    const t = await readyTenant(h);
    await ingest(t, [
      toIntakeRow(supplyRow({ record_id: 'x1', record_scope: 'Business', includes_property: 'Yes', sector: 'Hospitality', business_description: 'Running hotel, call 9000100004' })),
      toIntakeRow(supplyRow({ record_id: 'x2', record_scope: 'Capital', deal_type: 'Debt', segment: null, property_type: null })),
      toIntakeRow(supplyRow({ record_id: 'x3', record_scope: 'Market Signal', side: 'None', signal_type: 'Auction Notice', deal_type: null, deadline_date: '2026-10-05' })),
      toIntakeRow(supplyRow({ record_id: 'x4', record_scope: 'Market Participant', side: 'None', participant_role: 'Broker', deal_type: null, phones: '+919000100005' })),
    ]);
    const types = (await h.events(t)).map((e) => e.eventType);
    expect(types.filter((x) => x === 'desk_item.created.v1')).toHaveLength(3);
    expect(types).toContain('watchlist_item.created.v1');
    expect(types.filter((x) => x === 'offer.created.v1')).toHaveLength(1);
    const items = await rows(t, (tx) => tx.store.find('desk_items', {}));
    const biz = items.find((i) => i.desk === 'business');
    expect(biz?.linked_property_id).toBeTruthy();
    expect(biz?.business_description_redacted).not.toContain('9000100004');
    expect(items.map((i) => i.desk).sort()).toEqual(['business', 'capital', 'watchlist']);
    const net = await rows(t, (tx) => tx.store.find('persons', { participant_role: 'Broker' }));
    expect(net).toHaveLength(1);
  });

  it('possible_repeat_of: pending until the target arrives, then an open candidate', async () => {
    const t = await readyTenant(h);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'r2', possible_repeat_of: 'r1', phones: '+919000100006' }))]);
    const pending = await rows(t, (tx) => tx.store.find('merge_candidates', { status: 'pending_target' }));
    expect(pending).toHaveLength(1);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'r1', phones: '+919000100007', locality: 'Vashi', city: 'Navi Mumbai' }))]);
    const open = await h.call('GET', '/v1/merge-candidates?reason=possible_repeat', await h.staff(t, 'Data operator'));
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items?.[0]).toMatchObject({ aggregateType: 'offer', status: 'open' });
    expect((await h.events(t, 'merge_candidate.raised.v1'))[0]?.data).toMatchObject({ kind: 'possible_repeat' });
  });

  it('migration map first: kept re-keys, merged merges the records (source migration_map)', async () => {
    const t = await readyTenant(h);
    await ingest(t, [
      toIntakeRow(supplyRow({ record_id: 'm-old' })),
      toIntakeRow(supplyRow({ record_id: 'm-a', phones: '+919000100008', locality: 'Juhu' })),
      toIntakeRow(supplyRow({ record_id: 'm-b', phones: '+919000100009', locality: 'Khar West' })),
    ]);
    const uploadId = randomUUID();
    intake.maps.set(uploadId, [
      { entryNo: 1, oldRef: 'm-old', newRefs: ['m-new'], action: 'kept' },
      { entryNo: 2, oldRef: 'm-a', newRefs: ['m-b'], action: 'merged' },
    ]);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'm-new' }))], { migrationApplied: true, uploadId });
    const recs = await rows(t, (tx) => tx.store.find('ingested_records', {}));
    expect(recs.find((r) => r.external_ref === 'm-new')?.status).toBe('active');
    expect(recs.find((r) => r.external_ref === 'm-old')).toBeUndefined();
    expect(recs.find((r) => r.external_ref === 'm-a')?.status).toBe('merged');
    const merged = await h.events(t, 'records.merged.v1');
    expect(merged).toHaveLength(1);
    // m-new has the same content as m-old: no new offer, only a sighting.
    expect(await h.events(t, 'offer.created.v1')).toHaveLength(3);
    const state = await rows(t, (tx) => tx.store.find('upload_migrations', { upload_id: uploadId }));
    expect(state[0]?.status).toBe('applied');
  });

  it('CR-012: the same building/locality/unit shape from another channel is the same property (second source)', async () => {
    const t = await readyTenant(h);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'bd1', building_name: 'Sea Breeze Tower', floor: '12 of 20' }))]);
    await ingest(t, [
      toIntakeRow(
        supplyRow({
          record_id: 'bd2',
          building_name: 'SEA BREEZE TOWER',
          floor: '12th',
          area_sqft_min: 910,
          source_channel: 'WhatsApp',
          contact_name: 'Other Broker',
          party_type: 'Broker',
          phones: '+919000100020',
        }),
      ),
    ]);
    const props = await rows(t, (tx) => tx.store.find('properties', {}));
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ building_name: 'Sea Breeze Tower', floor_no: 12, total_floors: 20, floor_band: 'Mid' });
    const offers = await rows(t, (tx) => tx.store.find('offers', {}));
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ second_source_count: 1, sighting_count: 2 });
    expect(await rows(t, (tx) => tx.store.find('second_sources', {}))).toHaveLength(1);
    // private: the building name and the exact floor never leave in events
    const events = await h.events(t);
    expect(events.filter((e) => e.eventType === 'offer.created.v1')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/Sea Breeze|SEA BREEZE|floorNo/);
  });

  it('CR-012: without a matching floor the same building is only a merge candidate (uncertain)', async () => {
    const t = await readyTenant(h);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: 'bu1', building_name: 'Palm Grove CHS' }))]);
    await ingest(t, [
      toIntakeRow(supplyRow({ record_id: 'bu2', building_name: 'Palm Grove', source_channel: 'WhatsApp', phones: '+919000100021' })),
    ]);
    expect(await rows(t, (tx) => tx.store.find('properties', {}))).toHaveLength(2);
    const open = await h.call('GET', '/v1/merge-candidates?reason=property_match', await h.staff(t, 'Manager'));
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items?.[0]).toMatchObject({ aggregateType: 'property', status: 'open' });
  });

  it('CR-012: rows with crm_notes emit record.note_imported.v1 (ids only), once per (upload, row)', async () => {
    const t = await readyTenant(h);
    const noted = toIntakeRow(supplyRow({ record_id: 'n1', crm_notes: 'keys with the watchman' }), 7);
    const uploadId = await ingest(t, [noted, toIntakeRow(supplyRow({ record_id: 'n2', phones: '+919000100022', locality: 'Juhu' }), 8)]);
    const [rec] = await rows(t, (tx) => tx.store.find('ingested_records', { external_ref: 'n1' }));
    let notes = await h.events(t, 'record.note_imported.v1');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.data).toEqual({ subjectType: 'offer', subjectId: rec?.primary_subject_id, uploadId, rowNo: 7 });
    expect(JSON.stringify(notes)).not.toContain('watchman');
    // the same (upload, row) applied again with changed content (another batch): no second event
    const changed = toIntakeRow(supplyRow({ record_id: 'n1', crm_notes: 'keys with the watchman', sale_price_inr_min: 21_000_000 }), 7);
    intake.add(uploadId, 2, [changed]);
    await h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId, batchNo: 2, rows: [] } });
    expect(await h.events(t, 'record.note_imported.v1')).toHaveLength(1);
    // a later upload that changes the row: a note for the updated subject; a demand row gets its own
    const later = await ingest(t, [
      toIntakeRow(supplyRow({ record_id: 'n1', crm_notes: 'keys with the watchman', sale_price_inr_min: 22_000_000 }), 3),
      toIntakeRow(
        supplyRow({ record_id: 'n3', side: 'Demand', deal_type: 'Lease', sale_price_inr_min: null, rent_monthly_inr_min: 90_000, phones: '+919000100023', crm_notes: 'wants sea view' }),
        4,
      ),
    ]);
    notes = await h.events(t, 'record.note_imported.v1');
    expect(notes.map((e) => [e.data['subjectType'], e.data['uploadId'], e.data['rowNo']])).toEqual([
      ['offer', uploadId, 7],
      ['offer', later, 3],
      ['demand', later, 4],
    ]);
  });

  it('a missing batch fails (retried, then dead-lettered by the drain)', async () => {
    const t = await readyTenant(h);
    await expect(h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId: randomUUID(), batchNo: 9, rows: [] } })).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it('loads a synthetic extractor file (@11e/testing) with valid events only', async () => {
    const t = await readyTenant(h);
    const synthetic = generate({ rows: 120, seed: 11, errorRate: 0 })
      .filter((r) => r.meta.error === null)
      .map((r, i) => toIntakeRow(r.row as Parameters<typeof toIntakeRow>[0], i + 1));
    await ingest(t, synthetic);
    const recs = await rows(t, (tx) => tx.store.find('ingested_records', {}));
    expect(recs).toHaveLength(new Set(synthetic.map((r) => r.externalRef)).size);
    const events = await h.events(t); // every payload is validated against its AsyncAPI schema
    expect(events.filter((e) => e.eventType === 'offer.created.v1').length).toBeGreaterThan(50);
    const text = JSON.stringify(events);
    for (const r of synthetic) for (const p of r.phones ?? []) expect(text).not.toContain(p.replace('+', ''));
    // CR-012 private columns stay out of events; rows with crm_notes are announced (ids only)
    for (const r of synthetic) if (r.buildingName) expect(text).not.toContain(r.buildingName);
    const notedRows = new Set(synthetic.filter((r) => r.hasCrmNotes).map((r) => r.rowNo));
    const noteEvents = events.filter((e) => e.eventType === 'record.note_imported.v1');
    expect(noteEvents.length).toBeGreaterThan(0);
    for (const e of noteEvents) expect(notedRows.has(e.data['rowNo'] as number)).toBe(true);
  });
});
