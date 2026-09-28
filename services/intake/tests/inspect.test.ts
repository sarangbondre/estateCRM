// INT-03: inspection (strict vs mapping, migration_map detection, identical file, too many rows, unreadable files),
// mapping (+ save as template), start (vocabulary pin, chunk size, duplicate confirmation) and templates CRUD.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInspection } from '../src/application/inspection.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { csv, synthFile, workbook } from './support/files.js';
import { inspect, seedVocabulary, uploadFile } from './support/flows.js';

let h: Harness;
let strictBytes: Uint8Array;
beforeAll(async () => {
  h = await createHarness();
  strictBytes = (await synthFile({ rows: 25, seed: 11 })).bytes;
});
afterAll(() => h.close());

const MAPPING_CSV = csv([
  ['Lead ID', 'Name', 'Mobile', 'Requirement', 'Campaign'],
  ['L-1', 'Test Person', '+91 90000 11111', '2BHK wanted in Powai', 'Diwali'],
  ['L-2', 'Other Person', '+91 90000 22222', 'Office on rent BKC', 'Diwali'],
]);

describe('POST /inspect and the inspection worker', () => {
  it('detects strict mode on the 89 standard columns and makes the upload ready', async () => {
    const t = newTenant();
    const u = await uploadFile(h, t, strictBytes);
    const up = await inspect(h, t, u);
    expect(up).toMatchObject({ status: 'ready', mode: 'strict', sheetName: 'Leads', suggestedMapping: null });
    expect(up['sheetNames']).toEqual(['Leads', 'run_log']);
    expect(up['header']).toHaveLength(89);
    expect(up['hasMigrationMap']).toBe(false);
    // a repeat is naturally idempotent (200, current upload)
    const again = await h.call('POST', `/v1/uploads/${u.id}/inspect`, u.headers);
    expect(again.status).toBe(200);
  });

  it('detects mapping mode with a suggested mapping (headers only, no cell values)', async () => {
    const t = newTenant();
    const u = await uploadFile(h, t, MAPPING_CSV, {
      fileName: 'digi.csv',
      contentType: 'text/csv',
      sourceType: 'Digi',
    });
    const up = await inspect(h, t, u);
    expect(up).toMatchObject({
      status: 'awaiting_mapping',
      mode: 'mapping',
      sheetName: null,
      sheetNames: [],
    });
    expect(up['suggestedMapping']).toEqual({
      'Lead ID': 'external_id',
      Name: 'contact_name',
      Mobile: 'phones',
      Requirement: 'free_text',
      Campaign: 'campaign_ref',
    });
    expect(JSON.stringify(up)).not.toContain('Test Person');
  });

  it('recognises a migration_map sheet', async () => {
    const t = newTenant();
    const bytes = await workbook({
      Leads: [
        ['record_id', 'raw_text'],
        ['aaaaaaaaaaa1', 'text'],
      ],
      migration_map: [
        ['old_ad_id', 'new_record_ids', 'action'],
        ['bbbbbbbbbbb1', 'aaaaaaaaaaa1', 'kept'],
      ],
    });
    const up = await inspect(h, t, await uploadFile(h, t, bytes));
    expect(up).toMatchObject({ hasMigrationMap: true, sheetName: 'Leads', mode: 'mapping' });
  });

  it('is 409 file-missing before the file is uploaded and 409 file-size-mismatch on a different size', async () => {
    const t = newTenant();
    const hd = await h.staff(t);
    const r = await h.call('POST', '/v1/uploads', hd, {
      fileName: 'a.csv',
      contentType: 'text/csv',
      sizeBytes: 10,
      sourceType: 'Direct',
    });
    const id = (r.body['upload'] as { id: string }).id;
    const missing = await h.call('POST', `/v1/uploads/${id}/inspect`, hd);
    expect(missing.body['code']).toBe('file-missing');
    await h.files.put(`intake-uploads/${t}/${id}/source`, new Uint8Array(3));
    const mismatch = await h.call('POST', `/v1/uploads/${id}/inspect`, hd);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body['code']).toBe('file-size-mismatch');
  });

  it('fails an unreadable file (legacy .xls) with upload.failed.v1 reason unreadable_file', async () => {
    const t = newTenant();
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2]);
    const u = await uploadFile(h, t, ole, { fileName: 'old.xls', contentType: 'application/vnd.ms-excel' });
    const up = await inspect(h, t, u);
    expect(up).toMatchObject({ status: 'failed', failureReason: 'unreadable_file' });
    const [e] = await h.events(t, 'upload.failed.v1');
    expect(e?.data).toMatchObject({ uploadId: u.id, reason: 'unreadable_file' });
  });

  it('fails a file over the row limit (pilot 20,000; lowered here) with too_many_rows', async () => {
    const t = newTenant();
    const saved = h.app.policy.maxRows;
    h.app.policy.maxRows = 10;
    try {
      const up = await inspect(h, t, await uploadFile(h, t, strictBytes));
      expect(up).toMatchObject({ status: 'failed', failureReason: 'too_many_rows' });
    } finally {
      h.app.policy.maxRows = saved;
    }
  });

  it('asks for confirmation when an identical file was already processed', async () => {
    const t = newTenant();
    await seedVocabulary(h, t);
    const first = await uploadFile(h, t, strictBytes);
    await inspect(h, t, first);
    await h.db.updateTable('uploads').set({ status: 'completed' }).where('id', '=', first.id).execute();
    const second = await uploadFile(h, t, strictBytes);
    const up = await inspect(h, t, second);
    expect(up).toMatchObject({ status: 'awaiting_duplicate_confirmation', duplicateOfUploadId: first.id });
    const refused = await h.call('POST', `/v1/uploads/${second.id}/start`, second.headers, {});
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('duplicate-upload');
    const ok = await h.call('POST', `/v1/uploads/${second.id}/start`, second.headers, {
      allowDuplicate: true,
    });
    expect(ok.status).toBe(202);
    expect(ok.body['status']).toBe('queued');
  });

  it('re-inspects when the sheet is changed with PATCH', async () => {
    const t = newTenant();
    const bytes = await workbook({
      Leads: [['raw_text'], ['a']],
      Other: [
        ['free_text', 'x'],
        ['b', 'c'],
      ],
    });
    const u = await uploadFile(h, t, bytes);
    await inspect(h, t, u);
    const p = await h.call('PATCH', `/v1/uploads/${u.id}`, u.headers, { sheetName: 'Other' });
    expect(p.body).toMatchObject({ status: 'inspecting', sheetName: 'Other' });
    await runInspection(h.app, h.app.sheets, { tenantId: t, uploadId: u.id, correlationId: 'x' });
    const g = await h.call('GET', `/v1/uploads/${u.id}`, u.headers);
    expect(g.body).toMatchObject({ status: 'awaiting_mapping', header: ['free_text', 'x'] });
    const bad = await h.call('PATCH', `/v1/uploads/${u.id}`, u.headers, { sheetName: 'Nope' });
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('sheet-not-found');
  });
});

describe('PUT /mapping and POST /start', () => {
  it('validates the mapping (400 mapping-invalid), stores it, saves a template and makes the upload ready', async () => {
    const t = newTenant();
    await seedVocabulary(h, t);
    const u = await uploadFile(h, t, MAPPING_CSV, {
      fileName: 'digi.csv',
      contentType: 'text/csv',
      sourceType: 'Digi',
    });
    await inspect(h, t, u);
    const early = await h.call('POST', `/v1/uploads/${u.id}/start`, u.headers, {});
    expect(early.body['code']).toBe('upload-not-ready');
    const invalid = await h.call('PUT', `/v1/uploads/${u.id}/mapping`, u.headers, {
      columnMap: { Name: 'contact_name', Mobile: 'contact_name' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body['code']).toBe('mapping-invalid');
    expect((invalid.body['errors'] as { code: string }[]).map((e) => e.code)).toEqual([
      'duplicate-target',
      'classifier-input-missing',
      'digi-reference-missing',
    ]);
    const columnMap = {
      'Lead ID': 'external_id',
      Name: 'contact_name',
      Mobile: 'phones',
      Requirement: 'free_text',
      Campaign: 'campaign_ref',
    };
    const ok = await h.call('PUT', `/v1/uploads/${u.id}/mapping`, u.headers, {
      columnMap,
      constants: { sourceName: 'Meta lead ads' },
      saveAsTemplate: { name: 'Meta leads' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ready', columnMap });
    expect(ok.body['templateId']).toBeTruthy();
    const taken = await h.call('PUT', `/v1/uploads/${u.id}/mapping`, u.headers, {
      columnMap,
      saveAsTemplate: { name: 'META LEADS' },
    });
    expect(taken.body['code']).toBe('template-name-taken');

    // the next file with the same header gets the template's mapping as the suggestion
    const u2 = await uploadFile(h, t, MAPPING_CSV, {
      fileName: 'digi2.csv',
      contentType: 'text/csv',
      sourceType: 'Digi',
    });
    await h.db
      .updateTable('uploads')
      .set({ status: 'completed', sha256: 'other' })
      .where('id', '=', u.id)
      .execute();
    const up2 = await inspect(h, t, u2);
    expect(up2['templateId']).toBe(ok.body['templateId']);
  });

  it('refuses a mapping in strict mode (409 mapping-not-allowed)', async () => {
    const t = newTenant();
    const u = await uploadFile(h, t, strictBytes);
    await inspect(h, t, u);
    const r = await h.call('PUT', `/v1/uploads/${u.id}/mapping`, u.headers, { columnMap: {} });
    expect(r.status).toBe(409);
    expect(r.body['code']).toBe('mapping-not-allowed');
  });

  it('starts: pins the active vocabulary, fixes the chunk size (500 pilot); 409 without a cached release', async () => {
    const t = newTenant();
    const u = await uploadFile(h, t, strictBytes);
    await inspect(h, t, u);
    const none = await h.call('POST', `/v1/uploads/${u.id}/start`, u.headers, {});
    expect(none.status).toBe(409);
    expect(none.body['code']).toBe('vocabulary-unavailable');
    await seedVocabulary(h, t, 'v0.6');
    const reprocess = await h.call('POST', `/v1/uploads/${u.id}/start`, await h.staff(t, 'Data operator'), {
      reprocessUnchanged: true,
    });
    expect(reprocess.status).toBe(403);
    const hd = { ...u.headers, 'idempotency-key': randomUUID() };
    const r = await h.call('POST', `/v1/uploads/${u.id}/start`, hd, {});
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'queued', vocabularyVersion: 'v0.6', chunkSize: 500 });
    const replay = await h.call('POST', `/v1/uploads/${u.id}/start`, hd, {});
    expect(replay.status).toBe(202);
    const twice = await h.call('POST', `/v1/uploads/${u.id}/start`, u.headers, {});
    expect(twice.body['code']).toBe('upload-not-ready');
  });
});

describe('templates', () => {
  const input = (name: string) => ({
    name,
    sourceType: 'Digi',
    headers: ['Lead ID', 'Mobile', 'Text'],
    columnMap: { 'Lead ID': 'external_id', Mobile: 'phones', Text: 'free_text' },
  });

  it('creates, lists by name (cursor, filters), gets, replaces with If-Match and soft-deletes', async () => {
    const t = newTenant();
    const hd = await h.staff(t, 'Data operator');
    const b = await h.call('POST', '/v1/templates', hd, input('Beta'));
    expect(b.status).toBe(201);
    const a = await h.call('POST', '/v1/templates', hd, {
      ...input('alpha'),
      sourceType: 'Channel',
      headers: ['X', 'Text'],
      columnMap: { Text: 'raw_text' },
    });
    expect((await h.call('POST', '/v1/templates', hd, input('BETA'))).body['code']).toBe(
      'template-name-taken',
    );
    const p1 = await h.call('GET', '/v1/templates?limit=1', hd);
    expect(p1.body.items?.map((x) => x['name'])).toEqual(['alpha']);
    const p2 = await h.call('GET', `/v1/templates?limit=1&cursor=${String(p1.body['nextCursor'])}`, hd);
    expect(p2.body.items?.map((x) => x['name'])).toEqual(['Beta']);
    const byFp = await h.call(
      'GET',
      `/v1/templates?headerFingerprint=${String(b.body['headerFingerprint'])}`,
      hd,
    );
    expect(byFp.body.items?.map((x) => x['id'])).toEqual([b.body['id']]);
    expect(
      (await h.call('GET', '/v1/templates?sourceType=Channel', hd)).body.items?.map((x) => x['id']),
    ).toEqual([a.body['id']]);
    const id = String(b.body['id']);
    const got = await h.call('GET', `/v1/templates/${id}`, hd);
    expect(got.headers.get('etag')).toBe('"1"');
    const put = await h.call('PUT', `/v1/templates/${id}`, { ...hd, 'if-match': '1' }, input('Beta 2'));
    expect(put.body).toMatchObject({ name: 'Beta 2', version: 2 });
    expect(
      (await h.call('PUT', `/v1/templates/${id}`, { ...hd, 'if-match': '1' }, input('Beta 3'))).status,
    ).toBe(412);
    expect((await h.call('PUT', `/v1/templates/${id}`, hd, input('alpha'))).body['code']).toBe(
      'template-name-taken',
    );
    expect((await h.call('DELETE', `/v1/templates/${id}`, await h.staff(t, 'Supply agent'))).status).toBe(
      403,
    );
    expect((await h.call('DELETE', `/v1/templates/${id}`, hd)).status).toBe(204);
    expect((await h.call('DELETE', `/v1/templates/${id}`, hd)).status).toBe(204);
    expect((await h.call('GET', `/v1/templates/${id}`, hd)).status).toBe(404);
    expect((await h.call('PUT', `/v1/templates/${randomUUID()}`, hd, input('Zeta'))).status).toBe(404);
  });

  it('rejects a template whose map uses a single-use target twice', async () => {
    const hd = await h.staff(newTenant());
    const r = await h.call('POST', '/v1/templates', hd, {
      ...input('Bad'),
      columnMap: { 'Lead ID': 'contact_name', Mobile: 'contact_name' },
    });
    expect(r.status).toBe(400);
  });

  it('hides templates of other tenants', async () => {
    const hd = await h.staff(newTenant());
    const b = await h.call('POST', '/v1/templates', hd, input('Mine'));
    expect(
      (await h.call('GET', `/v1/templates/${String(b.body['id'])}`, await h.staff(newTenant()))).status,
    ).toBe(404);
  });
});
