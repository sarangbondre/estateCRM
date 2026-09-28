// Drains, work queue and scheduled jobs on the local stack (shared queues: assertions only on this tenant's rows).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import topology from '@11e/contracts/event-topology.json' with { type: 'json' };
import { withTransaction } from '@11e/db';
import { buildEnvelope } from '@11e/outbox';
import { eventHandlers } from '../../src/adapters/events.js';
import { runWork } from '../../src/application/work.js';
import { call, harness, offerData } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(() => h.close());

const job = (name: string) => h.app.request(`/internal/v1/jobs/${name}`, { method: 'POST', headers: h.cron });

describe('event consumers', () => {
  it('handle exactly the listings subscriptions of the event topology', () => {
    const subscribed = Object.entries(topology.routes)
      .filter(([, r]) => (r as { queues: string[] }).queues.includes('q_listings'))
      .map(([t]) => t)
      .sort();
    expect(subscribed).toHaveLength(26);
    expect(Object.keys(eventHandlers(h.deps)).sort()).toEqual(subscribed);
  });

  it('the adapter handler applies an envelope inside the drain transaction', async () => {
    const data = offerData();
    const envelope = buildEnvelope({
      eventType: 'offer.created.v1',
      tenantId: h.tenant,
      aggregateType: 'offer',
      aggregateId: data.offerId,
      aggregateVersion: 1,
      data,
      correlationId: 'test-drain',
      producer: 'records',
    });
    const handler = eventHandlers(h.deps)['offer.created.v1'];
    await withTransaction(h.deps.db, (trx) => handler!(envelope, { trx, attempt: 1 }), {
      statementTimeoutMs: 30_000,
    });
    const pub = await h.tx((s) => s.getPublication('offer', data.offerId));
    expect(pub?.level).toBe('Private');
  });
});

describe('work queue', () => {
  it('photo processing strips metadata via the processor, fails after 3 attempts', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const good = randomUUID();
    const bad = randomUUID();
    h.records.photos.set(good, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    await h.event('photo.added.v1', {
      photoId: good,
      propertyId: data.propertyId,
      origin: 'visit',
      isReal: true,
      storagePath: 'x',
      hasTextDetected: true,
    });
    await h.event('photo.added.v1', {
      photoId: bad,
      propertyId: data.propertyId,
      origin: 'upload',
      isReal: true,
      storagePath: 'y',
    });
    await runWork(h.deps.services, { kind: 'photo-process', tenantId: h.tenant, photoId: good });
    for (let i = 0; i < 2; i++)
      await expect(
        runWork(h.deps.services, { kind: 'photo-process', tenantId: h.tenant, photoId: bad }),
      ).rejects.toThrow();
    await runWork(h.deps.services, { kind: 'photo-process', tenantId: h.tenant, photoId: bad });
    const [g, b] = await h.tx((s) => s.photosByIds([good, bad]));
    const byId = new Map([g, b].map((p) => [p?.id, p]));
    expect(byId.get(good)?.status).toBe('ready');
    expect(byId.get(bad)?.status).toBe('failed');
    // C-12 shows the photo-text warning (R-8) without excluding the photo.
    await h.event('offer.updated.v1', { ...data, hasRealPhotos: true, selectedPhotoIds: [good] });
    const st = (await (
      await call(h, 'GET', `/v1/offers/${data.offerId}/publication`, await h.staff())
    ).json()) as {
      ceiling: string;
      photos: { photoId: string; publicUse: boolean; ocrStatus: string; warnings: string[] }[];
    };
    expect(st.ceiling).toBe('Public');
    expect(st.photos.find((p) => p.photoId === good)).toMatchObject({
      publicUse: true,
      ocrStatus: 'text_found',
      warnings: ['text_detected'],
    });
    expect(st.photos.find((p) => p.photoId === bad)).toMatchObject({ publicUse: false, ocrStatus: 'failed' });
    const scan = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff(), {
      level: 'Public',
    });
    expect(scan.status).toBe(200);
    expect(
      (
        (await scan.json()) as {
          lastScan: { result: string; findings: { kind: string; severity: string }[] };
        }
      ).lastScan,
    ).toMatchObject({
      result: 'warning',
      findings: [{ kind: 'photo_text', severity: 'warn' }],
    });
  });

  it('micromarket hierarchy feeds the filter paths through a projection refresh', async () => {
    const data = offerData({ locality: 'Lokhandwala', micromarket: 'Andheri West' });
    await h.event('offer.created.v1', data);
    const put = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff(), {
      level: 'Anonymous',
    });
    const { publicId } = (await put.json()) as { publicId: string };
    h.records.ancestors = {
      'Andheri West': ['Western Suburbs'],
      Lokhandwala: ['Andheri West', 'Western Suburbs'],
    };
    await runWork(h.deps.services, { kind: 'micromarkets', tenantId: h.tenant });
    await runWork(h.deps.services, { kind: 'projection-refresh', tenantId: h.tenant, after: null });
    const row = await h.deps.db
      .selectFrom('public_item')
      .select('micromarket_path')
      .where('tenant_id', '=', h.tenant)
      .where('public_id', '=', publicId)
      .executeTakeFirstOrThrow();
    expect(row.micromarket_path).toEqual(['Lokhandwala', 'Andheri West', 'Western Suburbs']);
  });
});

describe('jobs', () => {
  it('ceiling-sweep recomputes published items and audits their payloads', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff(), { level: 'Anonymous' });
    // An input changed behind the consumer's back (e.g. a missed event): the sweep catches it.
    await h.deps.db
      .updateTable('offer_input')
      .set({ life_stage: 'Expired' })
      .where('tenant_id', '=', h.tenant)
      .where('id', '=', data.offerId)
      .execute();
    // Finish any cycle a previous run left in its checkpoint, then run one full cycle.
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let i = 0; i < 200; i++) {
        const r = await job('ceiling-sweep');
        expect(r.status).toBe(200);
        if (!((await r.json()) as { more: boolean }).more) break;
      }
    }
    expect((await h.tx((s) => s.getPublication('offer', data.offerId)))?.level).toBe('Private');
  }, 180_000); // the sweep covers every tenant in the shared local DB, which grows with test runs

  it('every job of the contract enum runs', async () => {
    for (const name of [
      'projection-refresh',
      'change-feed-prune',
      'idempotency-prune',
      'rate-limit-prune',
      'api-key-expire',
    ]) {
      const r = await job(name);
      expect(r.status, name).toBe(200);
      expect(await r.json()).toMatchObject({ processed: expect.any(Number) });
    }
  });

  it('change-feed-prune removes rows older than 30 days', async () => {
    await h.deps.db
      .insertInto('change_feed')
      .values({
        tenant_id: h.tenant,
        id: randomUUID(),
        public_id: 'L-0000000000',
        subject_type: 'listing',
        change_type: 'withdrawn',
        level: null,
        occurred_at: new Date(Date.now() - 31 * 86_400_000),
      })
      .execute();
    await job('change-feed-prune');
    const left = await h.deps.db
      .selectFrom('change_feed')
      .select('id')
      .where('tenant_id', '=', h.tenant)
      .where('public_id', '=', 'L-0000000000')
      .execute();
    expect(left).toEqual([]);
  });
});
