// Public projection (PRD §8.3, LLD §4.7), generated labels (BRD §4.2), bands, levels, change types and ids.
import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX, PUBLIC_ID_PATTERN, apiKeyFrom, publicIdFrom } from '../../src/domain/ids.js';
import { demandLabel, headline, resolvedSegment, supplyLabel } from '../../src/domain/labels.js';
import { allowedLevels, changeType, clampToCeiling } from '../../src/domain/levels.js';
import {
  ANONYMOUS_OFFER_KEYS,
  DEMAND_POST_KEYS,
  PROJECT_KEYS,
  PUBLIC_OFFER_EXTRA_KEYS,
  budgetBand,
  contentOf,
  formatInr,
  micromarketPath,
  periodEnd,
  periodStart,
  publicDemandPost,
  publicOffer,
  publicProject,
  rentBand,
  unitsBand,
} from '../../src/domain/projection.js';
import { RERA_PENDING } from '../../src/domain/types.js';
import { demand, offer, project } from './fixtures.js';

const ctx = {
  publicId: 'L-0123456789',
  agentReraNumber: 'A51900012345',
  note: 'Details subject to confirmation',
  publishedAt: new Date('2026-09-27T10:00:00Z'),
  updatedAt: new Date('2026-09-27T11:00:00Z'),
};

describe('generated labels (BRD §4.2 table)', () => {
  it.each([
    ['Sale', 'Secondary', null, 'Resale, For Sale'],
    ['Sale', 'Primary', null, 'New Project, For Sale'],
    ['Sale', null, null, 'For Sale'],
    ['Lease', null, 'Residential', 'For Rent'],
    ['Lease', null, 'Commercial', 'For Lease'],
    ['Lease', null, null, 'For Lease'],
    ['JV', null, 'Land', 'For JV'],
    ['Pagdi', null, 'Residential', 'Pagdi, For Transfer'],
  ])('supply %s/%s/%s → %s', (d, m, s, label) => {
    expect(supplyLabel(d, m, s)).toBe(label);
  });

  it('demand labels join several deal types', () => {
    expect(demandLabel(['Sale', 'Lease'], 'Any', 'Residential')).toBe('Wants to Buy · Wants to Rent');
    expect(demandLabel(['Lease'], null, 'Commercial')).toBe('Wants to Lease');
    expect(demandLabel(['Sale'], 'Primary', null)).toBe('Wants to Buy, New Project');
  });

  it('labels are generated from stored values only (a legacy term is not a value)', () => {
    expect(supplyLabel('Rent', null, 'Residential')).toBeNull();
    expect(resolvedSegment(null, ['Office'])).toBe('Commercial');
    expect(resolvedSegment(null, ['Not a type'])).toBeNull();
  });

  it('headline', () => {
    expect(
      headline({
        bhkMin: 2,
        bhkMax: 2,
        propertyTypes: ['Apartment'],
        label: 'For Rent',
        locality: 'Andheri West',
        micromarket: 'Andheri',
      }),
    ).toBe('2 BHK Apartment · For Rent · Andheri West');
    expect(
      headline({
        bhkMin: null,
        bhkMax: null,
        propertyTypes: ['Office'],
        label: 'For Lease',
        locality: null,
        micromarket: 'BKC',
      }),
    ).toBe('Office · For Lease · BKC');
  });
});

describe('public offer shapes', () => {
  it('Anonymous carries only the PublicOfferBase allow-list: no photos, description, floor or contacts', () => {
    const p = publicOffer({
      ...ctx,
      offer: offer(),
      level: 'Anonymous',
      projectPublicId: null,
      projectReraNumber: null,
      photos: [{ url: 'https://cdn.example.com/x.jpg' }],
      staffDescription: 'x',
    });
    expect(Object.keys(p).sort()).toEqual([...ANONYMOUS_OFFER_KEYS].sort());
    expect(p['label']).toBe('For Rent');
    expect(p['salePriceInrMin']).toBeNull();
    expect(p['rentMonthlyInrMin']).toBe(45000);
    expect(JSON.stringify(p)).not.toMatch(/deposit|currentRent|INV-|propertyId|totalFloors/);
  });

  it('Public adds photos, floor band, parking, amenities, possession status and the description', () => {
    const p = publicOffer({
      ...ctx,
      offer: offer(),
      level: 'Public',
      projectPublicId: null,
      projectReraNumber: null,
      photos: [{ url: 'https://cdn.example.com/x.jpg', width: 1600, height: 1200 }],
      staffDescription: null,
    });
    expect(Object.keys(p).sort()).toEqual([...ANONYMOUS_OFFER_KEYS, ...PUBLIC_OFFER_EXTRA_KEYS].sort());
    expect(p['floorBand']).toBe('Mid');
    expect(p['description']).toContain('2 BHK Apartment');
  });

  it('agent number missing in the pilot reads "registration pending" (A7)', () => {
    const p = publicOffer({
      ...ctx,
      agentReraNumber: null,
      offer: offer(),
      level: 'Anonymous',
      projectPublicId: null,
      projectReraNumber: null,
      photos: [],
      staffDescription: null,
    });
    expect(p['agentReraNumber']).toBe(RERA_PENDING);
  });

  it('the content hash ignores timestamps only', () => {
    const a = publicOffer({
      ...ctx,
      offer: offer(),
      level: 'Anonymous',
      projectPublicId: null,
      projectReraNumber: null,
      photos: [],
      staffDescription: null,
    });
    const b = publicOffer({
      ...ctx,
      updatedAt: new Date(),
      offer: offer(),
      level: 'Anonymous',
      projectPublicId: null,
      projectReraNumber: null,
      photos: [],
      staffDescription: null,
    });
    const c = publicOffer({
      ...ctx,
      offer: offer({ rentMonthlyInrMin: 46000 }),
      level: 'Anonymous',
      projectPublicId: null,
      projectReraNumber: null,
      photos: [],
      staffDescription: null,
    });
    expect(contentOf(a)).toBe(contentOf(b));
    expect(contentOf(a)).not.toBe(contentOf(c));
  });

  it('formats prices', () => {
    expect(formatInr(1_25_00_000)).toBe('₹1.25 Cr');
    expect(formatInr(85_00_000)).toBe('₹85 L');
    expect(formatInr(45_000)).toBe('₹45,000');
  });
});

describe('projects and demand posts', () => {
  it('project with configurations and unit bands', () => {
    const cfg = offer({ dealType: 'Sale', market: 'Primary', salePriceInrMin: 1_10_00_000, unitCount: 12 });
    const p = publicProject({
      ...ctx,
      project: project(),
      configurations: [{ offer: cfg, publicId: 'L-ABCDEFGHJK', level: 'Anonymous' }],
      photos: [],
    });
    expect(Object.keys(p).sort()).toEqual([...PROJECT_KEYS].sort());
    expect(p['label']).toBe('New Project, For Sale');
    expect(p['configurations']).toEqual([
      expect.objectContaining({
        listingPublicId: 'L-ABCDEFGHJK',
        priceInrFrom: 1_10_00_000,
        unitsAvailableBand: '6-20',
      }),
    ]);
    expect([unitsBand(3), unitsBand(20), unitsBand(21), unitsBand(51), unitsBand(null)]).toEqual([
      '1-5',
      '6-20',
      '21-50',
      '50+',
      null,
    ]);
  });

  it('demand post: bands and month precision, never the exact budget', () => {
    const p = publicDemandPost({ ...ctx, demand: demand() });
    expect(Object.keys(p).sort()).toEqual([...DEMAND_POST_KEYS].sort());
    expect(p['label']).toBe('Wants to Lease');
    expect(p['rentBandMonthlyInr']).toEqual({ min: 175000, max: 275000 });
    expect(p['budgetBandInr']).toBeNull();
    expect(p['timing']).toBe('2026-12');
  });

  it('budget band worked examples (LLD §4.7)', () => {
    expect(budgetBand(84_00_000, 97_00_000)).toEqual({ min: 80_00_000, max: 1_00_00_000 });
    expect(budgetBand(1_80_00_000, 2_10_00_000)).toEqual({ min: 1_75_00_000, max: 2_25_00_000 });
    expect(budgetBand(6_40_00_000, null)).toEqual({ min: 6_00_00_000, max: 7_00_00_000 });
    expect(rentBand(42_000, 48_000)).toEqual({ min: 40_000, max: 50_000 });
    expect(rentBand(1_20_000, 1_30_000)).toEqual({ min: 1_00_000, max: 1_50_000 });
    expect(budgetBand(null, null)).toBeNull();
  });
});

describe('dates, paths, levels, ids', () => {
  it('period start and end', () => {
    expect(periodStart('2027')).toBe('2027-01-01');
    expect(periodStart('2027-06')).toBe('2027-06-01');
    expect(periodEnd('2027-02')).toBe('2027-02-28');
    expect(periodEnd('2027')).toBe('2027-12-31');
    expect(periodEnd('June')).toBeNull();
  });

  it('micromarket path includes ancestors', () => {
    expect(
      micromarketPath(['Andheri West', 'Andheri'], {
        Andheri: ['Western Suburbs'],
        'Andheri West': ['Andheri', 'Western Suburbs'],
      }),
    ).toEqual(['Andheri West', 'Andheri', 'Western Suburbs']);
  });

  it('change types (LLD §4.8)', () => {
    expect(changeType('Private', 'Anonymous', true)).toBe('published');
    expect(changeType('Anonymous', 'Public', true)).toBe('upgraded');
    expect(changeType('Public', 'Anonymous', true)).toBe('downgraded');
    expect(changeType('Public', 'Private', true)).toBe('withdrawn');
    expect(changeType('Public', 'Public', true)).toBe('updated');
    expect(changeType('Public', 'Public', false)).toBeNull();
    expect(changeType('Private', 'Private', true)).toBeNull();
  });

  it('allowed levels respect the subject type', () => {
    expect(allowedLevels('offer', 'Anonymous')).toEqual(['Private', 'Anonymous']);
    expect(allowedLevels('project', 'Public')).toEqual(['Private', 'Public']);
    expect(allowedLevels('demand_post', 'Public')).toEqual(['Private', 'Anonymous']);
    expect(clampToCeiling('project', 'Public', 'Anonymous')).toBe('Private');
  });

  it('public ids and API keys', () => {
    const id = publicIdFrom(new Uint8Array([255, 1, 2, 3, 4, 5, 6, 7]));
    expect(id).toMatch(PUBLIC_ID_PATTERN);
    const key = apiKeyFrom(new Uint8Array(96).map((_, i) => (i * 37) % 256));
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(48);
    expect(key.slice(8)).toMatch(/^[0-9A-Za-z]{40}$/);
  });
});
