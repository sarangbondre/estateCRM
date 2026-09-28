// Sanitised public projection (PRD §8.3, LLD §4.7). Every public payload is built here from an explicit field
// allow-list: nothing is copied wholesale from inputs, labels are generated, unknown values are null.
import { demandLabel, headline, resolvedSegment, supplyLabel } from './labels.js';
import type { DemandFacts, Level, OfferFacts, ProjectFacts, VisibleLevel } from './types.js';
import { RERA_PENDING } from './types.js';

export interface PublicPhoto {
  url: string;
  width?: number;
  height?: number;
}

export interface CommonContext {
  publicId: string;
  /** null → "MahaRERA registration pending" (pilot only, questionnaire A7). */
  agentReraNumber: string | null;
  note: string;
  publishedAt: Date;
  updatedAt: Date;
}

export const agentRera = (n: string | null) => n ?? RERA_PENDING;

// ---- offers --------------------------------------------------------------------------------------------------------

/** Keys an Anonymous offer may carry (PublicOfferBase). The contract test fails on any other key. */
export const ANONYMOUS_OFFER_KEYS = [
  'publicId',
  'level',
  'label',
  'headline',
  'dealType',
  'market',
  'segment',
  'propertyTypes',
  'bhkMin',
  'bhkMax',
  'city',
  'micromarket',
  'locality',
  'areaSqftMin',
  'areaSqftMax',
  'areaBasis',
  'landAreaSqft',
  'salePriceInrMin',
  'salePriceInrMax',
  'rentMonthlyInrMin',
  'rentMonthlyInrMax',
  'possessionDate',
  'saleMode',
  'tenancyStatus',
  'furnishing',
  'note',
  'agentReraNumber',
  'projectPublicId',
  'projectReraNumber',
  'publishedAt',
  'updatedAt',
] as const;
/** Extra keys of a Public offer. */
export const PUBLIC_OFFER_EXTRA_KEYS = [
  'photos',
  'floorBand',
  'parking',
  'amenities',
  'possessionStatus',
  'description',
] as const;
export const PROJECT_KEYS = [
  'publicId',
  'label',
  'name',
  'developerName',
  'city',
  'micromarket',
  'locality',
  'configurations',
  'possessionDate',
  'amenities',
  'floorPlans',
  'photos',
  'projectReraNumber',
  'agentReraNumber',
  'publishedAt',
  'updatedAt',
] as const;
export const CONFIGURATION_KEYS = [
  'listingPublicId',
  'propertyType',
  'bhkMin',
  'bhkMax',
  'areaSqftMin',
  'areaSqftMax',
  'areaBasis',
  'priceInrFrom',
  'unitsAvailableBand',
] as const;
export const DEMAND_POST_KEYS = [
  'publicId',
  'label',
  'dealTypes',
  'segment',
  'propertyTypes',
  'micromarkets',
  'areaSqftMin',
  'areaSqftMax',
  'areaBasis',
  'budgetBandInr',
  'rentBandMonthlyInr',
  'timing',
  'agentReraNumber',
  'publishedAt',
  'updatedAt',
] as const;

const usesSalePrice = (dealType: string) => dealType !== 'Lease';

/** Label + segment resolve, so the offer has a public shape at all. */
export function offerClassifiable(o: OfferFacts): boolean {
  const segment = resolvedSegment(o.segment, o.propertyTypes);
  return segment !== null && supplyLabel(o.dealType, o.market, segment) !== null;
}

export interface OfferProjectionInput extends CommonContext {
  offer: OfferFacts;
  level: VisibleLevel;
  projectPublicId: string | null;
  projectReraNumber: string | null;
  /** Public items only: processed public copies of the selected photos, in selection order. */
  photos: PublicPhoto[];
  /** Staff-edited description; null → generated. */
  staffDescription: string | null;
}

export function publicOffer(input: OfferProjectionInput): Record<string, unknown> {
  const o = input.offer;
  const segment = resolvedSegment(o.segment, o.propertyTypes);
  const label = supplyLabel(o.dealType, o.market, segment) ?? '';
  const sale = usesSalePrice(o.dealType);
  const base: Record<string, unknown> = {
    publicId: input.publicId,
    level: input.level,
    label,
    headline: headline({
      bhkMin: o.bhkMin,
      bhkMax: o.bhkMax,
      propertyTypes: o.propertyTypes,
      label,
      locality: o.locality,
      micromarket: o.micromarket,
    }),
    dealType: o.dealType,
    market: o.market,
    segment,
    propertyTypes: [...o.propertyTypes],
    bhkMin: o.bhkMin,
    bhkMax: o.bhkMax,
    city: o.city,
    micromarket: o.micromarket,
    locality: o.locality,
    areaSqftMin: o.areaSqftMin,
    areaSqftMax: o.areaSqftMax,
    areaBasis: o.areaBasis,
    landAreaSqft: o.landAreaSqft,
    salePriceInrMin: sale ? o.salePriceInrMin : null,
    salePriceInrMax: sale ? o.salePriceInrMax : null,
    rentMonthlyInrMin: sale ? null : o.rentMonthlyInrMin,
    rentMonthlyInrMax: sale ? null : o.rentMonthlyInrMax,
    possessionDate: o.possessionDate,
    saleMode: o.saleMode,
    tenancyStatus: o.tenancyStatus,
    furnishing: o.furnishing,
    note: input.note,
    agentReraNumber: agentRera(input.agentReraNumber),
    projectPublicId: input.projectPublicId,
    projectReraNumber: input.projectReraNumber,
    publishedAt: input.publishedAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
  if (input.level !== 'Public') return base;
  return {
    ...base,
    photos: input.photos.slice(0, 30).map((p) => ({ ...p })),
    floorBand: o.floorBand,
    parking: o.parking,
    amenities: [...o.amenities],
    possessionStatus: o.possessionStatus,
    description: input.staffDescription ?? generatedDescription(o),
  };
}

// ---- generated description (Public offers) -------------------------------------------------------------------------

const INDIAN = new Intl.NumberFormat('en-IN');

/** "₹1.25 Cr", "₹85 L", "₹45,000". */
export function formatInr(n: number): string {
  if (n >= 1_00_00_000) return `₹${trim(n / 1_00_00_000)} Cr`;
  if (n >= 1_00_000) return `₹${trim(n / 1_00_000)} L`;
  return `₹${INDIAN.format(n)}`;
}
const trim = (n: number) => String(Number(n.toFixed(2)));

const range = (lo: number | null, hi: number | null, fmt: (n: number) => string): string | null => {
  if (lo === null && hi === null) return null;
  if (lo !== null && hi !== null && lo !== hi) return `${fmt(lo)} to ${fmt(hi)}`;
  return fmt((lo ?? hi) as number);
};

/**
 * Description built only from allow-listed public fields. It is scanned like staff text (defence in depth) and must
 * pass by construction: no numbers directly before a unit word, no floor numbers, no addresses.
 */
export function generatedDescription(o: OfferFacts): string {
  const segment = resolvedSegment(o.segment, o.propertyTypes);
  const label = supplyLabel(o.dealType, o.market, segment) ?? 'Available';
  const types = o.propertyTypes.length ? o.propertyTypes.join(' / ') : 'Property';
  const bhk =
    o.bhkMin !== null || o.bhkMax !== null
      ? `${range(o.bhkMin, o.bhkMax, (n) => (n === 0.5 ? '1 RK' : String(n)))}${o.bhkMin === 0.5 && o.bhkMax === 0.5 ? '' : ' BHK'} `
      : '';
  const place = [o.locality, o.micromarket !== o.locality ? o.micromarket : null, o.city]
    .filter(Boolean)
    .join(', ');
  const sentences = [`${bhk}${types}, ${label.toLowerCase()}${place ? `, in ${place}` : ''}.`];
  const area = range(o.areaSqftMin, o.areaSqftMax, (n) => INDIAN.format(n));
  if (area) sentences.push(`Area: ${area} sq ft${o.areaBasis ? ` (${o.areaBasis.toLowerCase()})` : ''}.`);
  if (o.landAreaSqft !== null) sentences.push(`Land area: ${INDIAN.format(o.landAreaSqft)} sq ft.`);
  const price = usesSalePrice(o.dealType)
    ? range(o.salePriceInrMin, o.salePriceInrMax, formatInr)
    : range(o.rentMonthlyInrMin, o.rentMonthlyInrMax, formatInr);
  if (price) sentences.push(usesSalePrice(o.dealType) ? `Price: ${price}.` : `Rent: ${price} per month.`);
  if (o.furnishing) sentences.push(`Furnishing: ${o.furnishing}.`);
  if (o.floorBand) sentences.push(`${o.floorBand} floor band.`);
  if (o.parking !== null && o.parking > 0)
    sentences.push(`Parking: ${o.parking === 1 ? 'one space' : `${o.parking} spaces`}.`);
  if (o.amenities.length) sentences.push(`Amenities: ${o.amenities.join(', ')}.`);
  if (o.possessionStatus) sentences.push(`Possession: ${o.possessionStatus}.`);
  else if (o.possessionDate) sentences.push(`Possession from ${o.possessionDate}.`);
  return sentences.join(' ');
}

// ---- projects ------------------------------------------------------------------------------------------------------

export interface ConfigurationOffer {
  offer: OfferFacts;
  publicId: string | null;
  level: Level;
}

export const unitsBand = (units: number | null): '1-5' | '6-20' | '21-50' | '50+' | null =>
  units === null || units <= 0
    ? null
    : units <= 5
      ? '1-5'
      : units <= 20
        ? '6-20'
        : units <= 50
          ? '21-50'
          : '50+';

export interface ProjectProjectionInput extends CommonContext {
  project: ProjectFacts;
  /** Configuration offers whose own level ≥ Anonymous. */
  configurations: ConfigurationOffer[];
  photos: PublicPhoto[];
}

export function publicProject(input: ProjectProjectionInput): Record<string, unknown> {
  const p = input.project;
  return {
    publicId: input.publicId,
    label: supplyLabel('Sale', 'Primary', null) ?? 'New Project, For Sale',
    name: p.name,
    developerName: p.developerName,
    city: p.city,
    micromarket: p.micromarket,
    locality: p.locality,
    configurations: input.configurations.map((c) => ({
      listingPublicId: c.publicId,
      propertyType: c.offer.propertyTypes[0] ?? 'Apartment',
      bhkMin: c.offer.bhkMin,
      bhkMax: c.offer.bhkMax,
      areaSqftMin: c.offer.areaSqftMin,
      areaSqftMax: c.offer.areaSqftMax,
      areaBasis: c.offer.areaBasis,
      priceInrFrom: c.offer.salePriceInrMin,
      unitsAvailableBand: unitsBand(c.offer.unitCount),
    })),
    possessionDate: p.possessionDate,
    amenities: [...p.amenities],
    floorPlans: [],
    photos: input.photos.map((x) => ({ ...x })),
    projectReraNumber: p.reraNumber ?? '',
    agentReraNumber: agentRera(input.agentReraNumber),
    publishedAt: input.publishedAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

// ---- demand posts --------------------------------------------------------------------------------------------------

const L = 1_00_000;
const CR = 1_00_00_000;

function saleStep(value: number): number {
  if (value < CR) return 10 * L;
  if (value <= 5 * CR) return 25 * L;
  return CR;
}
const rentStep = (value: number) => (value < L ? 5_000 : 25_000);

function band(min: number | null, max: number | null, step: (v: number) => number) {
  if (min === null && max === null) return null;
  const lo = min ?? (max as number);
  const hi = max ?? (min as number);
  const bandMin = Math.floor(lo / step(lo)) * step(lo);
  const bandMax = Math.ceil(hi / step(hi)) * step(hi);
  return { min: bandMin, max: Math.max(bandMin, bandMax) };
}

/** Rounded budget band (A-L8): never the exact budget. */
export const budgetBand = (min: number | null, max: number | null) => band(min, max, saleStep);
export const rentBand = (min: number | null, max: number | null) => band(min, max, rentStep);

/** Month precision (YYYY-MM). */
export const monthOf = (date: string | null) => (date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null);

export function demandClassifiable(d: DemandFacts): boolean {
  return demandLabel(d.dealTypes, d.market, d.segment) !== null;
}

export interface DemandProjectionInput extends CommonContext {
  demand: DemandFacts;
}

export function publicDemandPost(input: DemandProjectionInput): Record<string, unknown> {
  const d = input.demand;
  const sale = d.dealTypes.some((t) => t !== 'Lease');
  const lease = d.dealTypes.includes('Lease');
  return {
    publicId: input.publicId,
    label: demandLabel(d.dealTypes, d.market, d.segment) ?? '',
    dealTypes: [...d.dealTypes],
    segment: d.segment,
    propertyTypes: [...d.propertyTypes],
    micromarkets: [...d.micromarkets],
    areaSqftMin: d.areaSqftMin,
    areaSqftMax: d.areaSqftMax,
    areaBasis: d.areaBasis,
    budgetBandInr: sale ? budgetBand(d.budgetInrMin, d.budgetInrMax) : null,
    rentBandMonthlyInr: lease ? rentBand(d.rentMonthlyInrMin, d.rentMonthlyInrMax) : null,
    timing: monthOf(d.moveInBy),
    agentReraNumber: agentRera(input.agentReraNumber),
    publishedAt: input.publishedAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

// ---- filters and hashing helpers -----------------------------------------------------------------------------------

/** First day of the period of a YYYY / YYYY-MM / YYYY-MM-DD date (possession sort), else null. */
export function periodStart(date: string | null): string | null {
  if (!date) return null;
  if (/^\d{4}$/.test(date)) return `${date}-01-01`;
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return null;
}

/** Last day of the period (the `possessionBy` filter includes the whole month or year). */
export function periodEnd(date: string): string | null {
  if (/^\d{4}$/.test(date)) return `${date}-12-31`;
  const m = /^(\d{4})-(\d{2})$/.exec(date);
  if (m) {
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return `${date}-${String(last).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return null;
}

/** Locality + micromarket + every ancestor (micromarket hierarchy, R-13), de-duplicated. */
export function micromarketPath(
  names: readonly (string | null)[],
  ancestors: Readonly<Record<string, readonly string[]>>,
): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    for (const x of [n, ...(ancestors[n] ?? [])]) if (!out.includes(x)) out.push(x);
  }
  return out;
}

/** The payload without its timestamps: two builds with the same content have the same hash. */
export function contentOf(payload: Record<string, unknown>): string {
  const { updatedAt: _u, publishedAt: _p, ...rest } = payload;
  void _u;
  void _p;
  return stableStringify(rest);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
