// INS-05: background Excel exports — list plans only, row cap (R-16), contact columns via records for allowed roles
// only (C2, R-21; fake port here), 10 per hour, 24 h link with 10-minute signed URLs, audit and export.* events.
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import { expireExports, runExportJob } from '../src/application/exports.js';
import type { Contact, ContactsReader } from '../src/application/ports.js';
import { localFileStore } from '../src/adapters/files.js';
import { wire } from '../src/adapters/wiring.js';
import { offerCreated } from './fixtures.js';
import { TestClock, eventProblems, harness, ids } from './helpers.js';
import { NOW, seedBenchmark } from './seed.js';
import type { Seeded } from './seed.js';

const clock = new TestClock(NOW);
const calls: { personIds: readonly string[]; exportId: string }[] = [];
const people = new Map<string, Contact>();
let contactsDown = false;
const contacts: ContactsReader = {
  async batch(_t, personIds, exportId) {
    calls.push({ personIds, exportId });
    if (contactsDown) throw Object.assign(new Error('records down'), { name: 'DownstreamError' });
    return new Map(personIds.filter((p) => people.has(p)).map((p) => [p, people.get(p) as Contact]));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'insight-exports-'));
const files = localFileStore(dir);
const h = harness({ clock, contacts, files });
const wired = wire(h.deps);
let seeded: Seeded;
afterAll(() => h.close());

const galas = {
  planId: 'list_offers',
  templateVersion: 1,
  filters: [
    { field: 'deal_type', op: 'eq', value: 'Lease' },
    { field: 'property_type', op: 'eq', value: 'Gala' },
    { field: 'location', op: 'eq', value: 'Bhiwandi' },
  ],
};

beforeAll(async () => {
  seeded = await seedBenchmark(h);
  const person = ids();
  people.set(person, { name: 'Test Owner', phones: ['+91 00000 00001'], emails: ['owner@example.com'] });
  const o = offerCreated({ dealType: 'Lease', segment: 'Industrial', propertyTypes: ['Gala'], micromarket: 'Bhiwandi', locality: 'Bhiwandi', contactPersonIds: [person] });
  await h.deliver('offer.created.v1', o, { aggregateId: o.offerId });
});

async function drainOne(exportId: string) {
  return runExportJob(wired.exports, { tenantId: h.tenantId, exportId }, 'test');
}

describe('POST /v1/exports and the job', () => {
  it('queues, builds the workbook with contact columns, completes with events and a signed link', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const r = await me.post('/v1/exports', { plan: galas, includeContacts: true, fileName: 'Bhiwandi galas' }, { 'idempotency-key': ids() });
    expect(r.status).toBe(202);
    expect(r.headers['location']).toBe(`/v1/exports/${r.body['exportId']}`);
    expect(r.body).toMatchObject({ status: 'queued', includesContacts: true, estimatedRows: 3, fileName: 'Bhiwandi galas.xlsx', downloadUrl: null });
    const queued = await h.rows(sql`select 1 from export_job where tenant_id = ${h.tenantId} and id = ${r.body['exportId']}`);
    expect(queued).toHaveLength(1);

    expect(await drainOne(r.body['exportId'] as string)).toBe('done');
    expect(await drainOne(r.body['exportId'] as string)).toBe('skipped'); // duplicate delivery
    expect(calls.at(-1)?.exportId).toBe(r.body['exportId']);
    const got = await me.get(`/v1/exports/${r.body['code']}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'completed', rowCount: 3 });
    expect(got.body['downloadUrl']).toMatch(/^file:/);
    const path = fileURLToPath((got.body['downloadUrl'] as string).split('?')[0] as string);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.worksheets[0];
    const header = (ws?.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(['Code', 'For', 'Contact name', 'Phones', 'E-mails']));
    const phones = ws?.getColumn(header.indexOf('Phones') + 1).values.filter(Boolean) as string[];
    expect(phones).toContain('+91 00000 00001');
    expect(ws?.rowCount).toBe(4);

    // contacts are only in the file: nothing in insight's tables
    const leaked = await h.rows(sql`select 1 from export_job where tenant_id = ${h.tenantId} and plan::text like '%00000 00001%'`);
    expect(leaked).toHaveLength(0);
    const events = await h.outbox();
    const done = events.find((e) => e.event_type === 'export.completed.v1');
    const audit = events.find((e) => e.event_type === 'audit.recorded.v1');
    expect(done?.payload.data).toMatchObject({ rowCount: 3, requestedBy: seeded.me, includesPii: true });
    expect(audit?.payload.data).toMatchObject({ action: 'export.created', via: 'ui', details: { rowCount: '3', includesPii: 'true', planId: 'list_offers' } });
    expect(eventProblems(done?.payload)).toBeNull();
    expect(eventProblems(audit?.payload)).toBeNull();
  });

  it('enforces roles, list plans, the row cap and the hourly limit', async () => {
    const op = await h.as(ids(), 'Data operator');
    const denied = await op.post('/v1/exports', { plan: galas, includeContacts: true });
    expect(denied.status).toBe(403);
    expect(denied.body['code']).toBe('contacts-not-allowed');
    expect((await op.post('/v1/exports', { plan: galas })).status).toBe(403); // business plans are not the operator's
    const notList = await op.post('/v1/exports', { plan: { planId: 'upload_quality', templateVersion: 1 } });
    expect(notList.status).toBe(422);
    const small = harness({ clock, files, config: { exportMaxRows: 2 } });
    try {
      const tooLarge = await (await small.as(seeded.me, 'Manager', h.tenantId)).post('/v1/exports', { plan: galas });
      expect(tooLarge.status).toBe(422);
      expect(tooLarge.body['code']).toBe('export-too-large');
    } finally {
      await small.close();
    }
    const busy = await h.as(ids(), 'Supply agent');
    for (let i = 0; i < 10; i++) expect((await busy.post('/v1/exports', { plan: galas })).status).toBe(202);
    const eleventh = await busy.post('/v1/exports', { plan: galas });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body['code']).toBe('rate-limited');
    const bad = await busy.post('/v1/exports', { plan: { planId: 'list_offers', templateVersion: 1, filters: [{ field: 'phone', op: 'eq', value: '1' }] } });
    expect(bad.status).toBe(422);
  });

  it('lists own exports (Admin sees all), filters by status, and hides others’ exports', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const mine = await me.get('/v1/exports?limit=5');
    expect(mine.status).toBe(200);
    expect(mine.body['items']?.every((x) => x['requestedBy'] === seeded.me)).toBe(true);
    const admin = await h.as(ids(), 'Admin');
    const all = await admin.get('/v1/exports?limit=100&status=queued');
    expect(all.body['items']?.length).toBeGreaterThanOrEqual(10);
    const someone = all.body['items']?.[0]?.['exportId'] as string;
    expect((await admin.get(`/v1/exports/${someone}`)).status).toBe(200);
    expect((await me.get(`/v1/exports/${someone}`)).status).toBe(403);
    expect((await me.get(`/v1/exports/${ids()}`)).status).toBe(404);
    expect((await me.get('/v1/exports?cursor=bad')).status).toBe(400);
  });

  it('fails after 3 attempts with export.failed.v1 when records is unavailable', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const r = await me.post('/v1/exports', { plan: galas, includeContacts: true });
    const id = r.body['exportId'] as string;
    contactsDown = true;
    await expect(drainOne(id)).rejects.toThrow();
    await expect(drainOne(id)).rejects.toThrow();
    expect(await drainOne(id)).toBe('failed');
    contactsDown = false;
    const got = await me.get(`/v1/exports/${id}`);
    expect(got.body).toMatchObject({ status: 'failed', errorCode: 'dependency-unavailable' });
    const failed = (await h.outbox('export.failed.v1')).find((e) => e.aggregate_id === id);
    expect(failed?.payload.data).toMatchObject({ exportId: id, reason: 'dependency-unavailable' });
    expect(eventProblems(failed?.payload)).toBeNull();
  });

  it('expires links after 24 h: 410 and the file is deleted (export-expire)', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const r = await me.post('/v1/exports', { plan: galas });
    const id = r.body['exportId'] as string;
    await drainOne(id);
    const path = (await h.rows<{ file_path: string }>(sql`select file_path from export_job where tenant_id = ${h.tenantId} and id = ${id}`))[0]?.file_path as string;
    expect(existsSync(join(dir, path))).toBe(true);
    clock.set(new Date(new Date(NOW).getTime() + 25 * 3_600_000));
    expect((await me.get(`/v1/exports/${id}`)).status).toBe(410);
    let processed = 0;
    for (let i = 0; i < 20; i++) {
      const e = await expireExports(wired.exports);
      processed += e.processed;
      if (!e.remaining) break;
    }
    expect(processed).toBeGreaterThan(0);
    expect(existsSync(join(dir, path))).toBe(false);
    expect((await me.get(`/v1/exports/${id}`)).status).toBe(410);
    const status = await h.rows<{ status: string }>(sql`select status from export_job where tenant_id = ${h.tenantId} and id = ${id}`);
    expect(status[0]?.status).toBe('expired');
    clock.set(NOW);
  });

  it('runs through the platform drain and job endpoints', async () => {
    expect((await h.cron('/internal/v1/drain/q_insight_exports')).status).toBe(200);
    expect([200, 409]).toContain((await h.cron('/internal/v1/jobs/export-expire')).status);
  });
});
