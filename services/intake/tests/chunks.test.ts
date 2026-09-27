// INT-05: chunk worker on the local DB: strict validation of a synthetic extractor file against its manifest, raw
// rows / row errors / review items, rows.classified.v1 batches without PII, unchanged detection on re-upload,
// mapping-mode translation, lease semantics (redelivery, semaphore, give-up after 5 attempts) and the
// vocabulary.released.v1 consumer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseContent } from '@11e/vocabulary';
import { findPhoneLikeNumbers, isSyntheticPhone } from '@11e/testing';
import { processChunk } from '../src/application/chunk.js';
import { applyVocabularyRelease, releaseChecksum } from '../src/application/vocabulary.js';
import type { ReleaseSource } from '../src/application/vocabulary.js';
import { repositories } from '../src/adapters/uow.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { csv, synthFile } from './support/files.js';
import { processAll, uploadAndSplit } from './support/flows.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    localities: {
      resolver: () =>
        Promise.resolve((n: string) => (n.toLowerCase() === 'andheri w' ? 'Andheri West' : undefined)),
    },
  });
});
afterAll(() => h.close());

const upload = async (t: string, id: string) =>
  (await h.call('GET', `/v1/uploads/${id}`, await h.staff(t))).body;

describe('strict mode chunk processing', () => {
  it('matches the synthetic manifest: accepted, rejected per code, needs review; events carry no PII', async () => {
    const t = newTenant();
    const { bytes, manifest } = await synthFile({
      rows: 1_200,
      seed: 31,
      errorRate: 0.04,
      invalidPhoneRate: 0.02,
    });
    const u = await uploadAndSplit(h, t, bytes);
    await processAll(h, t, u.id);
    const up = await upload(t, u.id);
    expect(up['counts']).toMatchObject({
      read: 1_200,
      accepted: manifest.totals.loaded,
      rejected: manifest.totals.rejected,
      needsReview: manifest.totals.needsReview,
      unchanged: 0,
    });
    expect(up['chunksDone']).toBe(3);
    expect(await h.app.uow.repos.rowErrors.rejectionReasons(t, u.id)).toEqual(
      Object.fromEntries(Object.entries(manifest.errors).filter(([, n]) => n > 0)),
    );
    const warnings = await h.call(
      'GET',
      `/v1/uploads/${u.id}/row-errors?code=invalid-phone&limit=100`,
      u.headers,
    );
    expect(warnings.body.items?.length).toBe(manifest.warnings['invalid-phone']);
    expect(warnings.body.items?.every((e) => e['value'] === null)).toBe(true);

    const batches = await h.events(t, 'rows.classified.v1');
    expect(batches.map((b) => b.data['batchNo'])).toEqual([1, 2, 3]);
    const rows = batches.flatMap((b) => b.data['rows'] as Record<string, unknown>[]);
    expect(rows).toHaveLength(manifest.totals.loaded);
    expect(batches.every((b) => b.aggregateType === 'upload_batch' && b.aggregateVersion === 1)).toBe(true);
    const payload = JSON.stringify(batches.map((b) => b.data));
    expect(findPhoneLikeNumbers(payload).filter((p) => isSyntheticPhone(p))).toEqual([]);
    expect(payload).not.toMatch(/@example\.(com|in)/);
    expect(rows.filter((r) => r['needsReview']).length).toBe(manifest.totals.needsReview);

    const created = await h.events(t, 'review_item.created.v1');
    expect(created).toHaveLength(manifest.totals.needsReview);
    const items = await h.db
      .selectFrom('review_items')
      .select(['reason_code', 'context'])
      .where('upload_id', '=', u.id)
      .execute();
    expect(items.length).toBe(manifest.totals.needsReview);
    expect(new Set(items.map((i) => i.reason_code))).toContain('side_defaulted');
  });

  it('re-uploading the same master emits nothing: every row is unchanged (idempotent upsert, US-07a)', async () => {
    const t = newTenant();
    const { bytes, manifest } = await synthFile({ rows: 600, seed: 32 });
    const first = await uploadAndSplit(h, t, bytes);
    await processAll(h, t, first.id);
    const before = (await h.events(t, 'rows.classified.v1')).length;
    const second = await uploadAndSplit(h, t, bytes);
    await processAll(h, t, second.id);
    const up = await upload(t, second.id);
    expect(up['counts']).toMatchObject({ accepted: 0, unchanged: manifest.totals.loaded });
    expect((await h.events(t, 'rows.classified.v1')).length).toBe(before);
  });

  it('is safe to redeliver: a done chunk is not processed twice', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 50, seed: 33 });
    const u = await uploadAndSplit(h, t, bytes);
    await processAll(h, t, u.id);
    await processChunk(h.app, { tenantId: t, uploadId: u.id, chunkNo: 1, correlationId: 'again' });
    expect((await upload(t, u.id))['chunksDone']).toBe(1);
    expect(await h.events(t, 'rows.classified.v1')).toHaveLength(1);
  });

  it('leaves the chunk queued when the tenant semaphore is full', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 20, seed: 34 });
    const u = await uploadAndSplit(h, t, bytes);
    const saved = h.app.policy.chunkConcurrency;
    h.app.policy.chunkConcurrency = 0;
    try {
      await processChunk(h.app, { tenantId: t, uploadId: u.id, chunkNo: 1, correlationId: 'x' });
    } finally {
      h.app.policy.chunkConcurrency = saved;
    }
    const c = await h.db
      .selectFrom('upload_chunks')
      .select(['status', 'attempts'])
      .where('upload_id', '=', u.id)
      .executeTakeFirst();
    expect(c).toEqual({ status: 'queued', attempts: 0 });
  });

  it('fails a chunk after 5 attempts, counts it and still reaches finalize', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 20, seed: 35 });
    const u = await uploadAndSplit(h, t, bytes);
    const path = `intake-uploads/${t}/${u.id}/chunks/1.ndjson`;
    await h.files.remove([path]);
    for (let i = 1; i <= 4; i++) {
      await expect(
        processChunk(h.app, { tenantId: t, uploadId: u.id, chunkNo: 1, correlationId: 'x' }),
      ).rejects.toThrow();
    }
    await processChunk(h.app, { tenantId: t, uploadId: u.id, chunkNo: 1, correlationId: 'x' });
    const c = await h.db
      .selectFrom('upload_chunks')
      .select(['status', 'attempts'])
      .where('upload_id', '=', u.id)
      .executeTakeFirst();
    expect(c).toEqual({ status: 'failed', attempts: 5 });
    expect((await upload(t, u.id))['counts']).toMatchObject({ accepted: 0 });
    const up = await h.db
      .selectFrom('uploads')
      .select('chunks_failed')
      .where('id', '=', u.id)
      .executeTakeFirst();
    expect(up?.chunks_failed).toBe(1);
  });
});

describe('mapping mode chunk processing', () => {
  it('translates, normalises localities, derives refs from external_id, rejects duplicates, reviews leftovers', async () => {
    const t = newTenant();
    const bytes = csv([
      ['Lead ID', 'Name', 'Mobile', 'Type', 'Deal', 'Area', 'Requirement'],
      ['L-1', 'Test One', '9000011111', '2BHK Flat', 'Resale', 'Andheri W', 'available, 1.2 Cr'],
      ['L-2', 'Test Two', '9000022222', 'Office', 'Rent Out', 'Powai', 'required urgently'],
      ['L-3', 'Test Three', '9000033333', '', 'Barter', '', 'nice place'],
      ['L-1', 'Test One', '9000011111', '2BHK Flat', 'Resale', 'Andheri W', 'available, 1.2 Cr'],
    ]);
    const u = await uploadAndSplit(h, t, bytes, {
      fileName: 'digi.csv',
      contentType: 'text/csv',
      sourceType: 'Direct',
      mapping: {
        columnMap: {
          'Lead ID': 'external_id',
          Name: 'contact_name',
          Mobile: 'phones',
          Type: 'property_type',
          Deal: 'deal_type',
          Area: 'locality',
          Requirement: 'free_text',
        },
      },
    });
    await processAll(h, t, u.id);
    expect((await upload(t, u.id))['counts']).toMatchObject({
      read: 4,
      accepted: 3,
      rejected: 1,
      needsReview: 1,
    });
    const raw = await h.db
      .selectFrom('raw_rows')
      .select([
        'row_no',
        'external_source',
        'external_ref',
        'outcome',
        'normalised',
        'primary_reason_code',
        'reason_codes',
      ])
      .where('upload_id', '=', u.id)
      .orderBy('row_no')
      .execute();
    expect(raw.map((r) => [r.row_no, r.outcome, r.external_ref])).toEqual([
      [1, 'accepted', 'direct::L-1'],
      [2, 'accepted', 'direct::L-2'],
      [3, 'accepted', 'direct::L-3'],
      [4, 'rejected', 'direct::L-1'],
    ]);
    expect(raw[0]?.normalised).toMatchObject({
      recordScope: 'Property',
      dealTypes: ['Sale'],
      market: 'Secondary',
      propertyTypes: ['Apartment'],
      bhkMin: 2,
      side: 'Supply',
      locality: 'Andheri West',
      phones: [expect.stringMatching(/^\+9100000\d{6}$/)], // pilot: anonymised at split
      salePriceInrMin: 12_000_000,
    });
    expect(raw[1]?.normalised).toMatchObject({
      dealTypes: ['Lease'],
      propertyTypes: ['Office'],
      side: 'Demand',
    });
    expect(raw[2]?.primary_reason_code).toBe('deal_type_missing');
    expect(raw[2]?.reason_codes).toEqual(
      expect.arrayContaining(['value_not_translatable', 'model_unavailable']),
    );
  });
});

describe('vocabulary.released.v1 consumer', () => {
  const content = releaseContent() as unknown as Record<string, unknown>;
  const source = (version: string, checksum = releaseChecksum({ ...content, version })): ReleaseSource => ({
    release: () => Promise.resolve({ version, checksum, content: { ...content, version } }),
  });

  it('stores and activates a release with its legacy terms; an older one stays superseded; checksum verified', async () => {
    const t = newTenant();
    const apply = (src: ReleaseSource, version: string, checksum: string) =>
      h.db
        .transaction()
        .execute((trx) =>
          applyVocabularyRelease(src, repositories(trx), h.app.ids, t, { version, checksum }),
        );
    const c6 = releaseChecksum({ ...content, version: 'v0.6' });
    expect(await apply(source('v0.6'), 'v0.6', c6)).toBe('activated');
    expect(await apply(source('v0.6'), 'v0.6', c6)).toBe('known');
    expect((await h.app.uow.repos.vocabulary.legacyTerms(t, 'v0.6')).length).toBeGreaterThan(20);
    const c5 = releaseChecksum({ ...content, version: 'v0.5' });
    expect(await apply(source('v0.5'), 'v0.5', c5)).toBe('stored');
    expect((await h.app.uow.repos.vocabulary.active(t))?.version).toBe('v0.6');
    const c7 = releaseChecksum({ ...content, version: 'v0.7' });
    await expect(apply(source('v0.7', 'forged'), 'v0.7', c7)).rejects.toThrow(/checksum/);
    expect(await apply(source('v0.7'), 'v0.7', c7)).toBe('activated');
    expect((await h.app.uow.repos.vocabulary.active(t))?.version).toBe('v0.7');
  });
});
