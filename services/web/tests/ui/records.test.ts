// records cards logic (C-06 quick add, C-07 add supply, P-08 desks): classification order, dependent dropdowns,
// budget field by deal type, request building and the desk tab ↔ contract enum mapping.
import { describe, expect, it } from 'vitest';
import type { components as R } from '@11e/contracts/records';
import type { components as I } from '@11e/contracts/intake';
import type { Vocabulary } from '@/ui/lib/vocabulary';
import {
  addSupplyRoute,
  applyParse,
  budgetKind,
  budgetLabel,
  buildAddSupplyRequest,
  buildCreateOfferRequest,
  buildCreatePropertyRequest,
  buildDedupRequest,
  buildQuickAddRequest,
  buildRevealRequest,
  candidatesOf,
  classificationSteps,
  codesFromQuickAdd,
  DESK_TAB_LABELS,
  DESK_TABS,
  deskForTab,
  deskRowPanel,
  emptyForm,
  isStepEnabled,
  marketOptions,
  missingRequired,
  nextClassificationStep,
  prefillFromDemand,
  propertyDealTypes,
  propertyTypesFor,
  quickAddOutcomeText,
  roleAllows,
  ROLES,
  setClassification,
  sortWatchlist,
  tabForDesk,
} from '@/ui/cards/records/logic';
import type { Classification, RecordForm } from '@/ui/cards/records/logic';

const vocab: Vocabulary = {
  version: 'v0.6',
  checksum: 'x',
  activatedAt: '2026-01-01T00:00:00Z',
  fields: {
    deal_type: { values: ['Sale', 'Lease', 'JV', 'Pagdi', 'Partnership', 'Debt'], multi: true },
    market: { values: ['Primary', 'Secondary', 'Any'] },
    segment: { values: ['Residential', 'Commercial', 'Industrial', 'Land'] },
    property_type: {
      values: ['Apartment', 'Villa', 'Office', 'Shop', 'Warehouse', 'Plot'],
      multi: true,
      bySegment: {
        Residential: ['Apartment', 'Villa'],
        Commercial: ['Office', 'Shop'],
        Industrial: ['Warehouse'],
        Land: ['Plot'],
      },
    },
    furnishing: { values: ['Furnished', 'Semi Furnished', 'Unfurnished', 'Bare Shell'] },
    tenancy_status: { values: ['Vacant', 'Tenanted'] },
    sale_mode: { values: ['Private', 'Auction'] },
  },
  recordScopes: [
    { value: 'Property', allowedDealTypes: ['Sale', 'Lease', 'JV', 'Pagdi'], sides: ['Supply', 'Demand'] },
    { value: 'Business', allowedDealTypes: ['Sale', 'Lease', 'Partnership'] },
  ],
  legacyTerms: [],
};

const blank: Classification = { side: null, dealType: null, market: null, segment: null, propertyType: null };
const answer = (c: Classification, ...steps: [keyof Classification, string][]) =>
  steps.reduce((acc, [s, v]) => setClassification(acc, s, v, vocab), c);

const form = (over: Partial<RecordForm>): RecordForm => ({ ...emptyForm('Demand'), ...over });

describe('quick add classification order (PRD C-06, BRD §4.2)', () => {
  it('asks side first, then deal type, market (Sale only), segment, property type', () => {
    expect(classificationSteps({ dealType: 'Sale' })).toEqual(['side', 'dealType', 'market', 'segment', 'propertyType']);
    expect(classificationSteps({ dealType: 'Lease' })).toEqual(['side', 'dealType', 'segment', 'propertyType']);
  });

  it('knows which step is next', () => {
    let c = blank;
    expect(nextClassificationStep(c)).toBe('side');
    c = answer(c, ['side', 'Demand']);
    expect(nextClassificationStep(c)).toBe('dealType');
    c = answer(c, ['dealType', 'Sale']);
    expect(nextClassificationStep(c)).toBe('market');
    c = answer(c, ['market', 'Any']);
    expect(nextClassificationStep(c)).toBe('segment');
    c = answer(c, ['segment', 'Commercial']);
    expect(nextClassificationStep(c)).toBe('propertyType');
    c = answer(c, ['propertyType', 'Office']);
    expect(nextClassificationStep(c)).toBeNull();
  });

  it('skips market for Lease and goes straight to segment', () => {
    const c = answer(blank, ['side', 'Supply'], ['dealType', 'Lease']);
    expect(nextClassificationStep(c)).toBe('segment');
  });

  it('enables a dropdown only after every earlier step is answered', () => {
    const c = answer(blank, ['side', 'Demand']);
    expect(isStepEnabled(c, 'dealType')).toBe(true);
    expect(isStepEnabled(c, 'segment')).toBe(false);
    expect(isStepEnabled(c, 'market')).toBe(false); // market does not apply until Sale is chosen
    const sale = answer(c, ['dealType', 'Sale']);
    expect(isStepEnabled(sale, 'market')).toBe(true);
    expect(isStepEnabled(sale, 'segment')).toBe(false);
  });
});

describe('market only for Sale', () => {
  it('clears market when the deal type changes away from Sale', () => {
    const c = answer(blank, ['side', 'Demand'], ['dealType', 'Sale'], ['market', 'Secondary'], ['dealType', 'Lease']);
    expect(c.market).toBeNull();
  });

  it('offers Any to demands but not to supply', () => {
    expect(marketOptions(vocab, 'Demand')).toEqual(['Primary', 'Secondary', 'Any']);
    expect(marketOptions(vocab, 'Supply')).toEqual(['Primary', 'Secondary']);
  });

  it('drops market Any when the side switches to Supply', () => {
    const c = answer(blank, ['side', 'Demand'], ['dealType', 'Sale'], ['market', 'Any'], ['side', 'Supply']);
    expect(c.market).toBeNull();
  });

  it('lists only property deal types (vocabulary Property record scope)', () => {
    expect(propertyDealTypes(vocab)).toEqual(['Sale', 'Lease', 'JV', 'Pagdi']);
    expect(propertyDealTypes(undefined)).toEqual(['Sale', 'Lease', 'JV', 'Pagdi']);
  });
});

describe('property types filtered by segment', () => {
  it('uses the vocabulary bySegment list', () => {
    expect(propertyTypesFor(vocab, 'Commercial')).toEqual(['Office', 'Shop']);
    expect(propertyTypesFor(vocab, 'Residential')).toEqual(['Apartment', 'Villa']);
  });

  it('offers nothing before a segment is chosen', () => {
    expect(propertyTypesFor(vocab, null)).toEqual([]);
  });

  it('clears a property type that the new segment does not allow, keeps one it does', () => {
    const c = answer(blank, ['side', 'Demand'], ['dealType', 'Lease'], ['segment', 'Commercial'], ['propertyType', 'Office']);
    expect(answer(c, ['segment', 'Residential']).propertyType).toBeNull();
    expect(answer(c, ['segment', 'Commercial']).propertyType).toBe('Office');
  });
});

describe('budget field by deal type', () => {
  it('Sale and Pagdi use a sale price, Lease a monthly rent, JV none', () => {
    expect(budgetKind('Sale')).toBe('sale');
    expect(budgetKind('Pagdi')).toBe('sale');
    expect(budgetKind('Lease')).toBe('rent');
    expect(budgetKind('JV')).toBe('none');
    expect(budgetKind(null)).toBe('none');
  });

  it('labels the field for the side', () => {
    expect(budgetLabel('Demand', 'Lease')).toBe('Rent budget per month (₹)');
    expect(budgetLabel('Supply', 'Sale')).toBe('Price (₹)');
    expect(budgetLabel('Demand', 'JV')).toBeNull();
  });
});

describe('required answers', () => {
  it('lists the missing classification in order and range errors', () => {
    expect(missingRequired(form({ dealType: 'Sale' }))).toEqual(['market', 'segment', 'property type']);
    expect(
      missingRequired(
        form({ dealType: 'Lease', segment: 'Commercial', propertyType: 'Office', areaMin: 7000, areaMax: 5000 }),
      ),
    ).toEqual(['area min ≤ max']);
  });
});

describe('quick add request (POST /v1/quick-add)', () => {
  const lease = form({
    dealType: 'Lease',
    segment: 'Commercial',
    propertyType: 'Office',
    areaMin: 5000,
    areaMax: 7000,
    areaBasis: 'Builtup',
    priceMin: 800000,
    priceMax: 1000000,
    locality: ' Andheri East ',
  });

  it('builds a lease demand with a monthly rent budget and no market', () => {
    const r = buildQuickAddRequest(' +919811111111 ', lease, {}, { name: 'Rohan', sourceDetail: 'referred by Mr Shah' });
    expect(r).toMatchObject({
      phone: '+919811111111',
      side: 'Demand',
      sourceType: 'Direct',
      duringCall: false,
      confirmNewDespiteCandidates: false,
      name: 'Rohan',
      sourceDetail: 'referred by Mr Shah',
    });
    expect(r.demand).toMatchObject({
      dealTypes: ['Lease'],
      market: null,
      segment: 'Commercial',
      propertyTypes: ['Office'],
      localities: ['Andheri East'],
      rentMonthlyInrMin: 800000,
      rentMonthlyInrMax: 1000000,
      areaSqftMin: 5000,
      areaSqftMax: 7000,
      areaBasis: 'Builtup',
    });
    expect(r.demand).not.toHaveProperty('budgetInrMin');
    expect(r).not.toHaveProperty('property');
  });

  it('puts a sale budget in budgetInr and keeps the market', () => {
    const r = buildQuickAddRequest('9811111111', { ...lease, dealType: 'Sale', market: 'Any' });
    expect(r.demand).toMatchObject({ dealTypes: ['Sale'], market: 'Any', budgetInrMin: 800000, budgetInrMax: 1000000 });
    expect(r.demand).not.toHaveProperty('rentMonthlyInrMin');
  });

  it('builds supply as a property plus one offer', () => {
    const r = buildQuickAddRequest('9811111111', { ...lease, side: 'Supply', dealType: 'Sale', market: 'Secondary' });
    expect(r.side).toBe('Supply');
    expect(r).not.toHaveProperty('demand');
    expect(r.property).toMatchObject({ segment: 'Commercial', propertyTypes: ['Office'], locality: 'Andheri East' });
    expect(r.offers).toEqual([
      expect.objectContaining({ dealType: 'Sale', market: 'Secondary', salePriceInrMin: 800000, salePriceInrMax: 1000000 }),
    ]);
  });

  it('adds a touch to the picked open demand instead of creating', () => {
    const r = buildQuickAddRequest('9811111111', lease, { existingPersonId: 'p1', existingDemandId: 'd1' }, { name: 'X' });
    expect(r).toMatchObject({ side: 'Demand', existingPersonId: 'p1', existingDemandId: 'd1' });
    expect(r).not.toHaveProperty('demand');
    expect(r).not.toHaveProperty('name'); // the person is reused, never renamed from quick add
  });

  it('marks a record entered during a call and a confirmed new property', () => {
    const r = buildQuickAddRequest('9811111111', lease, {}, { duringCall: true, confirmNewDespiteCandidates: true });
    expect(r.duringCall).toBe(true);
    expect(r.confirmNewDespiteCandidates).toBe(true);
  });

  it('turns the result into codes and a sentence', () => {
    const touch = codesFromQuickAdd({
      outcome: 'touch_added',
      person: {} as R['schemas']['Person'],
      demand: { code: 'DEM-000127' } as R['schemas']['Demand'],
    });
    expect(touch.demandCode).toBe('DEM-000127');
    expect(quickAddOutcomeText(touch)).toContain('Touch added to DEM-000127');
    const offers = codesFromQuickAdd({
      outcome: 'offers_created',
      person: {} as R['schemas']['Person'],
      offers: [{ code: 'INV-00500' } as R['schemas']['Offer']],
    });
    expect(offers.codes).toEqual(['INV-00500']);
  });
});

describe('prefill', () => {
  const parse = (over: Partial<I['schemas']['ParseResult']>): I['schemas']['ParseResult'] => ({
    classification: {},
    fields: {},
    contacts: {},
    confidence: 0.9,
    usedModel: false,
    vocabularyVersion: 'v0.6',
    ...over,
  });

  it('applies only controlled values from POST /v1/parse', () => {
    const f = applyParse(
      emptyForm('Demand'),
      parse({
        classification: { dealTypes: ['Lease'], segment: 'Commercial', propertyTypes: ['Warehouse'] },
        fields: { areaSqftMin: 5000, rentMonthlyInrMax: 1000000, locality: 'Andheri East', furnishing: 'Luxurious' },
      }),
      vocab,
    );
    expect(f).toMatchObject({ dealType: 'Lease', segment: 'Commercial', propertyType: null, areaMin: 5000 });
    expect(f.priceMax).toBe(1000000);
    expect(f.locality).toBe('Andheri East');
    expect(f.tags.furnishing).toBeNull(); // not in the list → not set
  });

  it('prefills add supply from the demand, never with market Any', () => {
    const d = {
      dealTypes: ['Sale'],
      market: 'Any',
      segment: 'Residential',
      propertyTypes: ['Villa'],
      budgetInrMin: 20000000,
      budgetInrMax: 30000000,
      localities: ['Juhu'],
      bhkMin: 3,
      statedTags: { tenure: 'Freehold' },
    } as unknown as R['schemas']['Demand'];
    const f = prefillFromDemand(d, vocab);
    expect(f).toMatchObject({
      side: 'Supply',
      dealType: 'Sale',
      market: null,
      segment: 'Residential',
      propertyType: 'Villa',
      priceMin: 20000000,
      locality: 'Juhu',
      bhkMin: 3,
    });
    expect(f.tags.tenure).toBe('Freehold');
  });
});

describe('add supply requests (C-07)', () => {
  const f = form({
    side: 'Supply',
    dealType: 'Lease',
    segment: 'Commercial',
    propertyType: 'Office',
    areaMin: 6000,
    priceMin: 900000,
    locality: 'Andheri East',
  });
  const party = { phone: '+919800000000', name: '', role: 'Landlord' };

  it('checks duplicates with the property, deal type and the contact phone', () => {
    const r = buildDedupRequest(f, { buildingName: 'Times Square', floorNo: 4 }, party);
    expect(r).toMatchObject({
      dealType: 'Lease',
      phones: ['+919800000000'],
      property: { buildingName: 'Times Square', floorNo: 4, locality: 'Andheri East', propertyTypes: ['Office'] },
    });
  });

  it('uses the picked existing property, or a new one', () => {
    const existing = buildAddSupplyRequest(f, {}, { existingPropertyId: 'prop-1' }, party);
    expect(existing).toMatchObject({ existingPropertyId: 'prop-1', confirmNewDespiteCandidates: false, sourceType: 'Direct' });
    expect(existing).not.toHaveProperty('property');
    expect(existing.offer).toMatchObject({ dealType: 'Lease', rentMonthlyInrMin: 900000 });
    expect(existing.parties).toEqual([{ role: 'Landlord', newPerson: { phones: ['+919800000000'] } }]);

    const fresh = buildAddSupplyRequest(f, {}, { newProperty: true, confirmNewDespiteCandidates: true });
    expect(fresh).toMatchObject({ confirmNewDespiteCandidates: true, property: { segment: 'Commercial' } });
    expect(fresh).not.toHaveProperty('existingPropertyId');
    expect(fresh).not.toHaveProperty('parties');
  });

  it('routes: demand → add-supply; no demand → createOffer on a picked property, createProperty otherwise', () => {
    expect(addSupplyRoute('DEM-000127', { existingPropertyId: 'p' })).toBe('add-supply');
    expect(addSupplyRoute(undefined, { existingPropertyId: 'p' })).toBe('offer');
    expect(addSupplyRoute(undefined, { newProperty: true, confirmNewDespiteCandidates: false })).toBe('property');
    expect(buildCreateOfferRequest(f, 'p')).toMatchObject({ propertyId: 'p', offer: { dealType: 'Lease' } });
    expect(buildCreatePropertyRequest(f, {}, false)).toMatchObject({
      offers: [{ dealType: 'Lease' }],
      confirmNewDespiteCandidates: false,
    });
  });

  it('reads candidates from a 409 duplicate-property-suspected problem', () => {
    expect(candidatesOf({ code: 'duplicate-property-suspected', candidates: [{ propertyId: 'a', code: 'PRP-1' }, null] })).toEqual([
      { propertyId: 'a', code: 'PRP-1' },
    ]);
    expect(candidatesOf({ code: 'x' })).toEqual([]);
    expect(candidatesOf(undefined)).toEqual([]);
  });
});

describe('desks (P-08)', () => {
  it('maps every tab to the GET /v1/desks/{desk} enum and back', () => {
    const contractEnum: R['schemas']['DeskItem']['desk'][] = ['business', 'capital', 'archive', 'network', 'watchlist'];
    expect(DESK_TABS.map((t) => t.desk)).toEqual(contractEnum);
    expect(DESK_TAB_LABELS).toEqual([
      'Business Desk',
      'Capital Desk',
      'Archive (Equipment)',
      'Network (Market Participants)',
      'Watchlist',
    ]);
    for (const label of DESK_TAB_LABELS) expect(tabForDesk(deskForTab(label))).toBe(label);
    expect(tabForDesk('unknown')).toBeNull();
  });

  it('opens people from the network desk, desk items elsewhere', () => {
    expect(deskRowPanel('network')).toBe('person');
    expect(deskRowPanel('watchlist')).toBe('desk-item');
  });

  it('orders the watchlist with deadlines in the next 14 days first', () => {
    const now = Date.parse('2026-09-28T00:00:00Z');
    const items = [
      { code: 'late', deadlineDate: '2026-10-19' },
      { code: 'none', deadlineDate: null },
      { code: 'soon', deadlineDate: '2026-10-07' },
      { code: 'sooner', deadlineDate: '2026-10-01' },
    ];
    expect(sortWatchlist(items, now).map((i) => i.code)).toEqual(['sooner', 'soon', 'late', 'none']);
  });
});

describe('roles and reveal', () => {
  it('follows the contract x-roles', () => {
    expect(roleAllows('Demand agent', ROLES.addTouch)).toBe(true);
    expect(roleAllows('Supply agent', ROLES.addTouch)).toBe(false);
    expect(roleAllows('Supply agent', ROLES.completeWatchlistTask)).toBe(true);
    expect(roleAllows('Demand agent', ROLES.patchDeskItem)).toBe(false);
    expect(roleAllows('Data operator', ROLES.quickAdd)).toBe(false);
  });

  it('reveals from the UI with a purpose', () => {
    expect(buildRevealRequest('person', 'p1', 'call')).toEqual({ subjectType: 'person', subjectId: 'p1', purpose: 'call', via: 'ui' });
  });
});
