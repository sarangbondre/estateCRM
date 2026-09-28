// M8 = 0 (BRD §10, PRD US-15/US-33): an automated scan of everything the public API serves, over synthetic ads from
// libs/testing (synthetic people, phones L000NNNNNN, e-mails at example.com/in). Every ad's raw text, contacts
// included, is offered as the staff description of a Public item: the blocking scan must stop every contact, and the
// crawl of /v1/listings, details, /v1/demand-posts and /v1/changes must contain no contact detail, no exact address and
// no private building name.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPhoneLikeNumbers, generate, syntheticPerson } from '@11e/testing';
import type { ExtractorRow } from '@11e/testing';
import { runWork } from '../../src/application/work.js';
import { scanText } from '../../src/domain/privacy.js';
import {
  ANONYMOUS_OFFER_KEYS,
  DEMAND_POST_KEYS,
  PUBLIC_OFFER_EXTRA_KEYS,
} from '../../src/domain/projection.js';
import { call, harness, setAgentNumber } from '../helpers.js';
import type { Harness } from '../helpers.js';

const ROWS = 400;
const PROPERTY_DEAL_TYPES = new Set(['Sale', 'Lease', 'JV', 'Pagdi']);
const STOP = new Set([
  'chs',
  'chsl',
  'society',
  'soc',
  'ltd',
  'limited',
  'building',
  'bldg',
  'tower',
  'towers',
  'apartment',
  'apartments',
  'apts',
  'apt',
  'residency',
  'the',
  'co',
  'op',
  'housing',
  'cooperative',
  'coop',
]);

let h: Harness;
let key: string;
const persons = new Set<number>();
const buildings = new Set<string>();
let publicAttempts = 0;
let blocked = 0;
let served = '';

const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v: unknown) => (typeof v === 'string' && v ? v.split('|').map((x) => x.trim()) : undefined);

/** records' scan-term tokens of a building name (R-20): words ≥ 3 chars minus building-kind words, plus the whole. */
function buildingTokens(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return words.length > 1 ? [...words, words.join(' '), words.join('')] : words;
}

function offerFrom(row: ExtractorRow) {
  const offerId = randomUUID();
  return {
    offerId,
    code: `INV-${offerId.slice(0, 8)}`,
    propertyId: randomUUID(),
    dealType: (list(row.deal_type) ?? ['Sale'])[0] as string,
    ...(str(row.market) ? { market: str(row.market) as string } : {}),
    ...(str(row.segment) ? { segment: str(row.segment) as string } : {}),
    propertyTypes: list(row.property_type) ?? [],
    ...(num(row.bhk_min) !== undefined ? { bhkMin: num(row.bhk_min) as number } : {}),
    ...(num(row.bhk_max) !== undefined ? { bhkMax: num(row.bhk_max) as number } : {}),
    ...(num(row.area_sqft_min) !== undefined ? { areaSqftMin: num(row.area_sqft_min) as number } : {}),
    ...(num(row.area_sqft_max) !== undefined ? { areaSqftMax: num(row.area_sqft_max) as number } : {}),
    ...(num(row.sale_price_inr_min) !== undefined
      ? { salePriceInrMin: num(row.sale_price_inr_min) as number }
      : {}),
    ...(num(row.sale_price_inr_max) !== undefined
      ? { salePriceInrMax: num(row.sale_price_inr_max) as number }
      : {}),
    ...(num(row.rent_monthly_inr_min) !== undefined
      ? { rentMonthlyInrMin: num(row.rent_monthly_inr_min) as number }
      : {}),
    ...(num(row.rent_monthly_inr_max) !== undefined
      ? { rentMonthlyInrMax: num(row.rent_monthly_inr_max) as number }
      : {}),
    ...(num(row.deposit_inr) !== undefined ? { depositInr: num(row.deposit_inr) as number } : {}),
    ...(num(row.current_rent_inr) !== undefined
      ? { currentRentInr: num(row.current_rent_inr) as number }
      : {}),
    ...(str(row.locality) ? { locality: str(row.locality) as string } : {}),
    ...(str(row.city) ? { city: str(row.city) as string } : {}),
    ...(str(row.furnishing) ? { furnishing: str(row.furnishing) as string } : {}),
    ...(str(row.possession_status) ? { possessionStatus: str(row.possession_status) as string } : {}),
    recordStage: 'Verified' as const,
    hasRealPhotos: false,
  };
}

beforeAll(async () => {
  h = await harness();
  await setAgentNumber(h);
  key = (
    (await (
      await call(h, 'POST', '/v1/api-keys', await h.staff(), {
        name: 'm8-crawler',
        rateLimitRps: 50,
        burst: 100,
      })
    ).json()) as { secret: string }
  ).secret;
  const staff = await h.staff('Supply agent');
  const supply: { data: ReturnType<typeof offerFrom>; raw: string | undefined; i: number }[] = [];
  let i = 0;
  for (const { row, meta } of generate({ rows: ROWS, seed: 8 })) {
    if (meta.error || row.record_scope !== 'Property' || !list(row.property_type)) continue;
    const dealType = (list(row.deal_type) ?? [])[0];
    if (!dealType || !PROPERTY_DEAL_TYPES.has(dealType)) continue;
    if (meta.personIndex !== null) persons.add(meta.personIndex);
    i++;
    if (row.side === 'Demand') {
      const demandId = randomUUID();
      await h.event('demand.created.v1', {
        demandId,
        code: `DEM-${demandId.slice(0, 8)}`,
        dealTypes: list(row.deal_type) ?? [dealType],
        ...(str(row.segment) ? { segment: str(row.segment) as string } : {}),
        propertyTypes: list(row.property_type) ?? [],
        micromarkets: str(row.locality) ? [str(row.locality) as string] : [],
        ...(num(row.sale_price_inr_max) !== undefined
          ? { budgetInrMax: num(row.sale_price_inr_max) as number }
          : {}),
        ...(num(row.rent_monthly_inr_max) !== undefined
          ? { rentMonthlyInrMax: num(row.rent_monthly_inr_max) as number }
          : {}),
      });
      await h.event(
        'demand.sourcing_started.v1',
        { demandId, postAnonymously: true },
        { producer: 'journeys' },
      );
      continue;
    }
    if (row.side !== 'Supply') continue;
    // Pass 1: records has every building's scan terms before anything is published (as in production).
    const data = offerFrom(row);
    await h.event('offer.created.v1', data);
    const building = str(row.project_name);
    if (building) {
      buildings.add(building);
      h.records.terms.set(
        data.propertyId,
        buildingTokens(building).map((token) => ({ kind: 'building' as const, token })),
      );
      await runWork(h.deps.services, { kind: 'scan-terms', tenantId: h.tenant, propertyId: data.propertyId });
    }
    supply.push({ data, raw: str(row.raw_text), i });
  }

  // Pass 2: publish.
  for (const { data, raw, i } of supply) {
    if (i % 2 === 0 && raw) {
      // Public with the ad's own text as the staff description (the worst case for M8).
      const photoId = randomUUID();
      h.records.photos.set(photoId, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      await h.event('photo.added.v1', {
        photoId,
        propertyId: data.propertyId,
        origin: 'upload',
        isReal: true,
        storagePath: `s/${photoId}`,
      });
      await runWork(h.deps.services, { kind: 'photo-process', tenantId: h.tenant, photoId });
      await h.event('offer.updated.v1', { ...data, hasRealPhotos: true, selectedPhotoIds: [photoId] });
      publicAttempts++;
      const r = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, staff, {
        level: 'Public',
        publicDescription: raw.slice(0, 2000),
      });
      if (r.status === 422) {
        blocked++;
        // Fall back to the generated description, as staff would after rewording.
        await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, staff, {
          level: 'Public',
          publicDescription: null,
        });
      } else expect([200, 409]).toContain(r.status);
      await runWork(h.deps.services, { kind: 'photo-publish', tenantId: h.tenant, photoId });
    } else {
      const r = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, staff, { level: 'Anonymous' });
      // 409: never publishable (e.g. outside the launch area); 422 only for a missing project RERA number.
      if (r.status === 422)
        expect(((await r.clone().json()) as { code: string }).code, await r.text()).toBe('rera-missing');
      else expect([200, 409]).toContain(r.status);
    }
  }

  // Crawl everything the website can read, honouring 429 Retry-After like the website would.
  const out: string[] = [];
  const fetchPublic = async (path: string): Promise<Response> => {
    for (;;) {
      const r = await h.app.request(path, { headers: { 'x-api-key': key } });
      if (r.status !== 429) return r;
      await new Promise((ok) => setTimeout(ok, Number(r.headers.get('retry-after') ?? 1) * 1000));
    }
  };
  const crawl = async (path: string) => {
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const r = await fetchPublic(
        `${path}${path.includes('?') ? '&' : '?'}limit=50${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(r.status).toBe(200);
      const text = await r.text();
      out.push(text);
      const body = JSON.parse(text) as { items: { publicId: string }[]; nextCursor: string | null };
      if (path === '/v1/listings')
        for (const item of body.items)
          out.push(await (await fetchPublic(`/v1/listings/${item.publicId}`)).text());
      cursor = body.nextCursor;
      if (!cursor) break;
    }
  };
  await crawl('/v1/listings');
  await crawl('/v1/demand-posts');
  out.push(
    await (
      await fetchPublic(
        `/v1/changes?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&limit=100`,
      )
    ).text(),
  );
  served = out.join('\n');
}, 300_000);
afterAll(() => h.close());

describe('M8: 0 PII in API output', () => {
  it('served a meaningful synthetic set and blocked every contact-bearing description', () => {
    process.stderr.write(
      `M8 scan: ${publicAttempts} Public attempts with raw ad text, ${blocked} blocked, ${persons.size} synthetic people, ${buildings.size} buildings, ${served.length} bytes served\n`,
    );
    expect(publicAttempts).toBeGreaterThan(20);
    expect(blocked).toBeGreaterThan(10);
    expect(served.length).toBeGreaterThan(10_000);
  });

  it('contains no phone number in any written form', () => {
    expect(findPhoneLikeNumbers(served)).toEqual([]);
    const digits = served.replace(/[^\d\n"]/g, '');
    for (const p of persons) {
      for (const phone of syntheticPerson(p).phones) {
        const national = phone.slice(3);
        expect(served.includes(national)).toBe(false);
        expect(digits.includes(national)).toBe(false);
        expect(served.includes(`${national.slice(0, 5)} ${national.slice(5)}`)).toBe(false);
        expect(served.includes(`${national.slice(0, 5)}-${national.slice(5)}`)).toBe(false);
      }
    }
  });

  it('contains no e-mail, handle or URL other than the photo CDN', () => {
    expect(served).not.toMatch(/@/);
    expect(served.replace(/https:\/\/cdn\.example\.com\/[^"]+/g, '')).not.toMatch(/https?:\/\/|www\./i);
    for (const p of persons) expect(served.toLowerCase().includes(syntheticPerson(p).email)).toBe(false);
  });

  it('contains no contact name and no private building name', () => {
    for (const p of persons) expect(served.includes(syntheticPerson(p).name)).toBe(false);
    for (const b of buildings)
      for (const token of buildingTokens(b).filter((t) => t.length >= 6))
        expect(served.toLowerCase()).not.toContain(token);
  });

  it('passes the §4.4 patterns on every served string and only allow-listed keys are served', () => {
    const allowed = new Set<string>([
      ...ANONYMOUS_OFFER_KEYS,
      ...PUBLIC_OFFER_EXTRA_KEYS,
      ...DEMAND_POST_KEYS,
    ]);
    const ids = new Set(['A51900012345']);
    const walk = (v: unknown, path: string) => {
      // Photo CDN URLs and ISO timestamps are generated by listings, not text.
      if (typeof v === 'string' && !path.endsWith('.url') && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) {
        const hits = scanText({ text: v, allowIds: ids }).filter((f) => f.severity === 'block');
        expect(hits, `${path}: ${hits.map((x) => x.kind).join(',')}`).toEqual([]);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    for (const chunk of served.split('\n')) {
      const body = JSON.parse(chunk) as { items?: Record<string, unknown>[] } & Record<string, unknown>;
      const items = body.items ?? [body];
      for (const item of items) {
        if (!('changeType' in item)) for (const k of Object.keys(item)) expect(allowed.has(k), k).toBe(true);
        walk(item, 'item');
      }
    }
  });
});
