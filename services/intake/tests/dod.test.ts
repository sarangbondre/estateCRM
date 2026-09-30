// INT-11 definition of done: every contract operation has a handler and answers with a declared status (response
// validation on), tenant isolation (NFR-15), the scheduled jobs, relay/drain wiring.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteProcessedFiles, reapChunkLeases, retentionPurge } from '../src/application/jobs.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { synthFile } from './support/files.js';
import { runUpload, uploadAndSplit } from './support/flows.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('contract coverage', () => {
  it('implements all 31 operations of intake.yaml', () => {
    expect(h.svc.unimplemented()).toEqual([]);
    expect(h.svc.contract.operations.size).toBe(31);
  });

  it('answers every operation with a status the contract declares', async () => {
    const t = newTenant();
    const admin = await h.staff(t, 'Admin');
    const records = await h.service(t, 'records');
    const journeys = await h.service(t, 'journeys');
    const { bytes } = await synthFile({ rows: 30, seed: 71, errorRate: 0.1 });
    const u = await runUpload(h, t, bytes);
    const item = (await h.call('GET', '/v1/review-items?status=open', admin)).body.items?.[0];
    const tpl = await h.call('POST', '/v1/templates', admin, {
      name: 'T',
      sourceType: 'Direct',
      headers: ['a'],
      columnMap: { a: 'raw_text' },
    });
    const id = u.id;
    const calls: [string, string, Record<string, string>, unknown?][] = [
      [
        'POST',
        '/v1/uploads',
        admin,
        { fileName: 'a.csv', contentType: 'text/csv', sizeBytes: 5, sourceType: 'Direct' },
      ],
      ['GET', '/v1/uploads', admin],
      ['GET', `/v1/uploads/${id}`, admin],
      ['PATCH', `/v1/uploads/${id}`, admin, { sourceDetail: 'x' }],
      ['POST', `/v1/uploads/${id}/inspect`, admin],
      ['PUT', `/v1/uploads/${id}/mapping`, admin, { columnMap: {} }],
      ['POST', `/v1/uploads/${id}/start`, admin, {}],
      ['POST', `/v1/uploads/${id}/cancel`, admin],
      ['GET', `/v1/uploads/${id}/progress`, admin],
      ['GET', `/v1/uploads/${id}/row-errors`, admin],
      ['GET', `/v1/uploads/${id}/rejected-rows`, admin],
      ['GET', `/v1/uploads/${id}/migration-map`, admin],
      ['GET', '/v1/templates', admin],
      [
        'POST',
        '/v1/templates',
        admin,
        { name: 'T2', sourceType: 'Direct', headers: ['a'], columnMap: { a: 'raw_text' } },
      ],
      ['GET', `/v1/templates/${String(tpl.body['id'])}`, admin],
      [
        'PUT',
        `/v1/templates/${String(tpl.body['id'])}`,
        admin,
        { name: 'T3', sourceType: 'Direct', headers: ['a'], columnMap: { a: 'raw_text' } },
      ],
      ['DELETE', `/v1/templates/${String(tpl.body['id'])}`, admin],
      ['GET', '/v1/review-items', admin],
      ['GET', '/v1/review-items/summary', admin],
      ['GET', `/v1/review-items/${String(item?.['id'])}`, admin],
      ['POST', `/v1/review-items/${String(item?.['id'])}/resolve`, admin, { action: 'confirm' }],
      ['POST', '/v1/review-items/bulk-resolve', admin, { ids: [randomUUID()], action: 'confirm' }],
      ['POST', '/v1/parse', admin, { text: '2BHK wanted in Powai on rent' }],
      ['GET', `/internal/v1/uploads/${id}/rows?batch=1`, records],
      ['GET', `/internal/v1/uploads/${id}/migration-map`, records],
      ['GET', `/internal/v1/uploads/${id}/rows/1/note`, journeys],
      ['POST', '/internal/v1/relay', h.cron],
      ['POST', '/internal/v1/drain/q_intake', h.cron],
      ['POST', '/internal/v1/jobs/reap-chunk-leases', h.cron],
      ['GET', '/health/live', {}],
      ['GET', '/health/ready', {}],
    ];
    expect(calls).toHaveLength(31);
    for (const [method, path, headers, body] of calls) {
      const r = await h.call(method, path, headers, body);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).not.toBe(500);
    }
  });
});

describe('tenant isolation (NFR-15)', () => {
  it('never lets tenant B read or change tenant A resources', async () => {
    const a = newTenant();
    const b = newTenant();
    const { bytes } = await synthFile({ rows: 20, seed: 72 });
    const u = await runUpload(h, a, bytes);
    const tpl = await h.call('POST', '/v1/templates', await h.staff(a), {
      name: 'A',
      sourceType: 'Direct',
      headers: ['x'],
      columnMap: { x: 'raw_text' },
    });
    const item = (await h.call('GET', '/v1/review-items', await h.staff(a))).body.items?.[0];
    const hb = await h.staff(b, 'Admin');
    const probes: [string, string, unknown?][] = [
      ['GET', `/v1/uploads/${u.id}`],
      ['GET', `/v1/uploads/${u.code}`],
      ['PATCH', `/v1/uploads/${u.id}`, { sourceDetail: 'x' }],
      ['POST', `/v1/uploads/${u.id}/cancel`],
      ['GET', `/v1/uploads/${u.id}/progress`],
      ['GET', `/v1/uploads/${u.id}/row-errors`],
      ['GET', `/v1/uploads/${u.id}/rejected-rows`],
      ['GET', `/v1/templates/${String(tpl.body['id'])}`],
      [
        'PUT',
        `/v1/templates/${String(tpl.body['id'])}`,
        { name: 'B', sourceType: 'Direct', headers: ['x'], columnMap: { x: 'raw_text' } },
      ],
      ...(item
        ? ([
            ['GET', `/v1/review-items/${String(item['id'])}`],
            ['POST', `/v1/review-items/${String(item['id'])}/resolve`, { action: 'confirm' }],
          ] as [string, string, unknown?][])
        : []),
    ];
    for (const [method, path, body] of probes) {
      expect((await h.call(method, path, hb, body)).status, `${method} ${path}`).toBe(404);
    }
    expect(
      (await h.call('GET', `/internal/v1/uploads/${u.id}/rows?batch=1`, await h.service(b, 'records')))
        .status,
    ).toBe(404);
    expect((await h.call('GET', '/v1/uploads', hb)).body.items).toEqual([]);
    expect((await h.call('GET', '/v1/templates', hb)).body.items).toEqual([]);
    expect((await h.call('GET', '/v1/review-items', hb)).body.items).toEqual([]);
  });
});

describe('scheduled jobs', () => {
  it('retention-purge deletes raw rows, errors and review items after the retention window', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 40, seed: 73, errorRate: 0.1 });
    const u = await runUpload(h, t, bytes);
    // the shared DB holds many due uploads from other tests: put this one first in the (purge_after) order
    await h.db
      .updateTable('uploads')
      .set({ purge_after: new Date('2000-01-01') })
      .where('id', '=', u.id)
      .execute();
    await retentionPurge(h.app, new Date(Date.now() + 31 * 86_400_000));
    const count = async (table: 'raw_rows' | 'row_errors' | 'review_items') =>
      (await h.db.selectFrom(table).select('id').where('upload_id', '=', u.id).execute()).length;
    expect([await count('raw_rows'), await count('row_errors'), await count('review_items')]).toEqual([
      0, 0, 0,
    ]);
    const up = await h.db.selectFrom('uploads').select('purged_at').where('id', '=', u.id).executeTakeFirst();
    expect(up?.purged_at).toBeTruthy();
    expect(
      (await h.call('GET', `/internal/v1/uploads/${u.id}/rows?batch=1`, await h.service(t, 'records'))).body[
        'code'
      ],
    ).toBe('batch-not-found');
  });

  it('reap-chunk-leases requeues an expired lease', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 10, seed: 74 });
    const u = await uploadAndSplit(h, t, bytes);
    await h.db
      .updateTable('upload_chunks')
      .set({ status: 'leased', attempts: 1, leased_until: new Date(Date.now() - 60_000) })
      .where('upload_id', '=', u.id)
      .execute();
    const r = await reapChunkLeases(h.app);
    expect(r.processed).toBeGreaterThanOrEqual(1);
    const c = await h.db
      .selectFrom('upload_chunks')
      .select('status')
      .where('upload_id', '=', u.id)
      .executeTakeFirst();
    expect(c?.status).toBe('queued');
  });

  it('delete-processed-files removes the rejected-rows file after 7 days', async () => {
    const t = newTenant();
    const { bytes } = await synthFile({ rows: 30, seed: 75, errorRate: 0.2 });
    const u = await runUpload(h, t, bytes);
    const path = `intake-rejected/${t}/${u.id}.csv`;
    expect(h.files.objects.has(path)).toBe(true);
    await h.db
      .updateTable('uploads')
      .set({ file_cleanup_at: new Date('2000-01-01') })
      .where('id', '=', u.id)
      .execute();
    await deleteProcessedFiles(h.app, new Date(Date.now() + 8 * 86_400_000));
    expect(h.files.objects.has(path)).toBe(false);
    expect((await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body['rejectedFileReady']).toBe(false);
  });

  it('runs every job through the cron endpoint', async () => {
    for (const name of [
      'retention-purge',
      'expire-idempotency-keys',
      'reap-chunk-leases',
      'delete-processed-files',
    ]) {
      const r = await h.call('POST', `/internal/v1/jobs/${name}`, h.cron);
      expect([200, 409], name).toContain(r.status);
    }
  });
});
