// Pure rules behind the records cards and panels (C-06 quick add, C-07 add supply, P-02…P-05, P-08, C-21; PRD §5.4,
// US-04, US-05, US-36): classification order, dependent dropdowns, budget field by deal type, request building and the
// desk tab ↔ contract enum mapping. No React, no I/O.
import type { components as R } from '@11e/contracts/records';
import type { components as I } from '@11e/contracts/intake';
import type { Vocabulary } from '@/ui/lib/vocabulary';

type S = R['schemas'];
export type SideValue = 'Demand' | 'Supply';
export type RoleCode = 'Admin' | 'Manager' | 'Demand agent' | 'Supply agent' | 'Data operator';

// ---------------------------------------------------------------------------------------------------------------
// Classification (PRD C-06: side → deal_type → market (Sale only) → segment → property_type)

export const CLASSIFICATION_ORDER = ['side', 'dealType', 'market', 'segment', 'propertyType'] as const;
export type ClassStep = (typeof CLASSIFICATION_ORDER)[number];

export interface Classification {
  side: SideValue | null;
  dealType: string | null;
  market: string | null;
  segment: string | null;
  propertyType: string | null;
}

/** BRD §4.2: market is asked only for Sale. */
export const needsMarket = (dealType: string | null | undefined): boolean => dealType === 'Sale';

/** The steps that apply to this classification, in the order they are asked. */
export function classificationSteps(c: Pick<Classification, 'dealType'>): ClassStep[] {
  return CLASSIFICATION_ORDER.filter((s) => s !== 'market' || needsMarket(c.dealType));
}

/** The first unanswered step, or null when the classification is complete. */
export function nextClassificationStep(c: Classification): ClassStep | null {
  return classificationSteps(c).find((s) => !c[s]) ?? null;
}

/** A dropdown is enabled once every step before it is answered (controlled order, PRD C-06). */
export function isStepEnabled(c: Classification, step: ClassStep): boolean {
  const steps = classificationSteps(c);
  const i = steps.indexOf(step);
  if (i < 0) return false;
  return steps.slice(0, i).every((s) => Boolean(c[s]));
}

/** Property deal types: the vocabulary's Property record scope, else the BRD four. */
export const PROPERTY_DEAL_TYPES = ['Sale', 'Lease', 'JV', 'Pagdi'] as const;
export function propertyDealTypes(vocab: Vocabulary | undefined): string[] {
  const scope = vocab?.recordScopes?.find((r) => r.value === 'Property');
  if (scope?.allowedDealTypes?.length) return scope.allowedDealTypes;
  const all = vocab?.fields['deal_type']?.values;
  return all ? PROPERTY_DEAL_TYPES.filter((d) => all.includes(d)) : [...PROPERTY_DEAL_TYPES];
}

/** Supply is Primary or Secondary; a demand may also say Any (BRD §4.2). */
export function marketOptions(vocab: Vocabulary | undefined, side: SideValue | null): string[] {
  const all = vocab?.fields['market']?.values ?? ['Primary', 'Secondary', 'Any'];
  return side === 'Supply' ? all.filter((m) => m !== 'Any') : all;
}

export function segmentOptions(vocab: Vocabulary | undefined): string[] {
  return vocab?.fields['segment']?.values ?? [];
}

/** property_type values allowed for the segment (vocabulary `bySegment`); nothing until a segment is chosen. */
export function propertyTypesFor(vocab: Vocabulary | undefined, segment: string | null | undefined): string[] {
  if (!segment) return [];
  const f = vocab?.fields['property_type'];
  if (!f) return [];
  return f.bySegment?.[segment] ?? f.values ?? [];
}

/**
 * Sets one classification answer and clears later answers that no longer fit: market goes when the deal type is not
 * Sale (or is Any on the supply side), property_type goes when it is not allowed for the new segment.
 */
export function setClassification(
  c: Classification,
  step: ClassStep,
  value: string | null,
  vocab: Vocabulary | undefined,
): Classification {
  const next: Classification = { ...c, [step]: value } as Classification;
  if (!needsMarket(next.dealType)) next.market = null;
  if (next.market && !marketOptions(vocab, next.side).includes(next.market)) next.market = null;
  if (next.propertyType && !propertyTypesFor(vocab, next.segment).includes(next.propertyType)) next.propertyType = null;
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Budget / price field by deal type (records LLD §4.3: Sale and Pagdi carry a sale price, Lease a monthly rent, JV none)

export type BudgetKind = 'sale' | 'rent' | 'none';
export function budgetKind(dealType: string | null | undefined): BudgetKind {
  if (dealType === 'Sale' || dealType === 'Pagdi') return 'sale';
  if (dealType === 'Lease') return 'rent';
  return 'none';
}

export function budgetLabel(side: SideValue | null, dealType: string | null | undefined): string | null {
  const k = budgetKind(dealType);
  if (k === 'none') return null;
  const what = side === 'Supply' ? (k === 'sale' ? 'Price' : 'Rent') : k === 'sale' ? 'Budget' : 'Rent budget';
  return k === 'rent' ? `${what} per month (₹)` : `${what} (₹)`;
}

// ---------------------------------------------------------------------------------------------------------------
// The form shared by quick add and add supply

export interface DealTags {
  saleMode: string | null;
  tenancyStatus: string | null;
  tenure: string | null;
  agreementForm: string | null;
  possessionStatus: string | null;
  furnishing: string | null;
  isJodi: boolean | null;
}

/** Optional deal tags: [form key, vocabulary field, label]. */
export const DEAL_TAG_FIELDS: readonly [Exclude<keyof DealTags, 'isJodi'>, string, string][] = [
  ['saleMode', 'sale_mode', 'Sale mode'],
  ['tenancyStatus', 'tenancy_status', 'Tenancy status'],
  ['tenure', 'tenure', 'Tenure'],
  ['agreementForm', 'agreement_form', 'Agreement form'],
  ['possessionStatus', 'possession_status', 'Possession status'],
  ['furnishing', 'furnishing', 'Furnishing'],
];

export interface RecordForm extends Classification {
  bhkMin: number | null;
  bhkMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  areaBasis: string | null;
  priceMin: number | null;
  priceMax: number | null;
  locality: string;
  tags: DealTags;
}

export const emptyTags = (): DealTags => ({
  saleMode: null,
  tenancyStatus: null,
  tenure: null,
  agreementForm: null,
  possessionStatus: null,
  furnishing: null,
  isJodi: null,
});

export const emptyForm = (side: SideValue | null = null): RecordForm => ({
  side,
  dealType: null,
  market: null,
  segment: null,
  propertyType: null,
  bhkMin: null,
  bhkMax: null,
  areaMin: null,
  areaMax: null,
  areaBasis: null,
  priceMin: null,
  priceMax: null,
  locality: '',
  tags: emptyTags(),
});

/** Human names of the missing required answers (the classification), in the order they are asked. */
export function missingRequired(f: RecordForm): string[] {
  const names: Record<ClassStep, string> = {
    side: 'side',
    dealType: 'deal type',
    market: 'market',
    segment: 'segment',
    propertyType: 'property type',
  };
  const missing = classificationSteps(f).filter((s) => !f[s]).map((s) => names[s]);
  if (f.areaMin != null && f.areaMax != null && f.areaMin > f.areaMax) missing.push('area min ≤ max');
  if (f.priceMin != null && f.priceMax != null && f.priceMin > f.priceMax) missing.push('price min ≤ max');
  if (f.bhkMin != null && f.bhkMax != null && f.bhkMin > f.bhkMax) missing.push('BHK min ≤ max');
  return missing;
}

type AreaBasis = S['AreaBasis'];
const AREA_BASES: readonly string[] = ['Carpet', 'Builtup', 'Saleable'];
const asAreaBasis = (v: string | null | undefined): AreaBasis => (v && AREA_BASES.includes(v) ? (v as AreaBasis) : null);

const statedTags = (t: DealTags) => ({
  saleMode: t.saleMode,
  tenancyStatus: t.tenancyStatus,
  tenure: t.tenure,
  agreementForm: t.agreementForm,
  possessionStatus: t.possessionStatus,
  furnishing: t.furnishing,
  isJodi: t.isJodi,
});

/** OfferInput for one deal type: only the price fields that belong to it (sale price vs monthly rent). */
export function buildOfferInput(f: RecordForm): S['OfferInput'] {
  const kind = budgetKind(f.dealType);
  return {
    dealType: f.dealType ?? '',
    market: needsMarket(f.dealType) ? f.market : null,
    ...(kind === 'sale' ? { salePriceInrMin: f.priceMin, salePriceInrMax: f.priceMax } : {}),
    ...(kind === 'rent' ? { rentMonthlyInrMin: f.priceMin, rentMonthlyInrMax: f.priceMax } : {}),
    ...statedTags(f.tags),
  };
}

export interface PropertyExtras {
  buildingName?: string;
  floorNo?: number | null;
  city?: string;
}

export function buildPropertyInput(f: RecordForm, extras: PropertyExtras = {}): S['PropertyInput'] {
  const locality = f.locality.trim();
  const building = extras.buildingName?.trim();
  const city = extras.city?.trim();
  return {
    segment: f.segment,
    propertyTypes: f.propertyType ? [f.propertyType] : [],
    ...(locality ? { locality } : {}),
    ...(building ? { buildingName: building } : {}),
    ...(city ? { city } : {}),
    ...(extras.floorNo != null ? { floorNo: extras.floorNo } : {}),
    areaSqftMin: f.areaMin,
    areaSqftMax: f.areaMax,
    areaBasis: asAreaBasis(f.areaBasis),
    bhkMin: f.bhkMin,
    bhkMax: f.bhkMax,
  };
}

type QuickDemand = NonNullable<S['QuickAddRequest']['demand']>;
export function buildDemandFacts(f: RecordForm, companyName?: string): QuickDemand {
  const kind = budgetKind(f.dealType);
  const locality = f.locality.trim();
  const company = companyName?.trim();
  return {
    dealTypes: f.dealType ? [f.dealType] : [],
    market: needsMarket(f.dealType) ? f.market : null,
    segment: f.segment,
    propertyTypes: f.propertyType ? [f.propertyType] : [],
    localities: locality ? [locality] : [],
    ...(kind === 'sale' ? { budgetInrMin: f.priceMin, budgetInrMax: f.priceMax } : {}),
    ...(kind === 'rent' ? { rentMonthlyInrMin: f.priceMin, rentMonthlyInrMax: f.priceMax } : {}),
    areaSqftMin: f.areaMin,
    areaSqftMax: f.areaMax,
    areaBasis: asAreaBasis(f.areaBasis),
    bhkMin: f.bhkMin,
    bhkMax: f.bhkMax,
    statedTags: statedTags(f.tags),
    ...(company ? { companyName: company } : {}),
  };
}

export interface QuickAddChoice {
  existingPersonId?: string | null;
  /** The user picked an open demand in the lookup: add a touch instead of creating (US-08). */
  existingDemandId?: string | null;
}

export interface QuickAddExtras {
  name?: string;
  companyName?: string;
  sourceDetail?: string;
  duringCall?: boolean;
  confirmNewDespiteCandidates?: boolean;
}

/** POST /v1/quick-add body (source Direct, typed in: US-04 AC3). */
export function buildQuickAddRequest(
  phone: string,
  f: RecordForm,
  choice: QuickAddChoice = {},
  extras: QuickAddExtras = {},
): S['QuickAddRequest'] {
  const name = extras.name?.trim();
  const company = extras.companyName?.trim();
  const detail = extras.sourceDetail?.trim();
  const base = {
    phone: phone.trim(),
    sourceType: 'Direct' as const,
    duringCall: extras.duringCall ?? false,
    confirmNewDespiteCandidates: extras.confirmNewDespiteCandidates ?? false,
    ...(detail ? { sourceDetail: detail } : {}),
    ...(choice.existingPersonId ? { existingPersonId: choice.existingPersonId } : {}),
    ...(!choice.existingPersonId && name ? { name } : {}),
    ...(company ? { companyName: company } : {}),
  };
  if (choice.existingDemandId) return { ...base, side: 'Demand', existingDemandId: choice.existingDemandId };
  if (f.side === 'Supply') return { ...base, side: 'Supply', property: buildPropertyInput(f), offers: [buildOfferInput(f)] };
  return { ...base, side: 'Demand', demand: buildDemandFacts(f, company) };
}

// ---------------------------------------------------------------------------------------------------------------
// Prefill

type ParseResult = I['schemas']['ParseResult'];

/** Applies a parse suggestion (POST /v1/parse) to an empty form: only values that are in the controlled lists. */
export function applyParse(f: RecordForm, p: ParseResult, vocab: Vocabulary | undefined): RecordForm {
  let c: Classification = { side: f.side, dealType: f.dealType, market: f.market, segment: f.segment, propertyType: f.propertyType };
  const cl = p.classification ?? {};
  const pick = (v: string | null | undefined, options: string[]) => (v && options.includes(v) ? v : null);
  if (!c.side && (cl.side === 'Demand' || cl.side === 'Supply')) c = setClassification(c, 'side', cl.side, vocab);
  const deal = pick(cl.dealTypes?.[0], propertyDealTypes(vocab));
  if (!c.dealType && deal) c = setClassification(c, 'dealType', deal, vocab);
  const market = pick(cl.market, marketOptions(vocab, c.side));
  if (!c.market && market && needsMarket(c.dealType)) c = setClassification(c, 'market', market, vocab);
  const segment = pick(cl.segment, segmentOptions(vocab));
  if (!c.segment && segment) c = setClassification(c, 'segment', segment, vocab);
  const pt = pick(cl.propertyTypes?.[0], propertyTypesFor(vocab, c.segment));
  if (!c.propertyType && pt) c = setClassification(c, 'propertyType', pt, vocab);
  const x = p.fields ?? {};
  const kind = budgetKind(c.dealType);
  const tagPick = (field: string, v: string | null | undefined) =>
    v && (vocab?.fields[field]?.values ?? []).includes(v) ? v : null;
  return {
    ...f,
    ...c,
    bhkMin: f.bhkMin ?? x.bhkMin ?? null,
    bhkMax: f.bhkMax ?? x.bhkMax ?? null,
    areaMin: f.areaMin ?? x.areaSqftMin ?? null,
    areaMax: f.areaMax ?? x.areaSqftMax ?? null,
    areaBasis: f.areaBasis ?? asAreaBasis(x.areaBasis),
    priceMin: f.priceMin ?? (kind === 'sale' ? x.salePriceInrMin : kind === 'rent' ? x.rentMonthlyInrMin : null) ?? null,
    priceMax: f.priceMax ?? (kind === 'sale' ? x.salePriceInrMax : kind === 'rent' ? x.rentMonthlyInrMax : null) ?? null,
    locality: f.locality || x.locality || '',
    tags: {
      ...f.tags,
      furnishing: f.tags.furnishing ?? tagPick('furnishing', x.furnishing),
      tenancyStatus: f.tags.tenancyStatus ?? tagPick('tenancy_status', x.tenancyStatus),
      saleMode: f.tags.saleMode ?? tagPick('sale_mode', x.saleMode),
    },
  };
}

/** Add supply prefilled from the demand it is for (US-05 AC1). Supply cannot be market Any. */
export function prefillFromDemand(d: S['Demand'], vocab: Vocabulary | undefined): RecordForm {
  let c: Classification = { side: 'Supply', dealType: null, market: null, segment: null, propertyType: null };
  const deal = d.dealTypes?.find((t) => propertyDealTypes(vocab).includes(t)) ?? null;
  c = setClassification(c, 'dealType', deal, vocab);
  if (needsMarket(c.dealType) && d.market && d.market !== 'Any') c = setClassification(c, 'market', d.market, vocab);
  c = setClassification(c, 'segment', d.segment ?? null, vocab);
  const pt = d.propertyTypes?.find((t) => propertyTypesFor(vocab, c.segment).includes(t)) ?? null;
  c = setClassification(c, 'propertyType', pt, vocab);
  const kind = budgetKind(c.dealType);
  const t = d.statedTags ?? {};
  return {
    ...emptyForm('Supply'),
    ...c,
    bhkMin: d.bhkMin ?? null,
    bhkMax: d.bhkMax ?? null,
    areaMin: d.areaSqftMin ?? null,
    areaMax: d.areaSqftMax ?? null,
    areaBasis: asAreaBasis(d.areaBasis),
    priceMin: (kind === 'sale' ? d.budgetInrMin : kind === 'rent' ? d.rentMonthlyInrMin : null) ?? null,
    priceMax: (kind === 'sale' ? d.budgetInrMax : kind === 'rent' ? d.rentMonthlyInrMax : null) ?? null,
    locality: d.localities?.[0] ?? '',
    tags: {
      saleMode: t.saleMode ?? null,
      tenancyStatus: t.tenancyStatus ?? null,
      tenure: t.tenure ?? null,
      agreementForm: t.agreementForm ?? null,
      possessionStatus: t.possessionStatus ?? null,
      furnishing: t.furnishing ?? null,
      isJodi: t.isJodi ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Add supply requests (C-07)

export const PARTY_ROLES = ['Seller', 'Landlord', 'Developer', 'Landowner', 'Society', 'Outgoing tenant', 'Broker', 'Contact'] as const;

export interface PartyDraft {
  phone: string;
  name: string;
  role: string | null;
}

export function buildParties(p: PartyDraft | null | undefined): S['PartyInput'][] {
  if (!p || !p.phone.trim() || !p.role) return [];
  const name = p.name.trim();
  return [{ role: p.role, newPerson: { phones: [p.phone.trim()], ...(name ? { name } : {}) } }];
}

export function buildDedupRequest(f: RecordForm, extras: PropertyExtras, party?: PartyDraft | null): S['DedupCheckRequest'] {
  const phone = party?.phone.trim();
  return {
    property: buildPropertyInput(f, extras),
    dealType: f.dealType,
    ...(phone ? { phones: [phone] } : {}),
  };
}

/** Where the new supply goes: an existing property (picked from the duplicate check) or a new one. */
export type PropertyChoice = { existingPropertyId: string } | { newProperty: true; confirmNewDespiteCandidates: boolean };

export function buildAddSupplyRequest(
  f: RecordForm,
  extras: PropertyExtras,
  choice: PropertyChoice,
  party?: PartyDraft | null,
): S['AddSupplyRequest'] {
  const parties = buildParties(party);
  return {
    offer: buildOfferInput(f),
    sourceType: 'Direct',
    ...(parties.length ? { parties } : {}),
    ...('existingPropertyId' in choice
      ? { existingPropertyId: choice.existingPropertyId, confirmNewDespiteCandidates: false }
      : { property: buildPropertyInput(f, extras), confirmNewDespiteCandidates: choice.confirmNewDespiteCandidates }),
  };
}

/** Without a demand: a further offer on an existing property (POST /v1/offers, US-13). */
export function buildCreateOfferRequest(f: RecordForm, propertyId: string): S['OfferCreate'] {
  return { propertyId, offer: buildOfferInput(f), sourceType: 'Direct' };
}

/** Without a demand, on a new property: POST /v1/properties (the contract's create for property + offers). */
export function buildCreatePropertyRequest(
  f: RecordForm,
  extras: PropertyExtras,
  confirmNewDespiteCandidates: boolean,
  party?: PartyDraft | null,
): S['PropertyCreate'] {
  const parties = buildParties(party);
  return {
    property: buildPropertyInput(f, extras),
    offers: [buildOfferInput(f)],
    sourceType: 'Direct',
    confirmNewDespiteCandidates,
    ...(parties.length ? { parties } : {}),
  };
}

/** Which request add supply sends (US-05; contract: add-supply needs a demand, createOffer an existing property). */
export function addSupplyRoute(demand: string | null | undefined, choice: PropertyChoice): 'add-supply' | 'offer' | 'property' {
  if (demand) return 'add-supply';
  return 'existingPropertyId' in choice ? 'offer' : 'property';
}

// ---------------------------------------------------------------------------------------------------------------
// Results

export interface CreatedCodes {
  outcome: string;
  codes: string[];
  demandCode: string | null;
  offerCodes: string[];
}

export function codesFromQuickAdd(r: S['QuickAddResult']): CreatedCodes {
  const offerCodes = (r.offers ?? []).map((o) => o.code).filter(Boolean);
  const demandCode = r.demand?.code ?? null;
  return { outcome: r.outcome, codes: [...(demandCode ? [demandCode] : []), ...offerCodes], demandCode, offerCodes };
}

export function quickAddOutcomeText(r: CreatedCodes): string {
  switch (r.outcome) {
    case 'touch_added':
      return `Touch added to ${r.demandCode ?? 'the existing demand'} (first-touch credit unchanged)`;
    case 'offers_created':
      return `Created ${r.offerCodes.join(', ') || 'the offer'}`;
    default:
      return `Created ${r.demandCode ?? 'the demand'}`;
  }
}

/** Candidates attached to a 409 duplicate-property-suspected problem (ProblemWithCandidates). */
export function candidatesOf(problem: unknown): S['PropertyCandidate'][] {
  if (!problem || typeof problem !== 'object') return [];
  const c = (problem as { candidates?: unknown }).candidates;
  return Array.isArray(c) ? (c as S['PropertyCandidate'][]).filter((x) => x && typeof x.propertyId === 'string') : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Roles (contract x-roles; the service re-checks)

export const ROLES = {
  quickAdd: ['Admin', 'Manager', 'Demand agent', 'Supply agent'],
  addSupplyForDemand: ['Admin', 'Manager', 'Supply agent', 'Demand agent'],
  createOffer: ['Admin', 'Manager', 'Supply agent'],
  dedupCheck: ['Admin', 'Manager', 'Supply agent', 'Demand agent'],
  addTouch: ['Admin', 'Manager', 'Demand agent'],
  flagPerson: ['Admin', 'Manager', 'Supply agent', 'Demand agent'],
  removeFlag: ['Admin', 'Manager'],
  patchDeskItem: ['Admin', 'Manager'],
  completeWatchlistTask: ['Admin', 'Manager', 'Supply agent'],
} as const satisfies Record<string, readonly RoleCode[]>;

export const roleAllows = (role: string, allowed: readonly string[]): boolean => allowed.includes(role);

// ---------------------------------------------------------------------------------------------------------------
// Status axes (BRD §4.4)

export const OFFER_RECORD_STAGES = ['Captured', 'Enriched', 'Contacted', 'Verified', 'Qualified'] as const;
export const DEMAND_RECORD_STAGES = ['Captured', 'Enriched', 'Verified', 'Qualified'] as const;
export const OFFER_COMMERCIAL = ['Upcoming', 'Available', 'Matched', 'In proposal', 'Site visit', 'In process', 'Closed'] as const;
export const DEMAND_COMMERCIAL = [
  'New',
  'Contacted',
  'Active',
  'Sourcing',
  'Matched',
  'Proposal shared',
  'Site visit',
  'In process',
  'Closed',
] as const;
export const PUBLICATION_LEVELS = ['Private', 'Anonymous', 'Public'] as const;

/** Offer / demand price line: "₹1.2 Cr – ₹1.5 Cr" style via a formatter. */
export function rangeText(
  min: number | null | undefined,
  max: number | null | undefined,
  fmt: (n: number) => string,
): string | null {
  if (min != null && max != null) return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  if (min != null) return `from ${fmt(min)}`;
  if (max != null) return `up to ${fmt(max)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Desks (P-08): tab label ↔ GET /v1/desks/{desk} enum

export type DeskKey = S['DeskItem']['desk'];
export const DESK_TABS = [
  { label: 'Business Desk', desk: 'business' },
  { label: 'Capital Desk', desk: 'capital' },
  { label: 'Archive (Equipment)', desk: 'archive' },
  { label: 'Network (Market Participants)', desk: 'network' },
  { label: 'Watchlist', desk: 'watchlist' },
] as const satisfies readonly { label: string; desk: DeskKey }[];
export type DeskTabLabel = (typeof DESK_TABS)[number]['label'];
export const DESK_TAB_LABELS: readonly DeskTabLabel[] = DESK_TABS.map((t) => t.label);

export const deskForTab = (label: DeskTabLabel): DeskKey => DESK_TABS.find((t) => t.label === label)!.desk;
export const tabForDesk = (desk: string): DeskTabLabel | null => DESK_TABS.find((t) => t.desk === desk)?.label ?? null;

export const DESK_NOTES: Record<DeskKey, string> = {
  business: 'Stored and viewable only in Phase 1; no journey. Managers can assign or archive.',
  capital: 'Stored and viewable only in Phase 1; no journey. Managers can assign or archive.',
  archive: 'Equipment. Stored and viewable only; managers can assign or archive.',
  network: 'Market Participants: people with a participant role.',
  watchlist: 'Market Signals. Each has a follow-up task for the supply team; deadlines in the next 14 days show first.',
};

/** Rows of the network desk are people (PER-…); every other desk row is a desk item. */
export const deskRowPanel = (desk: DeskKey): 'person' | 'desk-item' => (desk === 'network' ? 'person' : 'desk-item');

/** Days until a deadline (negative = past); null when there is none or it does not parse. */
export function daysUntil(isoDate: string | null | undefined, now: number = Date.now()): number | null {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / 86_400_000);
}

/** Watchlist order (US-36 AC2): deadlines within 14 days first (soonest first), then later deadlines, then none. */
export function sortWatchlist<T extends { deadlineDate?: string | null }>(items: readonly T[], now: number = Date.now()): T[] {
  const rank = (x: T) => {
    const d = daysUntil(x.deadlineDate, now);
    if (d == null) return [2, Number.MAX_SAFE_INTEGER] as const;
    return [d <= 14 ? 0 : 1, d] as const;
  };
  return [...items].sort((a, b) => {
    const [ra, da] = rank(a);
    const [rb, db] = rank(b);
    return ra - rb || da - db;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Contact reveal (R-VIS-3)

export const REVEAL_PURPOSES = [
  { value: 'call', label: 'Call' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'review', label: 'Review' },
  { value: 'visit', label: 'Site visit' },
  { value: 'other', label: 'Other' },
] as const;
export type RevealPurpose = (typeof REVEAL_PURPOSES)[number]['value'];

export function buildRevealRequest(
  subjectType: S['RevealRequest']['subjectType'],
  subjectId: string,
  purpose: RevealPurpose,
): S['RevealRequest'] {
  return { subjectType, subjectId, purpose, via: 'ui' };
}

export const FLAG_LABELS: Record<S['FlagRequest']['flag'], string> = {
  invalid: 'Invalid',
  broker_posing: 'Broker posing as client',
  unwilling: 'Unwilling',
  anonymous_shares_only: 'Anonymous shares only',
  unreachable: 'Unreachable',
};
