/**
 * Controlled vocabulary release v0.6 (BRD v0.6 §4.2, PRD Appendix C, CR-003, CR-006).
 *
 * Values use the exact BRD spelling. Adding, removing or renaming a value is a change to the standard,
 * owned by Vinit and Priyanka (PRD D-16), and ships as a new release file with a version bump.
 */

export const VOCABULARY_VERSION = '0.6';
/** Release id as used in `vocabulary.released.v1` and `GET /v1/vocabulary` (conventions §8). */
export const VOCABULARY_RELEASE_ID = 'v0.6';

// --- Classification (BRD §4.2) -------------------------------------------------------------------

export const RECORD_SCOPES = [
  'Property',
  'Business',
  'Capital',
  'Equipment',
  'Market Participant',
  'Market Signal',
] as const;
export type RecordScope = (typeof RECORD_SCOPES)[number];

export const SIDES = ['Supply', 'Demand', 'None'] as const;
export type Side = (typeof SIDES)[number];

export const PROPERTY_DEAL_TYPES = ['Sale', 'Lease', 'JV', 'Pagdi'] as const;
export type PropertyDealType = (typeof PROPERTY_DEAL_TYPES)[number];

/** Every deal_type value across all scopes, in BRD order (glossary "deal_type"). */
export const DEAL_TYPES = [
  'Sale',
  'Lease',
  'JV',
  'Pagdi',
  'Partnership',
  'Distribution',
  'Equity',
  'Debt',
  'Project Funding',
  'Asset Sale',
] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const MARKETS = ['Primary', 'Secondary', 'Any'] as const;
export type Market = (typeof MARKETS)[number];

export const SEGMENTS = ['Residential', 'Commercial', 'Industrial', 'Land'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const PROPERTY_TYPES_BY_SEGMENT = {
  Residential: [
    'Apartment',
    'Penthouse',
    'Studio',
    'Villa',
    'Bungalow',
    'Row House',
    'Farmhouse',
    'Building',
    'Serviced Apartment',
  ],
  Commercial: [
    'Office',
    'Shop',
    'Showroom',
    'Restaurant Space',
    'Commercial Building',
    'Coworking',
    'Hotel',
    'Resort',
    'Institutional Building',
    'Commercial Space',
  ],
  Industrial: ['Gala', 'Shed', 'Warehouse', 'Factory', 'Industrial Building', 'Cold Storage'],
  Land: ['Plot', 'Land Parcel', 'Agricultural Land'],
} as const satisfies Record<Segment, readonly string[]>;

export type PropertyTypeOf<S extends Segment> = (typeof PROPERTY_TYPES_BY_SEGMENT)[S][number];
export type PropertyType = PropertyTypeOf<Segment>;

export const PROPERTY_TYPES: readonly PropertyType[] = SEGMENTS.flatMap(
  (segment) => PROPERTY_TYPES_BY_SEGMENT[segment],
);

export const LAND_USES = ['Residential', 'Commercial', 'Industrial', 'Agricultural', 'NA', 'Mixed'] as const;
export type LandUse = (typeof LAND_USES)[number];

// --- Deal tags (BRD §4.2) ------------------------------------------------------------------------

export const SALE_MODES = ['Private', 'Auction'] as const;
export type SaleMode = (typeof SALE_MODES)[number];

export const TENANCY_STATUSES = ['Vacant', 'Tenanted'] as const;
export type TenancyStatus = (typeof TENANCY_STATUSES)[number];

export const TENURES = ['Freehold', 'Leasehold'] as const;
export type Tenure = (typeof TENURES)[number];

export const AGREEMENT_FORMS = ['Leave and License', 'Registered Lease'] as const;
export type AgreementForm = (typeof AGREEMENT_FORMS)[number];

export const POSSESSION_STATUSES = [
  'Ready',
  'Under Construction',
  'Under Redevelopment',
  'Available From',
] as const;
export type PossessionStatus = (typeof POSSESSION_STATUSES)[number];

export const FURNISHINGS = ['Furnished', 'Semi Furnished', 'Unfurnished', 'Bare Shell'] as const;
export type Furnishing = (typeof FURNISHINGS)[number];

// --- Non-property fields (BRD §4.2) --------------------------------------------------------------

export const SECTORS = [
  'Hospitality',
  'Education',
  'Manufacturing',
  'Food and Beverage',
  'Healthcare',
  'Media',
  'Distribution',
  'Agriculture',
  'Technology',
  'Real Estate',
  'Other',
] as const;
export type Sector = (typeof SECTORS)[number];

export const INCLUDES_PROPERTY_VALUES = ['Yes', 'No'] as const;
export type IncludesProperty = (typeof INCLUDES_PROPERTY_VALUES)[number];

export const PARTICIPANT_ROLES = [
  'Broker',
  'Developer',
  'Auctioneer',
  'Architect',
  'PMC',
  'Consultant',
  'Lender',
] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const SIGNAL_TYPES = [
  'Redevelopment Upcoming',
  'Government Tender',
  'Land Policy',
  'Title Notice',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

// --- Upload schema enums (PRD Appendix C, CR-006) ------------------------------------------------

export const PARTY_TYPES = [
  'Owner',
  'Broker',
  'Developer',
  'Company',
  'Bank',
  'Society',
  'Government',
] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const ROUTE_TO_VALUES = [
  'Supply Team',
  'Demand Team',
  'Business Desk',
  'Capital Desk',
  'Archive',
  'Network',
  'Watchlist',
] as const;
export type RouteTo = (typeof ROUTE_TO_VALUES)[number];

export const AREA_BASES = ['Carpet', 'Builtup', 'Saleable'] as const;
export type AreaBasis = (typeof AREA_BASES)[number];

export const LAND_AREA_UNITS = ['acre', 'sqft', 'sqm', 'sqyd', 'gunta', 'bigha'] as const;
export type LandAreaUnit = (typeof LAND_AREA_UNITS)[number];

export const SALE_RATE_UNITS = ['sqft', 'acre', 'sqyd', 'sqm'] as const;
export type SaleRateUnit = (typeof SALE_RATE_UNITS)[number];

export const SOURCE_CHANNELS = ['Newspaper', 'WhatsApp'] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

// --- Field catalogue -----------------------------------------------------------------------------

/** One controlled field: its allowed values and whether it is a pipe list (BRD §4.2, Appendix C). */
export interface FieldDefinition {
  readonly values: readonly string[];
  readonly multi: boolean;
}

/**
 * Every controlled field of the upload schema (intake LLD §4.4 list), keyed by its snake_case name
 * (the `x-vocabulary` name in the contracts).
 */
export const FIELDS = {
  record_scope: { values: RECORD_SCOPES, multi: false },
  deal_type: { values: DEAL_TYPES, multi: true },
  market: { values: MARKETS, multi: false },
  segment: { values: SEGMENTS, multi: false },
  property_type: { values: PROPERTY_TYPES, multi: true },
  land_use: { values: LAND_USES, multi: false },
  side: { values: SIDES, multi: false },
  sale_mode: { values: SALE_MODES, multi: false },
  tenancy_status: { values: TENANCY_STATUSES, multi: false },
  tenure: { values: TENURES, multi: false },
  agreement_form: { values: AGREEMENT_FORMS, multi: false },
  possession_status: { values: POSSESSION_STATUSES, multi: false },
  furnishing: { values: FURNISHINGS, multi: false },
  sector: { values: SECTORS, multi: false },
  includes_property: { values: INCLUDES_PROPERTY_VALUES, multi: false },
  participant_role: { values: PARTICIPANT_ROLES, multi: false },
  signal_type: { values: SIGNAL_TYPES, multi: false },
  party_type: { values: PARTY_TYPES, multi: false },
  route_to: { values: ROUTE_TO_VALUES, multi: false },
  area_basis: { values: AREA_BASES, multi: false },
  land_area_unit: { values: LAND_AREA_UNITS, multi: false },
  sale_rate_unit: { values: SALE_RATE_UNITS, multi: false },
  source_channel: { values: SOURCE_CHANNELS, multi: false },
} as const satisfies Record<string, FieldDefinition>;

export type VocabularyField = keyof typeof FIELDS;
export const VOCABULARY_FIELDS = Object.keys(FIELDS) as readonly VocabularyField[];

/** The canonical value type of a field. */
export type FieldValue<F extends VocabularyField> = (typeof FIELDS)[F]['values'][number];

// --- Record scope rules (BRD §4.2 record_scope table) ---------------------------------------------

export interface RecordScopeRule {
  readonly value: RecordScope;
  /** Empty for Market Participant and Market Signal ("none"). */
  readonly allowedDealTypes: readonly DealType[];
  readonly sides: readonly Side[];
  /** "Routed to" column, verbatim. */
  readonly routedTo: string;
}

export const RECORD_SCOPE_RULES = {
  Property: {
    value: 'Property',
    allowedDealTypes: ['Sale', 'Lease', 'JV', 'Pagdi'],
    sides: ['Supply', 'Demand'],
    routedTo: 'Supply Team or Demand Team',
  },
  Business: {
    value: 'Business',
    allowedDealTypes: ['Sale', 'Lease', 'Partnership', 'Distribution'],
    sides: ['Supply', 'Demand'],
    routedTo: 'Business Desk',
  },
  Capital: {
    value: 'Capital',
    allowedDealTypes: ['Equity', 'Debt', 'Project Funding', 'Asset Sale'],
    sides: ['Supply', 'Demand'],
    routedTo: 'Capital Desk',
  },
  Equipment: {
    value: 'Equipment',
    allowedDealTypes: ['Sale', 'Lease'],
    sides: ['Supply', 'Demand'],
    routedTo: 'Archive',
  },
  'Market Participant': {
    value: 'Market Participant',
    allowedDealTypes: [],
    sides: ['None'],
    routedTo: 'Network',
  },
  'Market Signal': {
    value: 'Market Signal',
    allowedDealTypes: [],
    sides: ['None'],
    routedTo: 'Watchlist',
  },
} as const satisfies { readonly [S in RecordScope]: RecordScopeRule & { readonly value: S } };

// --- Display label table (BRD §4.2 "Display labels") ---------------------------------------------

/** One row of the BRD display label table, verbatim. `null` = the cell is empty in the BRD. */
export interface DisplayLabelRow {
  readonly key: DisplayLabelKey;
  /** The "deal_type" column of the BRD table, verbatim. */
  readonly dealType: string;
  readonly supplyLabel: string | null;
  readonly demandLabel: string | null;
  readonly parties: string;
}

export type DisplayLabelKey =
  'sale_secondary' | 'sale_primary' | 'sale_any' | 'lease_residential' | 'lease_other' | 'jv' | 'pagdi';

export const DISPLAY_LABEL_TABLE = [
  {
    key: 'sale_secondary',
    dealType: 'Sale, Secondary',
    supplyLabel: 'Resale, For Sale',
    demandLabel: 'Wants to Buy, Resale',
    parties: 'Seller and Buyer',
  },
  {
    key: 'sale_primary',
    dealType: 'Sale, Primary',
    supplyLabel: 'New Project, For Sale',
    demandLabel: 'Wants to Buy, New Project',
    parties: 'Developer and Buyer',
  },
  {
    key: 'sale_any',
    dealType: 'Sale, Any (demand)',
    supplyLabel: null,
    demandLabel: 'Wants to Buy',
    parties: 'Buyer',
  },
  {
    key: 'lease_residential',
    dealType: 'Lease, Residential',
    supplyLabel: 'For Rent',
    demandLabel: 'Wants to Rent',
    parties: 'Landlord and Tenant',
  },
  {
    key: 'lease_other',
    dealType: 'Lease, Commercial, Industrial, Land',
    supplyLabel: 'For Lease',
    demandLabel: 'Wants to Lease',
    parties: 'Landlord and Tenant',
  },
  {
    key: 'jv',
    dealType: 'JV',
    supplyLabel: 'For JV',
    demandLabel: 'Wants JV',
    parties: 'Landowner or Society and Developer',
  },
  {
    key: 'pagdi',
    dealType: 'Pagdi',
    supplyLabel: 'Pagdi, For Transfer',
    demandLabel: 'Wants Pagdi',
    parties: 'Outgoing and Incoming tenant',
  },
] as const satisfies readonly DisplayLabelRow[];
