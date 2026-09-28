// INT-08: finalize (upload.completed.v1 / upload.failed.v1, rejected-rows CSV, chunk files deleted) and the internal
// rows / migration-map API for records (service token, x-callers [records]).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processChunk } from '../src/application/chunk.js';
import { runFinalize } from '../src/application/finalize.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { synthFile, workbook } from './support/files.js';
import { runUpload, uploadAndSplit } from './support/flows.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('finalize', () => {
  it('completes with counts, rejection reasons, a rejected-rows CSV and no chunk files left', async () => {
    const t = newTenant();
    const { bytes, manifest } = await synthFile({ rows: 700, seed: 51, errorRate: 0.05 });
    const u = await runUpload(h, t, bytes);
    const up = (await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body;
    expect(up).toMatchObject({ status: 'completed', rejectedFileReady: true, batchCount: 2 });
    const [done] = await h.events(t, 'upload.completed.v1');
    expect(done?.aggregateVersion).toBe(2);
    expect(done?.data).toMatchObject({
      uploadId: u.id,
      counts: { read: 700, accepted: manifest.totals.loaded, rejected: manifest.totals.rejected },
      rejectionReasons: Object.fromEntries(Object.entries(manifest.errors).filter(([, n]) => n > 0)),
    });
    const csv = h.files.text(`intake-rejected/${t}/${u.id}.csv`) ?? '';
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('record_id');
    expect(lines[0]?.endsWith(',error')).toBe(true);
    expect(lines.length - 1).toBe(manifest.totals.rejected);
    expect([...h.files.objects.keys()].some((k) => k.startsWith(`intake-uploads/${t}/${u.id}/chunks/`))).toBe(
      false,
    );
    const link = await h.call('GET', `/v1/uploads/${u.id}/rejected-rows`, u.headers);
    expect(link.body['rowCount']).toBe(manifest.totals.rejected);
    // redelivered finalize: no second event
    await runFinalize(h.app, { tenantId: t, uploadId: u.id, correlationId: 'again' });
    expect(await h.events(t, 'upload.completed.v1')).toHaveLength(1);
  });

  it('fails the upload (chunk_failed) when a chunk failed, keeping emitted batches', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 30, seed: 52 });
    const u = await uploadAndSplit(h, t, bytes);
    await h.files.remove([`intake-uploads/${t}/${u.id}/chunks/1.ndjson`]);
    for (let i = 0; i < 5; i++) {
      await processChunk(h.app, { tenantId: t, uploadId: u.id, chunkNo: 1, correlationId: 'x' }).catch(
        () => undefined,
      );
    }
    await runFinalize(h.app, { tenantId: t, uploadId: u.id, correlationId: 'x' });
    const [failed] = await h.events(t, 'upload.failed.v1');
    expect(failed?.data).toMatchObject({ uploadId: u.id, reason: 'chunk_failed' });
    expect((await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body['status']).toBe('failed');
  });

  it('completes an empty file', async () => {
    const t = newTenant();
    const bytes = await workbook({ Leads: [['record_id', 'raw_text']] });
    const u = await runUpload(h, t, bytes, {
      mapping: { columnMap: { record_id: 'record_id', raw_text: 'raw_text' } },
    });
    expect((await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body).toMatchObject({
      status: 'completed',
      rejectedFileReady: false,
    });
  });
});

describe('internal API for records', () => {
  it('serves the rows of an emitted batch (PII, no-store) to records only', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 40, seed: 53 });
    const u = await runUpload(h, t, bytes);
    const records = await h.service(t, 'records');
    const r = await h.call('GET', `/internal/v1/uploads/${u.id}/rows?batch=1`, records);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({ uploadId: u.id, batchNo: 1, anonymised: true, vocabularyVersion: 'v0.6' });
    const rows = r.body['rows'] as Record<string, unknown>[];
    expect(rows).toHaveLength(40);
    expect(rows[0]).toMatchObject({
      externalSource: 'extractor',
      captureMode: 'uploaded',
      sourceType: 'Channel',
    });
    expect((await h.call('GET', `/internal/v1/uploads/${u.id}/rows?batch=2`, records)).body['code']).toBe(
      'batch-not-found',
    );
    expect(
      (await h.call('GET', `/internal/v1/uploads/${u.id}/rows?batch=1`, await h.service(t, 'listings')))
        .status,
    ).toBe(403);
    expect((await h.call('GET', `/internal/v1/uploads/${u.id}/rows?batch=1`, await h.staff(t))).status).toBe(
      403,
    );
    expect(
      (
        await h.call(
          'GET',
          `/internal/v1/uploads/${u.id}/rows?batch=1`,
          await h.service(newTenant(), 'records'),
        )
      ).status,
    ).toBe(404);
  });

  it('pages the migration map in entry order', async () => {
    const t = newTenant();
    const u = await uploadAndSplit(
      h,
      t,
      await workbook({
        Leads: [
          ['record_id', 'raw_text'],
          ['aaaaaaaaaaa1', 'x'],
        ],
      }),
      {
        mapping: { columnMap: { record_id: 'record_id', raw_text: 'raw_text' } },
      },
    );
    await h.app.uow.repos.migration.insertMany(
      t,
      u.id,
      [1, 2, 3].map((n) => ({
        entryNo: n,
        oldRef: `${n}`.padStart(12, 'b'),
        newRefs: ['aaaaaaaaaaa1'],
        action: 'merged' as const,
      })),
      () => randomUUID(),
    );
    const records = await h.service(t, 'records');
    const p1 = await h.call('GET', `/internal/v1/uploads/${u.id}/migration-map?limit=2`, records);
    expect((p1.body.items ?? []).map((e) => e['entryNo'])).toEqual([1, 2]);
    const p2 = await h.call(
      'GET',
      `/internal/v1/uploads/${u.id}/migration-map?limit=2&cursor=${String(p1.body['nextCursor'])}`,
      records,
    );
    expect((p2.body.items ?? []).map((e) => e['entryNo'])).toEqual([3]);
    expect((await h.call('GET', `/internal/v1/uploads/${randomUUID()}/migration-map`, records)).status).toBe(
      404,
    );
  });
});
