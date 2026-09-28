// INT-02: upload API (create with signed URL, get/list, patch, cancel, progress, row errors, rejected-rows link,
// migration map) against the local DB, with responses validated against intake.yaml.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const body = (over: Record<string, unknown> = {}) => ({
  fileName: 'master.xlsx',
  contentType: XLSX,
  sizeBytes: 1234,
  sourceType: 'Channel',
  sourceDetail: 'Newspaper extractor',
  ...over,
});

async function create(tenant: string, headers?: Record<string, string>, over: Record<string, unknown> = {}) {
  const hd = headers ?? (await h.staff(tenant));
  const r = await h.call('POST', '/v1/uploads', hd, body(over));
  expect(r.status).toBe(201);
  return r.body['upload'] as Record<string, unknown>;
}

describe('POST /v1/uploads', () => {
  it('creates an upload with a code, a signed URL and pilot anonymisation on', async () => {
    const t = newTenant();
    const r = await h.call('POST', '/v1/uploads', await h.staff(t, 'Data operator'), body());
    expect(r.status).toBe(201);
    const u = r.body['upload'] as Record<string, unknown>;
    expect(u['code']).toMatch(/^UPL-\d{6}$/);
    expect(u['status']).toBe('awaiting_file');
    expect(u['anonymise']).toBe(true);
    expect(r.body['uploadUrl']).toMatch(/^https:\/\/storage\.test\/upload\/intake-uploads\//);
    expect(Date.parse(r.body['uploadUrlExpiresAt'] as string)).toBeGreaterThan(Date.now());
  });

  it('issues consecutive codes per tenant', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const a = await create(t, hd);
    const b = await create(t, hd);
    expect(Number(String(b['code']).slice(4))).toBe(Number(String(a['code']).slice(4)) + 1);
  });

  it('refuses anonymise=false in pilot mode (409 anonymise-required)', async () => {
    const r = await h.call('POST', '/v1/uploads', await h.staff(newTenant()), body({ anonymise: false }));
    expect(r.status).toBe(409);
    expect(r.body['code']).toBe('anonymise-required');
  });

  it('rejects a file name that does not match the MIME type (415)', async () => {
    const r = await h.call('POST', '/v1/uploads', await h.staff(newTenant()), body({ fileName: 'x.csv' }));
    expect(r.status).toBe(415);
    expect(r.body['code']).toBe('unsupported-media-type');
  });

  it('rejects a bad body at the edge (400 validation-failed)', async () => {
    const r = await h.call('POST', '/v1/uploads', await h.staff(newTenant()), body({ sizeBytes: 0 }));
    expect(r.status).toBe(400);
  });

  it('replays an Idempotency-Key', async () => {
    const hd = { ...(await h.staff(newTenant())), 'idempotency-key': randomUUID() };
    const a = await h.call('POST', '/v1/uploads', hd, body());
    const b = await h.call('POST', '/v1/uploads', hd, body());
    expect(b.status).toBe(201);
    expect((b.body['upload'] as { id: string }).id).toBe((a.body['upload'] as { id: string }).id);
  });

  it('allows 5 uploads per hour per user, then 429 rate-limited', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    for (let i = 0; i < 5; i++) await create(t, hd);
    const r = await h.call('POST', '/v1/uploads', hd, body());
    expect(r.status).toBe(429);
    expect(r.body['code']).toBe('rate-limited');
    expect(r.headers.get('retry-after')).toBeTruthy();
    // another user of the same tenant is not limited
    await create(t);
  });
});

describe('GET /v1/uploads and /v1/uploads/{idOrCode}', () => {
  it('gets by id and by code with an ETag, and hides other tenants (404)', async () => {
    const t = newTenant();
    const hd = await h.staff(t, 'Supply agent');
    const u = await create(t, hd);
    const byId = await h.call('GET', `/v1/uploads/${String(u['id'])}`, hd);
    expect(byId.status).toBe(200);
    expect(byId.headers.get('etag')).toBe('"1"');
    const byCode = await h.call('GET', `/v1/uploads/${String(u['code']).toLowerCase()}`, hd);
    expect(byCode.body['id']).toBe(u['id']);
    const other = await h.call('GET', `/v1/uploads/${String(u['id'])}`, await h.staff(newTenant()));
    expect(other.status).toBe(404);
    expect((await h.call('GET', '/v1/uploads/not-a-code', hd)).status).toBe(404);
  });

  it('lists newest first with cursor pagination and filters', async () => {
    const t = newTenant();
    const alice = await h.staff(t, 'Data operator');
    const bob = await h.staff(t, 'Manager');
    const ids = [
      (await create(t, alice))['id'],
      (await create(t, alice, { sourceType: 'Digi' }))['id'],
      (await create(t, bob))['id'],
    ];
    const p1 = await h.call('GET', '/v1/uploads?limit=2', alice);
    expect(p1.status).toBe(200);
    expect(p1.body.items?.map((u) => u['id'])).toEqual([ids[2], ids[1]]);
    const p2 = await h.call('GET', `/v1/uploads?limit=2&cursor=${String(p1.body['nextCursor'])}`, alice);
    expect(p2.body.items?.map((u) => u['id'])).toEqual([ids[0]]);
    expect(p2.body['nextCursor']).toBeNull();
    const digi = await h.call('GET', '/v1/uploads?sourceType=Digi', alice);
    expect(digi.body.items?.map((u) => u['id'])).toEqual([ids[1]]);
    const byBob = await h.call(
      'GET',
      `/v1/uploads?uploadedBy=${alice['x-user-id']}&status=awaiting_file`,
      bob,
    );
    expect(byBob.body.items).toHaveLength(2);
    expect((await h.call('GET', '/v1/uploads?cursor=%%%', alice)).status).toBe(400);
  });
});

describe('PATCH /v1/uploads/{idOrCode}', () => {
  it('changes pre-start options with If-Match; 412 on a stale version', async () => {
    const t = newTenant();
    const hd = await h.staff(t, 'Supply agent');
    const u = await create(t, hd);
    const r = await h.call(
      'PATCH',
      `/v1/uploads/${String(u['id'])}`,
      { ...hd, 'if-match': '"1"' },
      {
        sourceDetail: 'Mid-day',
        importCrmNotes: true,
      },
    );
    expect(r.status).toBe(200);
    expect(r.body['sourceDetail']).toBe('Mid-day');
    expect(r.body['importCrmNotes']).toBe(true);
    expect(r.body['version']).toBe(2);
    const stale = await h.call(
      'PATCH',
      `/v1/uploads/${String(u['id'])}`,
      { ...hd, 'if-match': '1' },
      {
        sourceDetail: 'x',
      },
    );
    expect(stale.status).toBe(412);
  });

  it('refuses anonymise=false in the pilot and other users without Admin/Manager', async () => {
    const t = newTenant();
    const owner = await h.staff(t, 'Supply agent');
    const u = await create(t, owner);
    const off = await h.call('PATCH', `/v1/uploads/${String(u['id'])}`, owner, { anonymise: false });
    expect(off.status).toBe(409);
    expect(off.body['code']).toBe('anonymise-required');
    const stranger = await h.call(
      'PATCH',
      `/v1/uploads/${String(u['id'])}`,
      await h.staff(t, 'Demand agent'),
      {
        sourceDetail: 'x',
      },
    );
    expect(stranger.status).toBe(403);
    const mgr = await h.call('PATCH', `/v1/uploads/${String(u['id'])}`, await h.staff(t, 'Manager'), {
      sourceDetail: 'y',
    });
    expect(mgr.status).toBe(200);
  });

  it('is 409 upload-not-editable after start', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const u = await create(t, hd);
    await h.db
      .updateTable('uploads')
      .set({ status: 'processing' })
      .where('id', '=', String(u['id']))
      .execute();
    const r = await h.call('PATCH', `/v1/uploads/${String(u['id'])}`, hd, { sourceDetail: 'x' });
    expect(r.status).toBe(409);
    expect(r.body['code']).toBe('upload-not-editable');
  });
});

describe('POST /v1/uploads/{idOrCode}/cancel', () => {
  it('cancels before start without an event, and 409 when already cancelled', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const u = await create(t, hd);
    const r = await h.call('POST', `/v1/uploads/${String(u['id'])}/cancel`, hd);
    expect(r.status).toBe(200);
    expect(r.body['status']).toBe('cancelled');
    expect(await h.events(t, 'upload.failed.v1')).toHaveLength(0);
    const again = await h.call('POST', `/v1/uploads/${String(u['id'])}/cancel`, hd);
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('upload-not-cancellable');
  });

  it('emits upload.failed.v1 (reason cancelled, version 2) when processing had started', async () => {
    const t = newTenant();
    const hd = await h.staff(t, 'Data operator');
    const u = await create(t, hd);
    await h.db
      .updateTable('uploads')
      .set({ status: 'processing' })
      .where('id', '=', String(u['id']))
      .execute();
    expect(
      (await h.call('POST', `/v1/uploads/${String(u['id'])}/cancel`, await h.staff(t, 'Supply agent')))
        .status,
    ).toBe(403);
    const r = await h.call('POST', `/v1/uploads/${String(u['id'])}/cancel`, hd);
    expect(r.status).toBe(200);
    const [e] = await h.events(t, 'upload.failed.v1');
    expect(e?.aggregateVersion).toBe(2);
    expect(e?.data).toMatchObject({ uploadId: u['id'], reason: 'cancelled', uploadedBy: hd['x-user-id'] });
  });
});

describe('progress, row errors, rejected rows and migration map', () => {
  it('reports progress', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const u = await create(t, hd);
    const r = await h.call('GET', `/v1/uploads/${String(u['code'])}/progress`, hd);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      uploadId: u['id'],
      status: 'awaiting_file',
      chunksDone: 0,
      etaSeconds: null,
    });
  });

  it('lists row errors in row order with filters and a cursor', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const u = await create(t, hd);
    const uploadId = String(u['id']);
    await h.app.uow.repos.rowErrors.insertMany(
      [3, 1, 2].map((rowNo) => ({
        id: randomUUID(),
        tenantId: t,
        uploadId,
        rowId: null,
        rowNo,
        sheetName: 'Leads',
        field: rowNo === 2 ? 'phones' : 'deal_type',
        severity: rowNo === 2 ? ('warning' as const) : ('error' as const),
        code: rowNo === 2 ? 'invalid-phone' : 'value-not-in-list',
        value: rowNo === 2 ? null : 'Rent Out',
        message: 'x',
      })),
    );
    const p1 = await h.call('GET', `/v1/uploads/${uploadId}/row-errors?limit=2`, hd);
    expect(p1.body.items?.map((e) => e['rowNo'])).toEqual([1, 2]);
    const p2 = await h.call(
      'GET',
      `/v1/uploads/${uploadId}/row-errors?cursor=${String(p1.body['nextCursor'])}`,
      hd,
    );
    expect(p2.body.items?.map((e) => e['rowNo'])).toEqual([3]);
    const f = await h.call(
      'GET',
      `/v1/uploads/${uploadId}/row-errors?field=deal_type&code=value-not-in-list`,
      hd,
    );
    expect(f.body.items).toHaveLength(2);
    expect(await h.app.uow.repos.rowErrors.rejectionReasons(t, uploadId)).toEqual({ 'value-not-in-list': 2 });
  });

  it('gives the rejected-rows link only when ready, with an audit event, to allowed roles', async () => {
    const t = newTenant();
    const hd = await h.staff(t, 'Supply agent');
    const u = await create(t, hd);
    const id = String(u['id']);
    const early = await h.call('GET', `/v1/uploads/${id}/rejected-rows`, hd);
    expect(early.status).toBe(409);
    expect(early.body['code']).toBe('rejected-file-not-ready');
    await h.db
      .updateTable('uploads')
      .set({
        status: 'completed',
        rows_rejected: 4,
        rejected_file_path: `intake-rejected/${t}/${id}.csv`,
        rejected_file_ready_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    expect(
      (await h.call('GET', `/v1/uploads/${id}/rejected-rows`, await h.staff(t, 'Demand agent'))).status,
    ).toBe(403);
    const ok = await h.call('GET', `/v1/uploads/${id}/rejected-rows`, await h.staff(t, 'Data operator'));
    expect(ok.status).toBe(200);
    expect(ok.body['rowCount']).toBe(4);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const [audit] = await h.events(t, 'audit.recorded.v1');
    expect(audit?.data).toMatchObject({
      action: 'rejected_rows_downloaded',
      subjectId: id,
      subjectType: 'upload',
    });
  });

  it('returns the migration map summary with a page of entries', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const u = await create(t, hd);
    const id = String(u['id']);
    await h.app.uow.repos.migration.insertMany(
      t,
      id,
      [
        { entryNo: 1, oldRef: 'aaaaaaaaaaaa', newRefs: ['bbbbbbbbbbbb'], action: 'kept' },
        { entryNo: 2, oldRef: 'cccccccccccc', newRefs: ['dddddddddddd', 'eeeeeeeeeeee'], action: 'split' },
        { entryNo: 3, oldRef: 'ffffffffffff', newRefs: ['bbbbbbbbbbbb'], action: 'merged' },
      ],
      () => randomUUID(),
    );
    await h.db
      .updateTable('uploads')
      .set({ migration_entries: 3, has_migration_map: true })
      .where('id', '=', id)
      .execute();
    const r = await h.call('GET', `/v1/uploads/${id}/migration-map?limit=2`, hd);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ uploadId: id, entries: 3, byAction: { kept: 1, merged: 1, split: 1 } });
    expect((r.body.items ?? []).map((e) => e['entryNo'])).toEqual([1, 2]);
    const split = await h.call('GET', `/v1/uploads/${id}/migration-map?action=split`, hd);
    expect(split.body.items?.[0]).toMatchObject({
      oldRef: 'cccccccccccc',
      newRefs: ['dddddddddddd', 'eeeeeeeeeeee'],
    });
  });
});
