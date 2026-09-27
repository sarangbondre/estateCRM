// Proposals (C-13, US-23, D-11; LLD §4.6): the content snapshot is built from an allow-list, so owner/broker names,
// phones, emails, unit and wing can never reach the PDF or the public page.
export const PROPOSAL_STATUSES = ['Preparing', 'Ready', 'Sent', 'Failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const FEEDBACK_VERDICTS = ['liked', 'rejected', 'visit_requested', 'maybe'] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const MAX_LINK_DAYS = 14;
export const MAX_PHOTOS_PER_OPTION = 30;
export const SNAPSHOT_MAX_ATTEMPTS = 3;
/** Shown when listings has no MahaRERA agent number yet (questionnaire A7, pilot). */
export const RERA_PENDING = 'MahaRERA registration pending';

export function linkExpiryDays(requested: number | null | undefined): number {
  return Math.min(MAX_LINK_DAYS, Math.max(1, Math.trunc(requested ?? MAX_LINK_DAYS)));
}

/** Offer content as read from records (GET /v1/offers/{id}); only allow-listed fields are copied. */
export interface OfferContent {
  id: string;
  code?: string;
  dealType: string;
  segment?: string | null;
  propertyTypes?: string[] | null;
  bhkMin?: number | null;
  bhkMax?: number | null;
  areaSqftMin?: number | null;
  areaSqftMax?: number | null;
  areaBasis?: 'Carpet' | 'Builtup' | 'Saleable' | null;
  locality?: string | null;
  micromarket?: string | null;
  salePriceInrMin?: number | null;
  salePriceInrMax?: number | null;
  rentMonthlyInrMin?: number | null;
  rentMonthlyInrMax?: number | null;
  depositInr?: number | null;
  possessionStatus?: string | null;
  possessionDate?: string | null;
  furnishing?: string | null;
  [other: string]: unknown;
}

/** Property content (GET /v1/properties/{id}): building name is allowed (proposals only), unit/wing never. */
export interface PropertyContent {
  id: string;
  buildingName?: string | null;
  [other: string]: unknown;
}

export interface SnapshotPhoto {
  path: string;
  caption: string | null;
}

export interface SnapshotOption {
  position: number;
  title: string;
  buildingName: string | null;
  micromarket: string | null;
  locality: string | null;
  dealType: string;
  segment: string;
  propertyTypes: string[];
  builtupAreaSqft: number | null;
  carpetAreaSqft: number | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  areaBasis: 'Carpet' | 'Builtup' | 'Saleable' | null;
  salePriceInrMin: number | null;
  salePriceInrMax: number | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  depositInr: number | null;
  availableFrom: string | null;
  furnishing: string | null;
  projectRera: string | null;
  photos: SnapshotPhoto[];
  bundleOf: number | null;
  offerIds: string[];
}

export interface Snapshot {
  preparedFor: string | null;
  agentRera: string;
  coverNote: string | null;
  options: SnapshotOption[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** A generated title: "2 BHK Apartment for Lease, Andheri East" (labels only). */
export function optionTitle(o: OfferContent): string {
  const bhk = num(o.bhkMin);
  const type = o.propertyTypes?.[0] ?? o.segment ?? 'Property';
  const where = o.micromarket ?? o.locality ?? null;
  const head = `${bhk ? `${bhk} BHK ` : ''}${type} for ${o.dealType}`;
  return (where ? `${head}, ${where}` : head).slice(0, 200);
}

/**
 * Builds one option from allow-listed fields of the first offer (a bundle lists the others in bundleOf/offerIds).
 * Anything not named here (contacts, unit, wing, descriptions) is dropped.
 */
export function buildOption(
  position: number,
  offers: readonly OfferContent[],
  property: PropertyContent | null,
  photos: readonly SnapshotPhoto[],
  projectRera: string | null,
): SnapshotOption {
  const o = offers[0] as OfferContent;
  const basis = o.areaBasis ?? null;
  const area = num(o.areaSqftMin);
  return {
    position,
    title: optionTitle(o),
    buildingName: str(property?.buildingName, 200),
    micromarket: str(o.micromarket, 100),
    locality: str(o.locality, 100),
    dealType: o.dealType,
    segment: o.segment ?? 'Residential',
    propertyTypes: (o.propertyTypes ?? []).slice(0, 10),
    builtupAreaSqft: basis === 'Builtup' ? area : null,
    carpetAreaSqft: basis === 'Carpet' ? area : null,
    areaSqftMin: area,
    areaSqftMax: num(o.areaSqftMax),
    areaBasis: basis,
    salePriceInrMin: num(o.salePriceInrMin),
    salePriceInrMax: num(o.salePriceInrMax),
    rentMonthlyInrMin: num(o.rentMonthlyInrMin),
    rentMonthlyInrMax: num(o.rentMonthlyInrMax),
    depositInr: num(o.depositInr),
    availableFrom: o.possessionStatus === 'Available From' ? str(o.possessionDate, 10) : null,
    furnishing: str(o.furnishing, 40),
    projectRera: str(projectRera, 40),
    photos: photos.slice(0, MAX_PHOTOS_PER_OPTION).map((p) => ({ path: p.path, caption: str(p.caption, 100) })),
    bundleOf: offers.length > 1 ? offers.length : null,
    offerIds: offers.map((x) => x.id),
  };
}

/** "Office, Andheri East": a label for the demand, never the client's name. */
export function preparedForLabel(d: { propertyTypes: readonly string[]; micromarkets: readonly string[] }): string | null {
  const parts = [d.propertyTypes[0], d.micromarkets[0]].filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 80) : null;
}
