// REC-08 contact privacy (reveals audited + rate-limited, contacts batch for insight, scan terms for listings, R-20/21)
// and REC-09 photos (signed upload, attach checks, selection, deletion, listings' signed read, sheet-link fetch).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../src/application/context.js';
import { fetchSheetPhoto, queueSheetPhotos } from '../src/application/photos.js';
import { buildingTokens } from '../src/domain/privacy.js';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { FakeImages, FakePhotoStore, png } from './support/storage.js';

const store = new FakePhotoStore();
const images = new FakeImages(new Map<string, Uint8Array | Error>([['https://img.example.com/a.png', png(800, 600, 99)]]));
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ photoStore: store, images });
});
afterAll(() => h.close());

async function supply(t: string) {
  const sup = await h.staff(t, 'Supply agent');
  const r = await h.call('POST', '/v1/properties', sup, {
    property: { segment: 'Residential', propertyTypes: ['Apartment'], locality: 'Juhu', city: 'Mumbai', buildingName: 'Sea Breeze Tower', wing: 'B', unitNo: '1203', floorNo: 12 },
    offers: [{ dealType: 'Sale', salePriceInrMin: 50_000_000 }],
    parties: [{ role: 'Seller', newPerson: { name: 'Priv Owner', phones: ['9000300001'], emails: ['priv.owner1@example.com'] } }],
  });
  const property = r.body['property'] as { id: string; parties: { personId: string }[] };
  const offer = (r.body['offers'] as { id: string }[])[0] as { id: string };
  return { sup, property, offer, personId: property.parties[0]?.personId as string };
}

describe('reveals (R-VIS-3)', () => {
  it('returns contacts once audited (field names only); an idempotent replay keeps the audit id and stores no PII', async () => {
    const t = await readyTenant(h);
    const { personId } = await supply(t);
    const op = await h.staff(t, 'Data operator');
    const key = crypto.randomUUID();
    const body = { subjectType: 'person', subjectId: personId, purpose: 'call' };
    const r = await h.call('POST', '/v1/reveals', { ...op, 'idempotency-key': key }, body);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body['fields']).toMatchObject({ name: 'Priv Owner', phones: ['+919000300001'], emails: ['priv.owner1@example.com'] });
    const again = await h.call('POST', '/v1/reveals', { ...op, 'idempotency-key': key }, body);
    expect(again.body['auditId']).toBe(r.body['auditId']);
    expect((again.body['fields'] as { name: string }).name).toBe('Priv Owner');
    const audits = await h.events(t, 'audit.recorded.v1');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.data).toMatchObject({ action: 'contact_viewed', subjectId: personId, details: { purpose: 'call', fields: 'emails,name,phones' } });
    expect(JSON.stringify(audits)).not.toContain('9000300001');
    const stored = await h.db.selectFrom('idempotency_keys').select('response_body').where('key', '=', key).executeTakeFirst();
    expect(stored?.response_body).toEqual({ auditId: r.body['auditId'] });
  });

  it('unit-level fields of a property; nothing to reveal → 400; 60 per hour → 429', async () => {
    const t = await readyTenant(h);
    const { property } = await supply(t);
    const user = crypto.randomUUID();
    const sup = await h.staff(t, 'Supply agent', user);
    const r = await h.call('POST', '/v1/reveals', sup, { subjectType: 'property', subjectId: property.id, purpose: 'visit' });
    expect(r.body['fields']).toEqual({ wing: 'B', unitNo: '1203', floorNo: 12 });
    const bare = await h.call('POST', '/v1/properties', sup, {
      property: { segment: 'Land', propertyTypes: ['Plot'], locality: 'Karjat', city: 'Karjat' },
      offers: [{ dealType: 'Sale' }],
    });
    const none = await h.call('POST', '/v1/reveals', sup, { subjectType: 'property', subjectId: (bare.body['property'] as { id: string }).id, purpose: 'other' });
    expect(none.body['code']).toBe('reveal-not-applicable');
    await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, async (tx) => {
      await tx.store.insert(
        'reveal_log',
        Array.from({ length: 59 }, () => ({ id: h.appCtx.ids.next(), user_id: user, subject_type: 'property', subject_id: property.id, purpose: 'visit', fields: ['wing'] })),
      );
    });
    const limited = await h.call('POST', '/v1/reveals', sup, { subjectType: 'property', subjectId: property.id, purpose: 'visit' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('internal endpoints', () => {
  it('contacts batch for insight only (x-callers), audited per call; purged people carry no fields', async () => {
    const t = await readyTenant(h);
    const { personId } = await supply(t);
    const body = { personIds: [personId, crypto.randomUUID()], purpose: 'export', exportId: crypto.randomUUID(), requestedBy: crypto.randomUUID() };
    expect((await h.call('POST', '/internal/v1/contacts:batch', await h.service(t, 'listings'), body)).status).toBe(403);
    const r = await h.call('POST', '/internal/v1/contacts:batch', await h.service(t, 'insight'), body);
    expect(r.status).toBe(200);
    expect(r.body['items']).toEqual([{ personId, purged: false, name: 'Priv Owner', phones: ['+919000300001'], emails: ['priv.owner1@example.com'], whatsappPhone: null }]);
    const audit = (await h.events(t, 'audit.recorded.v1'))[0];
    expect(audit?.data).toMatchObject({ action: 'contacts_exported', subjectId: body.exportId, details: { count: '1' } });
    expect((await h.call('POST', '/internal/v1/contacts:batch', await h.staff(t), body)).status).toBe(403);
  });

  it('scan terms for listings: salted hashes only', async () => {
    const t = await readyTenant(h);
    const { property } = await supply(t);
    expect((await h.call('GET', `/internal/v1/properties/${property.id}/scan-terms`, await h.service(t, 'insight'))).status).toBe(403);
    const r = await h.call('GET', `/internal/v1/properties/${property.id}/scan-terms`, await h.service(t, 'listings'));
    expect(r.status).toBe(200);
    expect(r.body['buildingTokenHashes']).toEqual(buildingTokens('Sea Breeze Tower').map((x) => h.appCtx.hash.scanTerm(x)));
    expect(JSON.stringify(r.body)).not.toMatch(/breeze|1203/i);
  });
});

describe('photos (D-5, A-26)', () => {
  it('upload → attach (checks, events, counts) → select → Verified → delete', async () => {
    const t = await readyTenant(h);
    const { sup, property, offer } = await supply(t);
    const ticket = await h.call('POST', '/v1/photos', sup, { propertyId: property.id, contentType: 'image/png', sizeBytes: 64, origin: 'visit', isReal: true });
    expect(ticket.status).toBe(201);
    const photoId = String(ticket.body['photoId']);
    expect((await h.call('POST', `/v1/photos/${photoId}/attach`, sup, {})).body['code']).toBe('photo-upload-missing');
    const [row] = await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, (tx) => tx.store.getMany('photos', [photoId]));
    store.upload(String(row?.storage_path), png(640, 480, 1));
    const attached = await h.call('POST', `/v1/photos/${photoId}/attach`, sup, {});
    expect(attached.status).toBe(200);
    expect(attached.body).toMatchObject({ status: 'ready', width: 640, height: 480, isReal: true });
    expect((await h.call('POST', `/v1/photos/${photoId}/attach`, sup, {})).status).toBe(200);
    expect(await h.events(t, 'photo.added.v1')).toHaveLength(1);
    const o = await h.call('GET', `/v1/offers/${offer.id}`, sup);
    expect(o.body['photoIds']).toEqual([photoId]);
    expect((await h.call('POST', `/v1/offers/${offer.id}/record-stage`, sup, { to: 'Verified' })).status).toBe(200);
    const list = await h.call('GET', `/v1/properties/${property.id}/photos`, sup);
    expect(String(list.body.items?.[0]?.['url'])).toContain('https://storage.example.com/read/');
    const signed = await h.call('GET', `/internal/v1/photos/${photoId}/signed-url`, await h.service(t, 'listings'));
    expect(signed.status).toBe(200);
    expect((await h.call('PUT', `/v1/offers/${offer.id}/photos`, sup, { photoIds: [] })).body['photoIds']).toEqual([]);
    expect((await h.app.request(`/v1/photos/${photoId}`, { method: 'DELETE', headers: sup })).status).toBe(204);
    expect((await h.app.request(`/v1/photos/${photoId}`, { method: 'DELETE', headers: sup })).status).toBe(204);
    expect(await h.events(t, 'photo.removed.v1')).toHaveLength(1);
    const p = await h.call('GET', `/v1/properties/${property.id}`, sup);
    expect(p.body).toMatchObject({ photoCount: 0, hasRealPhotos: false });
  });

  it('rejects non-images (415), duplicates (409) and the 31st photo (409 photo-limit-reached)', async () => {
    const t = await readyTenant(h);
    const { sup, property } = await supply(t);
    const ask = () => h.call('POST', '/v1/photos', sup, { propertyId: property.id, contentType: 'image/png', sizeBytes: 64, origin: 'upload', isReal: false });
    const place = async (id: string, bytes: Uint8Array) => {
      const [row] = await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, (tx) => tx.store.getMany('photos', [id]));
      store.upload(String(row?.storage_path), bytes);
    };
    const gif = String((await ask()).body['photoId']);
    await place(gif, new TextEncoder().encode('GIF89a-not-allowed'));
    expect((await h.call('POST', `/v1/photos/${gif}/attach`, sup, {})).status).toBe(415);
    const a = String((await ask()).body['photoId']);
    await place(a, png(10, 10, 7));
    expect((await h.call('POST', `/v1/photos/${a}/attach`, sup, {})).status).toBe(200);
    const b = String((await ask()).body['photoId']);
    await place(b, png(10, 10, 7));
    expect((await h.call('POST', `/v1/photos/${b}/attach`, sup, {})).status).toBe(409);
    for (let i = 0; i < 30; i++) {
      const r = await ask();
      if (r.status !== 201) {
        expect(r.body['code']).toBe('photo-limit-reached');
        return;
      }
    }
    throw new Error('the cap was never reached');
  });

  it('sheet-link photos are fetched by the work handler; failures never block', async () => {
    const t = await readyTenant(h);
    const { property } = await supply(t);
    const actor = systemActor(t, 'test');
    await h.appCtx.uow.run(actor, (tx) => queueSheetPhotos(h.appCtx, tx, property.id, ['https://img.example.com/a.png', 'https://img.example.com/missing.png']));
    const pending = await h.appCtx.uow.run(actor, (tx) => tx.store.find('photos', { property_id: property.id }));
    for (const p of pending) await fetchSheetPhoto(h.appCtx, actor, p.id);
    const after = await h.appCtx.uow.run(actor, (tx) => tx.store.find('photos', { property_id: property.id }));
    expect(after.map((p) => p.status).sort()).toEqual(['fetch_failed', 'ready']);
    expect(after.find((p) => p.status === 'fetch_failed')?.fetch_error).toContain('download failed');
    expect((await h.events(t, 'photo.added.v1'))[0]?.data).toMatchObject({ origin: 'sheet_link', isReal: false });
  });

  it('without storage configured the photo endpoints answer 503', async () => {
    const h2 = await createHarness();
    try {
      const t = await readyTenant(h2);
      const r = await h2.call('POST', '/v1/photos', await h2.staff(t, 'Supply agent'), {
        propertyId: crypto.randomUUID(),
        contentType: 'image/png',
        sizeBytes: 10,
        origin: 'upload',
        isReal: false,
      });
      expect(r.status).toBe(503);
      expect(r.body['code']).toBe('dependency-unavailable');
      // attach and the internal signed URL need storage too (503 declared on the photo operations, CR-012)
      const attach = await h2.call('POST', `/v1/photos/${crypto.randomUUID()}/attach`, await h2.staff(t, 'Supply agent'), {});
      expect([attach.status, attach.body['code']]).toEqual([503, 'dependency-unavailable']);
      const signed = await h2.call('GET', `/internal/v1/photos/${crypto.randomUUID()}/signed-url`, await h2.service(t, 'listings'));
      expect([signed.status, signed.body['code']]).toEqual([503, 'dependency-unavailable']);
    } finally {
      await h2.close();
    }
  });
});
