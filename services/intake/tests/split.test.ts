// INT-04: split job: streaming chunk files (500 rows in the pilot), chunk plan, upload.started.v1, migration_map
// parsing with fingerprint re-keying, idempotent redelivery.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationMapParser } from '../src/domain/migration.js';
import { decodeChunk, runSplit } from '../src/application/split.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { synthFile, workbook } from './support/files.js';
import { uploadAndSplit } from './support/flows.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('MigrationMapParser', () => {
  it('parses entries in sheet order and reports invalid ones', () => {
    const p = new MigrationMapParser();
    p.header(1, ['Old AD ID', 'new_record_ids', 'ACTION']);
    p.row(2, ['AAAAAAAAAAA1', 'bbbbbbbbbbb1', 'Kept']);
    p.row(3, ['ccccccccccc1', 'ddddddddddd1| ddddddddddd2 ,ddddddddddd3', 'split']);
    p.row(4, ['nothex', 'ddddddddddd1', 'merged']);
    p.row(5, ['eeeeeeeeeee1', 'ddddddddddd1|ddddddddddd2', 'kept']);
    p.row(6, ['fffffffffff1', 'ddddddddddd1', 'renamed']);
    expect(p.entries).toEqual([
      { entryNo: 1, oldRef: 'aaaaaaaaaaa1', newRefs: ['bbbbbbbbbbb1'], action: 'kept' },
      {
        entryNo: 2,
        oldRef: 'ccccccccccc1',
        newRefs: ['ddddddddddd1', 'ddddddddddd2', 'ddddddddddd3'],
        action: 'split',
      },
    ]);
    expect(p.issues.map((i) => [i.rowNo, i.field])).toEqual([
      [4, 'old_ad_id'],
      [5, 'new_record_ids'],
      [6, 'action'],
    ]);
  });
});

describe('split job', () => {
  it('writes 500-row NDJSON chunks, the chunk plan and upload.started.v1', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 1_100, seed: 21 });
    const u = await uploadAndSplit(h, t, bytes);
    const up = (await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body;
    expect(up).toMatchObject({
      status: 'processing',
      chunkSize: 500,
      chunkCount: 3,
      counts: { read: 1_100 },
    });
    const chunks = await h.db
      .selectFrom('upload_chunks')
      .select(['chunk_no', 'row_from', 'row_to', 'status', 'chunk_file_path'])
      .where('upload_id', '=', u.id)
      .orderBy('chunk_no')
      .execute();
    expect(chunks.map((c) => [c.chunk_no, c.row_from, c.row_to, c.status])).toEqual([
      [1, 1, 500, 'queued'],
      [2, 501, 1000, 'queued'],
      [3, 1001, 1100, 'queued'],
    ]);
    const lines = decodeChunk(h.files.text(chunks[2]?.chunk_file_path ?? '') ?? '');
    expect(lines).toHaveLength(100);
    expect(lines[0]?.r).toBe(1001);
    expect(lines[0]?.c).toHaveLength(89);
    const [started] = await h.events(t, 'upload.started.v1');
    expect(started).toMatchObject({ aggregateType: 'upload', aggregateId: u.id, aggregateVersion: 1 });
    expect(started?.data).toMatchObject({
      uploadId: u.id,
      mode: 'strict',
      rowCount: 1_100,
      anonymised: true,
    });
    // pilot: anonymised → the original file is deleted right after the split (CR-006 Z-9)
    expect(h.files.objects.has(`intake-uploads/${t}/${u.id}/source`)).toBe(false);
    // a redelivered split message changes nothing
    await runSplit(h.app, { tenantId: t, uploadId: u.id, correlationId: 'again' });
    expect(await h.events(t, 'upload.started.v1')).toHaveLength(1);
  });

  it('parses the migration_map sheet, reports invalid entries and re-keys fingerprints', async () => {
    const t = newTenant();
    await h.app.uow.repos.fingerprints.upsertMany(t, 'extractor', [
      { externalRef: 'aaaaaaaaaaa1', contentHash: 'h1', uploadId: randomUUID(), rowId: randomUUID() },
      { externalRef: 'ccccccccccc1', contentHash: 'h2', uploadId: randomUUID(), rowId: randomUUID() },
    ]);
    const bytes = await workbook({
      Leads: [
        ['record_id', 'raw_text'],
        ['bbbbbbbbbbb1', 'x'],
      ],
      migration_map: [
        ['old_ad_id', 'new_record_ids', 'action'],
        ['aaaaaaaaaaa1', 'bbbbbbbbbbb1', 'kept'],
        ['ccccccccccc1', 'ddddddddddd1|ddddddddddd2', 'split'],
        ['zz', 'ddddddddddd1', 'merged'],
      ],
    });
    const u = await uploadAndSplit(h, t, bytes, {
      mapping: { columnMap: { record_id: 'record_id', raw_text: 'raw_text' } },
    });
    const mm = await h.call('GET', `/v1/uploads/${u.id}/migration-map`, u.headers);
    expect(mm.body).toMatchObject({ entries: 2, byAction: { kept: 1, merged: 0, split: 1 } });
    const errs = await h.call(
      'GET',
      `/v1/uploads/${u.id}/row-errors?code=migration-entry-invalid`,
      u.headers,
    );
    expect(errs.body.items).toEqual([
      expect.objectContaining({ rowNo: 4, sheetName: 'migration_map', field: 'old_ad_id' }),
    ]);
    const fps = await h.app.uow.repos.fingerprints.getMany(t, 'extractor', [
      'aaaaaaaaaaa1',
      'bbbbbbbbbbb1',
      'ccccccccccc1',
    ]);
    expect(Object.fromEntries(fps)).toEqual({ bbbbbbbbbbb1: 'h1' });
  });

  it('queues finalize directly for a file with no data rows', async () => {
    const t = newTenant();
    const bytes = await workbook({ Leads: [['record_id', 'raw_text']] });
    const u = await uploadAndSplit(h, t, bytes, {
      mapping: { columnMap: { record_id: 'record_id', raw_text: 'raw_text' } },
    });
    const up = (await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body;
    expect(up).toMatchObject({ status: 'processing', chunkCount: 0, counts: { read: 0 } });
  });
});
