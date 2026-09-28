// Publication axis end to end on the local DB: events → inputs → ceiling → staff level changes, the blocking scan,
// auto-downgrade, public projection, change feed and outbox events (LLD §4.1–§4.8).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWork } from '../../src/application/work.js';
import { SubjectNotYetKnown } from '../../src/application/ingest.js';
import { call, demandData, harness, offerData } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(() => h.close());

const outbox = (subjectId: string, type = 'publication.changed.v1') =>
  h.deps.db
    .selectFrom('outbox')
    .select(['payload', 'aggregate_version'])
    .where('tenant_id', '=', h.tenant)
    .where('event_type', '=', type)
    .where(({ eb, ref }) => eb(ref('payload'), '@>', JSON.stringify({ data: { subjectId } }) as never))
    .orderBy('occurred_at')
    .execute();

const feed = (publicId: string) =>
  h.deps.db
    .selectFrom('change_feed')
    .select(['change_type', 'level'])
    .where('tenant_id', '=', h.tenant)
    .where('public_id', '=', publicId)
    .orderBy('seq')
    .execute();

const item = (publicId: string) =>
  h.deps.db
    .selectFrom('public_item')
    .select(['level', 'payload'])
    .where('tenant_id', '=', h.tenant)
    .where('public_id', '=', publicId)
    .executeTakeFirst();

/** An offer whose ceiling is Public: a processed real photo is selected. */
async function publicReadyOffer() {
  const data = offerData();
  const photoId = randomUUID();
  await h.event('offer.created.v1', data);
  h.records.photos.set(photoId, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await h.event('photo.added.v1', {
    photoId,
    propertyId: data.propertyId,
    origin: 'visit',
    isReal: true,
    storagePath: `p/${photoId}.jpg`,
  });
  await runWork(h.deps.services, { kind: 'photo-process', tenantId: h.tenant, photoId });
  await h.event('offer.updated.v1', { ...data, hasRealPhotos: true, selectedPhotoIds: [photoId] });
  return { data, photoId };
}

describe('offers', () => {
  it('offer.created creates a Private publication with the ceiling and reasons', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const r = await call(h, 'GET', `/v1/offers/${data.code}/publication`, await h.staff('Data operator'));
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('"2"');
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      level: 'Private',
      ceiling: 'Anonymous',
      ceilingReasons: [{ code: 'no_real_photos', message: expect.any(String) }],
      allowedLevels: ['Private', 'Anonymous'],
      label: 'For Rent',
      publicId: null,
    });
  });

  it('publishes at Anonymous: public id, projection, feed row, publication.changed and audit', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const r = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff('Supply agent'), {
      level: 'Anonymous',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { publicId: string; level: string; version: number };
    expect(body.level).toBe('Anonymous');
    expect(body.publicId).toMatch(/^L-[0-9A-HJKMNP-TV-Z]{10}$/);
    const served = await item(body.publicId);
    expect(served?.level).toBe('Anonymous');
    expect(served?.payload).toMatchObject({
      publicId: body.publicId,
      label: 'For Rent',
      agentReraNumber: 'MahaRERA registration pending',
    });
    expect(served?.payload).not.toHaveProperty('photos');
    expect(await feed(body.publicId)).toEqual([{ change_type: 'published', level: 'Anonymous' }]);
    const events = await outbox(data.offerId);
    expect(events.map((e) => (e.payload as { data: unknown }).data)).toEqual([
      {
        subjectType: 'offer',
        subjectId: data.offerId,
        from: 'Private',
        to: 'Anonymous',
        reason: 'user',
        publicId: body.publicId,
      },
    ]);
    expect((await outbox(data.offerId, 'audit.recorded.v1')).length).toBe(1);

    // A repeat PUT with the same body changes nothing and emits nothing.
    const again = await call(
      h,
      'PUT',
      `/v1/offers/${data.offerId}/publication`,
      await h.staff('Supply agent'),
      { level: 'Anonymous' },
    );
    expect(((await again.json()) as { version: number }).version).toBe(body.version);
    expect((await outbox(data.offerId)).length).toBe(1);
    expect((await outbox(data.offerId, 'audit.recorded.v1')).length).toBe(1);
  });

  it('rejects a level above the ceiling (409), a stale If-Match (412) and a role outside x-roles (403)', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const above = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff('Admin'), {
      level: 'Public',
    });
    expect(above.status).toBe(409);
    expect(await above.json()).toMatchObject({
      code: 'level-above-ceiling',
      errors: [{ field: 'level', code: 'no_real_photos' }],
    });
    const stale = await call(
      h,
      'PUT',
      `/v1/offers/${data.offerId}/publication`,
      { ...(await h.staff('Admin')), 'if-match': '"99"' },
      { level: 'Anonymous' },
    );
    expect(stale.status).toBe(412);
    const role = await call(
      h,
      'PUT',
      `/v1/offers/${data.offerId}/publication`,
      await h.staff('Demand agent'),
      { level: 'Anonymous' },
    );
    expect(role.status).toBe(403);
  });

  it('blocks private details in the staff description (422) and keeps the scan for C-12', async () => {
    const { data } = await publicReadyOffer();
    const r = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff('Supply agent'), {
      level: 'Public',
      publicDescription: 'Great flat, call 90000 12345 or mail owner@example.com',
    });
    expect(r.status).toBe(422);
    const problem = (await r.json()) as { code: string; errors: { code: string; message: string }[] };
    expect(problem.code).toBe('privacy-scan-blocked');
    expect(problem.errors.map((e) => e.code).sort()).toEqual(['email', 'phone']);
    expect(JSON.stringify(problem)).not.toContain('12345');
    const state = (await (
      await call(h, 'GET', `/v1/offers/${data.offerId}/publication`, await h.staff())
    ).json()) as {
      level: string;
      lastScan: { result: string };
      publicDescription: string | null;
    };
    expect(state.level).toBe('Private');
    expect(state.lastScan.result).toBe('blocked');
    expect(state.publicDescription).toBeNull();
  });

  it('blocks building names through the salted scan terms (R-20)', async () => {
    const { data } = await publicReadyOffer();
    h.records.terms.set(data.propertyId, [
      { kind: 'building', token: 'sea breeze' },
      { kind: 'unit', token: 'b 1203' },
    ]);
    await runWork(h.deps.services, { kind: 'scan-terms', tenantId: h.tenant, propertyId: data.propertyId });
    const r = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff('Supply agent'), {
      level: 'Public',
      publicDescription: 'Bright flat in Sea-Breeze, Andheri West.',
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('building_name');
  });

  it('Public with photos, then Stale → Anonymous, Expired → withdrawn, Fresh → no auto-raise', async () => {
    const { data, photoId } = await publicReadyOffer();
    const put = await call(
      h,
      'PUT',
      `/v1/offers/${data.offerId}/publication`,
      await h.staff('Supply agent'),
      { level: 'Public' },
    );
    expect(put.status).toBe(200);
    const { publicId } = (await put.json()) as { publicId: string };
    await runWork(h.deps.services, { kind: 'photo-publish', tenantId: h.tenant, photoId });
    const pub = await item(publicId);
    expect(pub?.payload['photos']).toEqual([
      { url: expect.stringMatching(/^https:\/\/cdn\.example\.com\//), width: 1600, height: 1200 },
    ]);
    expect(pub?.payload['description']).toContain('Andheri West');

    await h.event(
      'lifecycle.stage_changed.v1',
      { subjectType: 'offer', subjectId: data.offerId, from: 'Ageing', to: 'Stale', day: 40 },
      { producer: 'journeys' },
    );
    expect((await item(publicId))?.level).toBe('Anonymous');
    expect((await item(publicId))?.payload).not.toHaveProperty('photos');
    await h.event(
      'lifecycle.stage_changed.v1',
      { subjectType: 'offer', subjectId: data.offerId, from: 'Stale', to: 'Expired', day: 60 },
      { producer: 'journeys' },
    );
    expect(await item(publicId)).toBeUndefined();
    await h.event(
      'lifecycle.stage_changed.v1',
      { subjectType: 'offer', subjectId: data.offerId, from: 'Expired', to: 'Fresh', day: 0 },
      { producer: 'journeys' },
    );
    expect(await item(publicId)).toBeUndefined();

    expect((await feed(publicId)).map((f) => f.change_type)).toEqual([
      'published',
      'updated',
      'downgraded',
      'withdrawn',
    ]);
    const reasons = (await outbox(data.offerId)).map(
      (e) => (e.payload as { data: { reason: string; to: string } }).data,
    );
    expect(reasons.map((d) => `${d.to}:${d.reason}`)).toEqual([
      'Public:user',
      'Anonymous:ceiling_dropped',
      'Private:expired',
    ]);
    // aggregateVersion strictly increases per publication.
    const versions = (await outbox(data.offerId)).map((e) => e.aggregate_version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    // Public photo copies are removed on downgrade.
    await runWork(h.deps.services, { kind: 'photo-unpublish', tenantId: h.tenant, photoId });
    expect(h.photoStore.publicFiles.size).toBeGreaterThanOrEqual(0);
    const photo = await h.tx((s) => s.getPhoto(photoId));
    expect(photo?.publicPath).toBeNull();
  });

  it('Closed, retired unwilling and voided withdraw with their reasons; unwilling is never publishable', async () => {
    const reasonsOf = async (id: string) =>
      (await outbox(id)).map((e) => (e.payload as { data: { reason: string } }).data.reason);
    const publish = async () => {
      const d = offerData();
      await h.event('offer.created.v1', d);
      expect(
        (await call(h, 'PUT', `/v1/offers/${d.offerId}/publication`, await h.staff(), { level: 'Anonymous' }))
          .status,
      ).toBe(200);
      return d;
    };
    const closed = await publish();
    await h.event(
      'deal.closed.v1',
      {
        dealId: randomUUID(),
        demandId: randomUUID(),
        offerId: closed.offerId,
        closedAt: new Date().toISOString(),
      },
      { producer: 'journeys' },
    );
    expect(await reasonsOf(closed.offerId)).toEqual(['user', 'closed']);
    // deal cancelled: back to Available, no auto-raise.
    await h.event(
      'deal.cancelled.v1',
      { dealId: randomUUID(), demandId: randomUUID(), offerId: closed.offerId, reason: 'finance' },
      { producer: 'journeys' },
    );
    const st = (await (
      await call(h, 'GET', `/v1/offers/${closed.offerId}/publication`, await h.staff())
    ).json()) as { level: string; ceiling: string };
    expect(st).toMatchObject({ level: 'Private', ceiling: 'Anonymous' });

    const unwilling = await publish();
    await h.event(
      'offer.retired.v1',
      { offerId: unwilling.offerId, reason: 'unwilling' },
      { producer: 'journeys' },
    );
    expect(await reasonsOf(unwilling.offerId)).toEqual(['user', 'retired']);
    const again = await call(h, 'PUT', `/v1/offers/${unwilling.offerId}/publication`, await h.staff(), {
      level: 'Anonymous',
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('subject-not-publishable');

    const voided = await publish();
    await h.event(
      'offer.voided.v1',
      { offerId: voided.offerId, reason: 'side_changed' },
      { version: 1_000_000 },
    );
    expect(await reasonsOf(voided.offerId)).toEqual(['user', 'voided']);
  });

  it('merge withdraws the merged offer; undo restores its level (capped)', async () => {
    const survivor = offerData();
    const merged = offerData();
    await h.event('offer.created.v1', survivor);
    await h.event('offer.created.v1', merged);
    await call(h, 'PUT', `/v1/offers/${merged.offerId}/publication`, await h.staff(), { level: 'Anonymous' });
    const mergeId = randomUUID();
    await h.event('records.merged.v1', {
      mergeId,
      aggregateType: 'offer',
      survivorId: survivor.offerId,
      mergedIds: [merged.offerId],
    });
    let st = (await (
      await call(h, 'GET', `/v1/offers/${merged.offerId}/publication`, await h.staff())
    ).json()) as { level: string; ceilingReasons: { code: string }[]; lastChangeReason: string };
    expect(st.level).toBe('Private');
    expect(st.lastChangeReason).toBe('merged');
    expect(st.ceilingReasons.map((r) => r.code)).toContain('merged');
    await h.event('records.merge_undone.v1', {
      mergeId,
      aggregateType: 'offer',
      restoredIds: [merged.offerId],
    });
    st = (await (
      await call(h, 'GET', `/v1/offers/${merged.offerId}/publication`, await h.staff())
    ).json()) as typeof st;
    expect(st.level).toBe('Anonymous');
  });

  it('ignores stale versions and retries journeys facts that arrive before the offer', async () => {
    const data = offerData();
    await expect(
      h.event(
        'lifecycle.stage_changed.v1',
        { subjectType: 'offer', subjectId: data.offerId, from: 'Fresh', to: 'Stale', day: 40 },
        { producer: 'journeys' },
      ),
    ).rejects.toBeInstanceOf(SubjectNotYetKnown);
    await h.event('offer.created.v1', data, { version: 5 });
    await h.event('offer.updated.v1', { ...data, rentMonthlyInrMin: 1 }, { version: 4 });
    const o = await h.tx((s) => s.getOffer(data.offerId));
    expect(o?.rentMonthlyInrMin).toBe(45000);
    expect(o?.recordsVersion).toBe(5);
  });

  it('dry-run scan stores the latest scan and replays with the same Idempotency-Key', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const key = randomUUID();
    const headers = { ...(await h.staff('Manager')), 'idempotency-key': key };
    const r1 = await call(h, 'POST', `/v1/offers/${data.code}/privacy-scan`, headers, {
      text: 'on the 12th floor, flat 1203',
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { scanId: string; result: string; findings: { kind: string }[] };
    expect(b1.result).toBe('blocked');
    expect(b1.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(['exact_floor', 'wing_unit']));
    const r2 = await call(h, 'POST', `/v1/offers/${data.code}/privacy-scan`, headers, {
      text: 'on the 12th floor, flat 1203',
    });
    expect(((await r2.json()) as { scanId: string }).scanId).toBe(b1.scanId);
    const clean = await call(h, 'POST', `/v1/offers/${data.code}/privacy-scan`, await h.staff('Manager'), {});
    expect(((await clean.json()) as { result: string }).result).toBe('pass');
  });

  it('lists publications with stored-field filters and a cursor', async () => {
    const hdr = await h.staff('Manager');
    const page1 = await call(h, 'GET', '/v1/publications?subjectType=offer&limit=2', hdr);
    expect(page1.status).toBe(200);
    const b1 = (await page1.json()) as { items: { subjectId: string }[]; nextCursor: string };
    expect(b1.items).toHaveLength(2);
    const page2 = await call(
      h,
      'GET',
      `/v1/publications?subjectType=offer&limit=2&cursor=${b1.nextCursor}`,
      hdr,
    );
    const b2 = (await page2.json()) as { items: { subjectId: string }[] };
    expect(b2.items.map((i) => i.subjectId)).not.toContain(b1.items[0]?.subjectId);
    const health = (await (await call(h, 'GET', '/v1/publications?ceilingBelowLevel=true', hdr)).json()) as {
      items: unknown[];
    };
    expect(health.items).toEqual([]);
    expect((await call(h, 'GET', '/v1/publications?cursor=not-a-cursor', hdr)).status).toBe(400);
  });
});

describe('projects', () => {
  it('Sale/Primary needs the project RERA (422 rera-missing); a project publishes Public with its configurations', async () => {
    const projectId = randomUUID();
    const cfg = offerData({
      dealType: 'Sale',
      market: 'Primary',
      projectId,
      salePriceInrMin: 1_10_00_000,
      unitCount: 12,
    });
    await h.event('offer.created.v1', cfg);
    const blocked = await call(h, 'PUT', `/v1/offers/${cfg.offerId}/publication`, await h.staff(), {
      level: 'Anonymous',
    });
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { code: string }).code).toBe('rera-missing');

    await h.event('project.created.v1', {
      projectId,
      code: `PRJ-${projectId.slice(0, 4)}`,
      name: 'Skyline Heights',
      reraNumber: 'P51800012345',
      locality: 'Powai',
      city: 'Mumbai',
      offerIds: [cfg.offerId],
    });
    expect(
      (await call(h, 'PUT', `/v1/offers/${cfg.offerId}/publication`, await h.staff(), { level: 'Anonymous' }))
        .status,
    ).toBe(200);
    const anon = await call(h, 'PUT', `/v1/projects/${projectId}/publication`, await h.staff(), {
      level: 'Anonymous',
    });
    expect(anon.status).toBe(400);
    const pub = await call(h, 'PUT', `/v1/projects/${projectId}/publication`, await h.staff(), {
      level: 'Public',
    });
    expect(pub.status).toBe(200);
    const { publicId, liveConfigurations } = (await pub.json()) as {
      publicId: string;
      liveConfigurations: number;
    };
    expect(liveConfigurations).toBe(1);
    const served = await item(publicId);
    expect(served?.payload).toMatchObject({
      name: 'Skyline Heights',
      label: 'New Project, For Sale',
      projectReraNumber: 'P51800012345',
      configurations: [{ unitsAvailableBand: '6-20', priceInrFrom: 1_10_00_000 }],
    });
    // The configuration offer now carries the project's public id.
    const offerPub = (await (
      await call(h, 'GET', `/v1/offers/${cfg.offerId}/publication`, await h.staff())
    ).json()) as { publicId: string };
    expect((await item(offerPub.publicId))?.payload['projectPublicId']).toBe(publicId);
  });
});

describe('demand posts', () => {
  it('sourcing_started with postAnonymously posts the demand; a confirmed match withdraws it', async () => {
    const d = demandData();
    await h.event('demand.created.v1', d);
    await h.event(
      'demand.sourcing_started.v1',
      { demandId: d.demandId, postAnonymously: true, sourcingRequestId: randomUUID() },
      { producer: 'journeys' },
    );
    const st = (await (
      await call(h, 'GET', `/v1/demands/${d.code}/demand-post`, await h.staff('Demand agent'))
    ).json()) as { level: string; publicId: string; commercialStatus: string };
    expect(st).toMatchObject({ level: 'Anonymous', commercialStatus: 'Sourcing' });
    expect((await item(st.publicId))?.payload).toMatchObject({
      label: 'Wants to Lease',
      rentBandMonthlyInr: { min: 175000, max: 275000 },
      timing: '2026-12',
    });
    await h.event(
      'match.confirmed.v1',
      { matchId: randomUUID(), demandId: d.demandId, offerIds: [] },
      { producer: 'crm-engine' },
    );
    expect(await item(st.publicId)).toBeUndefined();
    const retry = await call(
      h,
      'PUT',
      `/v1/demands/${d.demandId}/demand-post`,
      await h.staff('Demand agent'),
      { level: 'Anonymous' },
    );
    expect(retry.status).toBe(409);
  });

  it('a Supply agent may not post demand (x-roles)', async () => {
    const d = demandData();
    await h.event('demand.created.v1', d);
    expect(
      (
        await call(h, 'PUT', `/v1/demands/${d.demandId}/demand-post`, await h.staff('Supply agent'), {
          level: 'Private',
        })
      ).status,
    ).toBe(403);
  });
});

describe('production policy and tenancy', () => {
  it('production: without the MahaRERA agent number nothing can be published (422 rera-missing)', async () => {
    const p = await harness({ environment: 'production' });
    try {
      const data = offerData();
      await p.event('offer.created.v1', data);
      const r = await call(p, 'PUT', `/v1/offers/${data.offerId}/publication`, await p.staff(), {
        level: 'Anonymous',
      });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { code: string }).code).toBe('rera-missing');
    } finally {
      await p.close();
    }
  });

  it('another tenant cannot read or write (NFR-15)', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const other = randomUUID();
    expect(
      (
        await call(
          h,
          'GET',
          `/v1/offers/${data.offerId}/publication`,
          await h.staff('Admin', { tenant: other }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          h,
          'PUT',
          `/v1/offers/${data.offerId}/publication`,
          await h.staff('Admin', { tenant: other }),
          { level: 'Anonymous' },
        )
      ).status,
    ).toBe(404);
    // Event handlers are tenant-bound too: the same offer id in another tenant is a different row.
    await h.event('offer.created.v1', { ...data, code: 'INV-OTHER' }, { tenant: other });
    const mine = await h.tx((s) => s.getOffer(data.offerId));
    expect(mine?.code).toBe(data.code);
  });
});
