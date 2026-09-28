// INS-03: plan catalogue, validation and the executor on a seeded read model (POST /v1/queries, GET plan-catalogue).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import { APPENDIX_A } from './appendixA.js';
import { TestClock, harness, ids } from './helpers.js';
import { NOW, seedBenchmark } from './seed.js';
import type { Seeded } from './seed.js';

const clock = new TestClock(NOW);
let seeded: Seeded;
const recordsCalls: string[] = [];
const h = harness({
  clock,
  records: {
    available: true,
    vocabulary: async (tenantId) => {
      recordsCalls.push(`vocabulary:${tenantId}`);
      return { version: 'v0.7-test', fields: { deal_type: { values: ['Sale', 'Lease'] }, segment: { values: ['Residential', 'Commercial', 'Industrial', 'Land'] } } };
    },
    micromarkets: async () => [
      { id: randomUUID(), parentId: null, level: 'micromarket', name: 'Powai', aliases: ['Powai Lake'], city: 'Mumbai', inLaunchArea: true, treeVersion: 2 },
    ],
  },
});
afterAll(() => h.close());
beforeAll(async () => {
  seeded = await seedBenchmark(h);
});

const q = async (plan: object, role: Parameters<typeof h.as>[1] = 'Manager', extra: object = {}, user = seeded.me) =>
  (await h.as(user, role)).post('/v1/queries', { plan, ...extra });

describe('POST /v1/queries on the Appendix A plans', () => {
  for (const c of APPENDIX_A) {
    it(`${c.id}: ${c.question}`, async () => {
      const { exportRequested: _x, ...plan } = c.expected;
      void _x;
      const r = await q(plan);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(c.check(r.body['rows'] as Record<string, unknown>[], seeded, r.body['howIGotThis'].rowCount)).toBe(true);
      expect(r.body['howIGotThis']).toMatchObject({ source: '11 Estates read model (insight)', catalogueVersion: 'v1', fallbackUsed: false });
      expect(typeof r.body['howIGotThis'].description).toBe('string');
    });
  }
});

describe('validation', () => {
  it('translates legacy terms and lists them; rejects labels as values', async () => {
    const r = await q({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'deal_type', op: 'eq', value: 'resale' }, { field: 'location', op: 'eq', value: 'powai' }] });
    expect(r.status).toBe(200);
    expect(r.body['howIGotThis'].translatedTerms).toEqual(['resale → deal_type Sale, market Secondary']);
    expect(r.body['howIGotThis'].plan.filters).toEqual(
      expect.arrayContaining([{ field: 'market', op: 'eq', value: 'Secondary' }, { field: 'location', op: 'eq', value: 'Powai' }]),
    );
    expect(r.body['rows'][0].count).toBe(4);
    const label = await q({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'deal_type', op: 'eq', value: 'For Rent' }] });
    expect(label.status).toBe(400);
    expect(label.body['code']).toBe('unknown-vocabulary-value');
  });

  it('rejects unknown plans, fields, operators, placeholders, unknown localities and data operators on business plans', async () => {
    expect((await q({ planId: 'drop_tables', templateVersion: 1 })).body['code']).toBe('plan-not-in-catalogue');
    const bad = await q({ planId: 'list_offers', templateVersion: 1, filters: [{ field: 'contact_phone', op: 'eq', value: 'x' }] });
    expect(bad.status).toBe(422);
    expect(bad.body['code']).toBe('plan-invalid');
    expect(bad.body['errors'][0].code).toBe('field-not-allowed');
    const op = await q({ planId: 'list_offers', templateVersion: 1, filters: [{ field: 'segment', op: 'gte', value: 'Commercial' }] });
    expect(op.body['errors'][0].code).toBe('op-not-allowed');
    const ph = await q({ planId: 'list_offers', templateVersion: 1, filters: [{ field: 'code', op: 'eq', value: '⟨PHONE_1⟩' }] });
    expect(ph.body['errors'][0].code).toBe('placeholder-not-allowed');
    const loc = await q({ planId: 'list_offers', templateVersion: 1, filters: [{ field: 'location', op: 'eq', value: 'Atlantis' }] });
    expect(loc.body['errors'][0].code).toBe('unknown-location');
    expect((await q({ planId: 'list_offers', templateVersion: 1 }, 'Data operator')).status).toBe(403);
    expect((await q({ planId: 'upload_quality', templateVersion: 1 }, 'Data operator')).status).toBe(200);
    const nav = await q({ planId: 'open_my_queue', templateVersion: 1 });
    expect(nav.body['code']).toBe('plan-invalid');
  });

  it('paginates lists with a keyset cursor and rejects a tampered cursor', async () => {
    const plan = { planId: 'list_offers', templateVersion: 1, filters: [{ field: 'deal_type', op: 'eq', value: 'Lease' }] };
    const seen = new Set<string>();
    let cursor: string | null | undefined = null;
    let pages = 0;
    do {
      const r = await q(plan, 'Manager', { limit: 5, cursor });
      expect(r.status).toBe(200);
      for (const row of r.body['rows']) seen.add(row.code);
      cursor = r.body['nextCursor'];
      pages++;
    } while (cursor && pages < 20);
    const total = (await q(plan)).body['howIGotThis'].rowCount;
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThan(1);
    const rows = (await q(plan, 'Manager', { limit: 100 })).body['rows'] as Record<string, unknown>[];
    expect(rows.find((r) => r['property_type'] === 'Apartment')?.['label']).toBe('For Rent');
    expect(rows.find((r) => r['property_type'] === 'Office')?.['label']).toBe('For Lease');
    expect((await q(plan, 'Manager', { cursor: 'not-a-cursor' })).status).toBe(400);
  });

  it('groups offers, restricts to "me" and keeps tenants apart (NFR-15)', async () => {
    const g = await q({ planId: 'group_offers', templateVersion: 1, groupBy: ['micromarket'], metrics: [{ fn: 'count' }] });
    expect(g.status).toBe(200);
    expect(g.body['columns'].map((c: { key: string }) => c.key)).toEqual(['micromarket', 'count']);
    const other = await (await h.as(ids(), 'Manager', randomUUID())).post('/v1/queries', { plan: { planId: 'count_offers', templateVersion: 1 } });
    expect(other.status).toBe(200);
    expect(other.body['rows'][0].count).toBe(0);
    const mine = await q({ planId: 'list_deals', templateVersion: 1, me: true });
    expect(mine.body['rows']).toHaveLength(2);
  });
});

describe('GET /v1/chat/plan-catalogue', () => {
  it('lists the templates of the caller role', async () => {
    const m = await (await h.as(ids(), 'Manager')).get('/v1/chat/plan-catalogue');
    expect(m.status).toBe(200);
    expect(m.body['catalogueVersion']).toBe('v1');
    expect((m.body['items'] ?? []).map((i) => i['planId'])).toContain('supply_demand_gap');
    const op = await (await h.as(ids(), 'Data operator')).get('/v1/chat/plan-catalogue');
    expect((op.body['items'] ?? []).map((i) => i['planId'])).toEqual(['upload_quality', 'open_my_queue', 'open_record', 'export_list']);
  });

  it('refuses a call without a staff token', async () => {
    const r = await h.app.request('/v1/chat/plan-catalogue');
    expect(r.status).toBe(401);
  });
});

describe('vocabulary-refresh', () => {
  it('fetches the release and the hierarchy for pending tenants', async () => {
    await h.deliver('vocabulary.released.v1', { version: 'v0.7-test', checksum: 'c' });
    const r = await h.cron('/internal/v1/jobs/vocabulary-refresh');
    expect(r.status).toBe(200);
    expect(recordsCalls).toContain(`vocabulary:${h.tenantId}`);
    const v = await h.rows<{ version: string }>(sql`select version from vocabulary_release where tenant_id = ${h.tenantId} and active`);
    expect(v[0]?.version).toBe('v0.7-test');
    const mm = await h.rows<{ name: string }>(sql`select name from micromarket_ref where tenant_id = ${h.tenantId}`);
    expect(mm.map((m) => m.name)).toEqual(['Powai']);
    // the new release drives validation ("Pagdi" is not in the test release)
    const pagdi = await q({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'deal_type', op: 'eq', value: 'Pagdi' }] });
    expect(pagdi.status).toBe(400);
  });
});
