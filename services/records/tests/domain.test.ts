// Domain rules (pure): codes, normalisation, phones, labels, record axis, dedup scoring, launch area, routing,
// merge/undo, privacy helpers, micromarket alias resolution.
import { describe, expect, it } from 'vitest';
import { formatCode, parseIdOrCode } from '../src/domain/codes.js';
import {
  DEMAND_THRESHOLDS,
  demandDecision,
  propertyDecision,
  rankProperties,
  scoreDemand,
  scoreProperty,
} from '../src/domain/dedup.js';
import type { DemandFacts, PropertyFacts } from '../src/domain/dedup.js';
import type { RecordsError } from '../src/domain/errors.js';
import { demandLabel, offerLabel } from '../src/domain/labels.js';
import { demandOutside, launchAreaVerdict } from '../src/domain/launch-area.js';
import { assertMergeAllowed, fillBlanks, planUndo, sameValue } from '../src/domain/merge.js';
import { MicromarketIndex } from '../src/domain/micromarket-index.js';
import { maskPhone, normaliseEmail, normalisePhone } from '../src/domain/phone.js';
import { buildingTokens, imageSize, sniffImage, unitTokens } from '../src/domain/privacy.js';
import { floorBand, parseFloor, possessionDateStart, priceGapPct } from '../src/domain/property.js';
import { decideDemandStage, decideOfferStage, liftOfferStage } from '../src/domain/record-stage.js';
import { routeRow, splitOfferPrices } from '../src/domain/routing.js';
import { buildingNorm, initials, norm } from '../src/domain/text.js';
import { VocabularyIndex, assertRanges } from '../src/domain/vocabulary.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as RecordsError).code;
  }
  return 'no-error';
};

describe('codes', () => {
  it('pads per prefix and grows past the pad', () => {
    expect(formatCode('PRP', 210)).toBe('PRP-00210');
    expect(formatCode('DEM', 127)).toBe('DEM-000127');
    expect(formatCode('PRJ', 123456)).toBe('PRJ-123456');
  });
  it('recognises ids and codes of the expected kind', () => {
    expect(parseIdOrCode('INV-00452', ['INV'])).toEqual({ code: 'INV-00452' });
    expect(parseIdOrCode('DEM-1', ['INV'])).toBeNull();
    expect(parseIdOrCode('0192C0DE-0000-7000-8000-000000000000', ['INV'])).toEqual({ id: '0192c0de-0000-7000-8000-000000000000' });
    expect(parseIdOrCode('nope', ['INV'])).toBeNull();
  });
});

describe('text', () => {
  it('normalises and strips building-kind words', () => {
    expect(norm('  Sea-Breeze   CHS, Ltd. ')).toBe('sea breeze chs ltd');
    expect(buildingNorm('Sea Breeze Co-op Housing Society')).toBe('sea breeze');
    expect(buildingNorm('Tower')).toBeNull();
    expect(initials('sanjay kumar')).toBe('S. K.');
    expect(initials('')).toBeNull();
  });
});

describe('phones', () => {
  it('normalises Indian numbers to E.164', () => {
    expect(normalisePhone('98200 00123')).toBe('+919820000123');
    expect(normalisePhone('+91 98200-00123')).toBe('+919820000123');
    expect(normalisePhone('09820000123')).toBe('+919820000123');
    expect(normalisePhone('919820000123')).toBe('+919820000123');
    expect(normalisePhone('0044 20 7946 0000')).toBe('+442079460000');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('call me')).toBeNull();
  });
  it('masks as +91 98•••••421', () => {
    expect(maskPhone('+919812345421')).toBe('+91 98•••••421');
  });
  it('normalises e-mail', () => {
    expect(normaliseEmail(' A.B@Example.COM ')).toBe('a.b@example.com');
    expect(normaliseEmail('nope')).toBeNull();
  });
});

describe('labels (BRD §4.2, generated)', () => {
  it('offer labels', () => {
    expect(offerLabel('Lease', null, 'Residential')).toBe('For Rent');
    expect(offerLabel('Sale', null, 'Commercial')).toBe('For Sale');
  });
  it('demand labels, one per deal type', () => {
    expect(demandLabel(['Sale'], 'Primary', 'Residential')).toBe('Wants to Buy, New Project');
    expect(demandLabel(['Sale', 'Lease'], null, 'Residential')).toContain(' / ');
  });
});

describe('record axis (LLD §4.10)', () => {
  it('forward moves by agents, skipping allowed', () => {
    expect(decideOfferStage('Captured', 'Contacted', 'Supply agent', false)).toEqual({ kind: 'move', from: 'Captured', to: 'Contacted' });
  });
  it('backward moves need Admin/Manager', () => {
    expect(code(() => decideOfferStage('Contacted', 'Enriched', 'Supply agent', false))).toBe('invalid-stage-transition');
    expect(decideOfferStage('Contacted', 'Enriched', 'Manager', false).kind).toBe('move');
  });
  it('Verified (or beyond) needs a real photo', () => {
    expect(code(() => decideOfferStage('Contacted', 'Verified', 'Admin', false))).toBe('verification-needs-real-photos');
    expect(code(() => decideOfferStage('Contacted', 'Qualified', 'Admin', false))).toBe('verification-needs-real-photos');
    expect(decideOfferStage('Contacted', 'Verified', 'Admin', true).kind).toBe('move');
  });
  it('same stage is a no-op; demands have no Contacted', () => {
    expect(decideOfferStage('Enriched', 'Enriched', 'Demand agent', false).kind).toBe('noop');
    expect(code(() => decideDemandStage('Captured', 'Contacted', 'Admin'))).toBe('invalid-stage-transition');
  });
  it('automatic lifts never lower the stage', () => {
    expect(liftOfferStage('Enriched', 'Contacted')).toBe('Contacted');
    expect(liftOfferStage('Verified', 'Contacted')).toBe('Verified');
  });
});

const prop = (p: Partial<PropertyFacts>): PropertyFacts => ({
  segment: 'Residential',
  propertyTypes: ['Apartment'],
  buildingNorm: null,
  micromarketId: 'mm-1',
  localityNorm: 'bandra west',
  floorNo: null,
  areaSqftMin: null,
  areaSqftMax: null,
  areaBasis: null,
  bhkMin: null,
  bhkMax: null,
  prices: {},
  phoneHashes: [],
  ...p,
});

describe('property dedup (LLD §4.4)', () => {
  it('building + locality + floor + area + bhk + price = same property', () => {
    const a = prop({ buildingNorm: 'sea breeze', floorNo: 7, areaSqftMin: 1000, areaBasis: 'Carpet', bhkMin: 2, bhkMax: 2, prices: { Sale: 30_000_000 } });
    const b = prop({ buildingNorm: 'sea breeze', floorNo: 7, areaSqftMin: 1030, areaBasis: 'Carpet', bhkMin: 2, bhkMax: 2, prices: { Sale: 31_000_000 } });
    const s = scoreProperty(a, b);
    expect(s?.score).toBe(0.95);
    expect(s?.reasons).toEqual(['building', 'locality', 'floor', 'area', 'bhk', 'price']);
    expect(propertyDecision(s)).toBe('same_property');
  });
  it('≥ 0.85 without a building is only uncertain', () => {
    const a = prop({ floorNo: 3, areaSqftMin: 1000, bhkMin: 2, prices: { Sale: 100 } });
    const s = scoreProperty(a, { ...a });
    expect(s?.buildingMatched).toBe(false);
    expect(propertyDecision(s)).toBe('new'); // 0.10 + 0.15 + 0.20 + 0.05 + 0.05 = 0.55
  });
  it('a phone never decides alone (counted only when ≥ 0.50 without it)', () => {
    const a = prop({ phoneHashes: ['h1'], areaSqftMin: 1000 });
    const s = scoreProperty(a, prop({ phoneHashes: ['h1'], areaSqftMin: 1000 }));
    expect(s?.reasons).not.toContain('phone');
    const b = prop({ buildingNorm: 'x', phoneHashes: ['h1'] });
    expect(scoreProperty(b, prop({ buildingNorm: 'x', phoneHashes: ['h1'] }))?.reasons).toContain('phone');
  });
  it('segment must match and types overlap', () => {
    expect(scoreProperty(prop({}), prop({ segment: 'Commercial' }))).toBeNull();
    expect(scoreProperty(prop({}), prop({ propertyTypes: ['Villa'] }))).toBeNull();
  });
  it('area tolerance widens to 10% when a basis is blank, and different bases never match', () => {
    const base = prop({ areaSqftMin: 1000, areaBasis: 'Carpet' });
    expect(scoreProperty(base, prop({ areaSqftMin: 1080, areaBasis: 'Carpet' }))?.reasons).not.toContain('area');
    expect(scoreProperty(base, prop({ areaSqftMin: 1080, areaBasis: null }))?.reasons).toContain('area');
    expect(scoreProperty(base, prop({ areaSqftMin: 1000, areaBasis: 'Builtup' }))?.reasons).not.toContain('area');
  });
  it('ranks candidates best first', () => {
    const input = prop({ buildingNorm: 'b', areaSqftMin: 900 });
    const ranked = rankProperties(input, [prop({ areaSqftMin: 900 }), prop({ buildingNorm: 'b', areaSqftMin: 900 })]);
    expect(ranked[0]?.score.reasons).toContain('building');
  });
});

const dem = (d: Partial<DemandFacts>): DemandFacts => ({
  segment: 'Residential',
  dealTypes: ['Lease'],
  propertyTypes: ['Apartment'],
  places: ['bandra west'],
  budgetMin: null,
  budgetMax: null,
  rentMin: 100_000,
  rentMax: 150_000,
  areaMin: 900,
  areaMax: 1200,
  bhkMin: 2,
  bhkMax: 2,
  ...d,
});

describe('demand dedup (LLD §4.5)', () => {
  it('same person, same wish → touch', () => {
    const s = scoreDemand(dem({}), dem({ rentMax: 160_000 }));
    expect(s).toBe(1);
    expect(demandDecision(s, 'phone')).toBe('touch');
  });
  it('0.50–0.80 → new demand + candidate; below → new', () => {
    const s = scoreDemand(dem({}), dem({ places: ['powai'], areaMin: 2000, areaMax: 2500 }));
    expect(s).toBeGreaterThanOrEqual(DEMAND_THRESHOLDS.uncertain);
    expect(s).toBeLessThan(DEMAND_THRESHOLDS.touch);
    expect(demandDecision(s, 'phone')).toBe('new_with_candidate');
    expect(demandDecision(0.3, 'phone')).toBe('new');
  });
  it('segment is required; company-only evidence needs ≥ 0.80 and never touches', () => {
    expect(scoreDemand(dem({}), dem({ segment: 'Commercial' }))).toBeNull();
    expect(demandDecision(0.9, 'company')).toBe('new_with_candidate');
    expect(demandDecision(0.7, 'company')).toBe('new');
  });
});

describe('launch area (R-9, Z-7)', () => {
  const enabled = new Set(['mumbai', 'thane']);
  it('city outside the list → outside', () => {
    expect(launchAreaVerdict({ city: 'Pune' }, enabled)).toEqual({ outside: true, locationUnclear: false });
    expect(launchAreaVerdict({ city: 'Mumbai' }, enabled).outside).toBe(false);
  });
  it('blank city: Mumbai edition or a resolved MMR locality → inside; else location unclear', () => {
    expect(launchAreaVerdict({ city: null, sourceEdition: 'Mumbai' }, enabled)).toEqual({ outside: false, locationUnclear: false });
    expect(launchAreaVerdict({ city: null, resolvedInLaunchArea: true }, enabled).outside).toBe(false);
    expect(launchAreaVerdict({ city: null }, enabled)).toEqual({ outside: false, locationUnclear: true });
  });
  it('demands are outside only when every place is outside', () => {
    expect(demandOutside([{ inLaunchArea: false }, { inLaunchArea: false }])).toBe(true);
    expect(demandOutside([{ inLaunchArea: false }, { inLaunchArea: undefined }])).toBe(false);
    expect(demandOutside([])).toBe(false);
  });
});

describe('routing (LLD §4.2)', () => {
  it('routes by record_scope and side (route_to is only a suggestion)', () => {
    expect(routeRow({ recordScope: 'Property', side: 'Supply' })).toEqual({ kind: 'supply' });
    expect(routeRow({ recordScope: 'Property', side: 'Demand' })).toEqual({ kind: 'demand' });
    expect(routeRow({ recordScope: 'Property', side: null })).toEqual({ kind: 'unrouted' });
    expect(routeRow({ recordScope: 'Business', side: 'Supply', includesProperty: 'Yes' })).toEqual({ kind: 'desk', desk: 'business', withProperty: true });
    expect(routeRow({ recordScope: 'Equipment', side: 'Supply' })).toEqual({ kind: 'desk', desk: 'archive', withProperty: false });
    expect(routeRow({ recordScope: 'Market Participant', side: 'None' })).toEqual({ kind: 'network' });
    expect(routeRow({ recordScope: 'Market Signal', side: 'None' })).toEqual({ kind: 'desk', desk: 'watchlist', withProperty: false });
  });
  it('Sale|Lease splits into two offers with their own price fields', () => {
    const prices = {
      market: 'Secondary',
      salePriceInrMin: 30_000_000,
      salePriceInrMax: null,
      saleRateInr: null,
      saleRateUnit: null,
      rentMonthlyInrMin: 90_000,
      rentMonthlyInrMax: null,
      rentRatePsf: null,
      depositInr: 500_000,
      depositMonths: null,
      currentRentInr: 80_000,
      yieldPct: null,
    };
    const [sale, lease] = splitOfferPrices(['Sale', 'Lease'], prices);
    expect(sale?.prices.salePriceInrMin).toBe(30_000_000);
    expect(sale?.prices.rentMonthlyInrMin).toBeNull();
    expect(sale?.prices.currentRentInr).toBe(80_000);
    expect(lease?.prices.rentMonthlyInrMin).toBe(90_000);
    expect(lease?.prices.salePriceInrMin).toBeNull();
    expect(lease?.prices.market).toBeNull();
    expect(splitOfferPrices(['JV'], prices)[0]?.prices.salePriceInrMin).toBeNull();
    expect(splitOfferPrices(['Pagdi'], prices)[0]?.prices.rentMonthlyInrMin).toBe(90_000);
    expect(splitOfferPrices(['Equity'], prices)).toEqual([]);
  });
});

describe('merge and undo (LLD §4.7)', () => {
  const p = (id: string, parent: string | null = null, status = 'active') => ({ id, status, parentExternalRef: parent });
  it('refuses split siblings, inactive and duplicate participants', () => {
    expect(code(() => assertMergeAllowed(p('a', 'ad1'), [p('b', 'ad1')]))).toBe('merge-not-allowed');
    expect(code(() => assertMergeAllowed(p('a'), [p('b', null, 'merged')]))).toBe('merge-not-allowed');
    expect(code(() => assertMergeAllowed(p('a'), [p('a')]))).toBe('merge-not-allowed');
    expect(code(() => assertMergeAllowed(p('a', 'ad1'), [p('b', 'ad2')]))).toBe('no-error');
  });
  it('undo restores only columns still holding the merged value, in reverse order', () => {
    const entries = [
      { seq: 1, table: 'offers', rowId: 'o1', column: 'property_id', oldValue: 'p2', newValue: 'p1' },
      { seq: 2, table: 'offers', rowId: 'o2', column: 'property_id', oldValue: 'p2', newValue: 'p1' },
    ];
    const current = (_t: string, rowId: string) => (rowId === 'o1' ? 'p1' : 'p9');
    const plan = planUndo(entries, current);
    expect(plan.restore.map((e) => e.rowId)).toEqual(['o1']);
    expect(plan.conflicts.map((e) => e.rowId)).toEqual(['o2']);
  });
  it('fills survivor blanks from merged records', () => {
    expect(fillBlanks({ a: null, b: 'x', c: [] as string[] }, [{ a: 'y', b: 'z', c: ['k'] }], ['a', 'b', 'c'])).toEqual({ a: 'y', c: ['k'] });
    expect(sameValue({ b: 1, a: [1, 2] }, { a: [1, 2], b: 1 })).toBe(true);
  });
});

describe('privacy helpers', () => {
  it('building and unit tokens for scan terms (R-20)', () => {
    expect(buildingTokens('Sea Breeze CHS Tower A')).toEqual(expect.arrayContaining(['sea', 'breeze', 'sea breeze', 'seabreeze']));
    expect(buildingTokens('Sea Breeze CHS Tower A')).not.toContain('chs');
    expect(unitTokens('B-1203')).toEqual(['b 1203', 'b1203']);
  });
  it('sniffs JPG/PNG/WebP magic bytes and reads PNG dimensions', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 128, 0, 0, 1, 224]);
    expect(sniffImage(png)).toBe('image/png');
    expect(imageSize(png, 'image/png')).toEqual({ width: 640, height: 480 });
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF1234WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBeNull();
  });
  it('floor band, possession start, price gap', () => {
    expect(floorBand(2, 12)).toBe('Low');
    expect(floorBand(6, 12)).toBe('Mid');
    expect(floorBand(11, 12)).toBe('High');
    expect(floorBand(null, 12)).toBeNull();
    expect(possessionDateStart('2027')).toBe('2027-01-01');
    expect(possessionDateStart('2027-05')).toBe('2027-05-01');
    expect(priceGapPct(100, 106)).toBe(6);
  });
});

describe('vocabulary validation (R-11)', () => {
  const vocab = new VocabularyIndex('v0.6', { deal_type: { values: ['Sale', 'Lease'] }, furnishing: { values: ['Semi Furnished'] } });
  it('canonicalises after trim + case-fold', () => {
    const out = vocab.validate([
      { path: 'dealType', field: 'deal_type', value: ' sale ' },
      { path: 'furnishing', field: 'furnishing', value: 'semi   furnished' },
      { path: 'dealTypes', field: 'deal_type', value: ['LEASE', 'lease'] },
    ]);
    expect(out.get('dealType')).toBe('Sale');
    expect(out.get('furnishing')).toBe('Semi Furnished');
    expect(out.get('dealTypes')).toEqual(['Lease']);
  });
  it('rejects values outside the release and inverted ranges', () => {
    expect(code(() => vocab.validate([{ path: 'dealType', field: 'deal_type', value: 'Rent' }]))).toBe('vocabulary-value-invalid');
    expect(code(() => assertRanges([['area', 10, 5]]))).toBe('range-inverted');
  });
});

describe('micromarket index', () => {
  const nodes = [
    { id: 'z', parent_id: null, level: 'zone', name_norm: 'western suburbs', aliases_norm: [], city_norm: 'mumbai', in_launch_area: true },
    { id: 'ae', parent_id: 'z', level: 'micromarket', name_norm: 'andheri east', aliases_norm: ['andheri e'], city_norm: 'mumbai', in_launch_area: true },
    { id: 'ch', parent_id: 'ae', level: 'locality', name_norm: 'chakala', aliases_norm: [], city_norm: 'mumbai', in_launch_area: true },
  ];
  it('resolves names and aliases (incl. "(E)" variants) and walks ancestors', () => {
    const idx = new MicromarketIndex(nodes);
    expect(idx.resolve('Chakala')?.id).toBe('ch');
    expect(idx.resolve('Andheri (E)')?.id).toBe('ae');
    expect(idx.resolve('Andheri East')?.id).toBe('ae');
    expect(idx.resolve('Pune')).toBeUndefined();
    expect(idx.ancestors('ch')).toEqual(['ch', 'ae', 'z']);
  });
});

describe('parseFloor (CR-012 upload floor text)', () => {
  it('reads numbers, ordinals, ground, basements and "n of m"', () => {
    expect(parseFloor('12')).toEqual({ floorNo: 12, totalFloors: null });
    expect(parseFloor('12th')).toEqual({ floorNo: 12, totalFloors: null });
    expect(parseFloor('12 of 20')).toEqual({ floorNo: 12, totalFloors: 20 });
    expect(parseFloor('3/7')).toEqual({ floorNo: 3, totalFloors: 7 });
    expect(parseFloor('G')).toEqual({ floorNo: 0, totalFloors: null });
    expect(parseFloor('Ground of 4')).toEqual({ floorNo: 0, totalFloors: 4 });
    expect(parseFloor('LG')).toEqual({ floorNo: -1, totalFloors: null });
    expect(parseFloor('B2')).toEqual({ floorNo: -2, totalFloors: null });
    expect(parseFloor('Floor no. 5')).toEqual({ floorNo: 5, totalFloors: null });
  });

  it('gives nulls for blank or unreadable text and ignores an impossible total', () => {
    expect(parseFloor(null)).toEqual({ floorNo: null, totalFloors: null });
    expect(parseFloor('higher floor')).toEqual({ floorNo: null, totalFloors: null });
    expect(parseFloor('15 of 10')).toEqual({ floorNo: 15, totalFloors: null });
  });
});
