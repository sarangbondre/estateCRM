// Matchable projection and matching vocabulary (LLD §3.2, §4). Pure data: ids, codes, controlled values, numbers and
// dates only. No names, phones, emails, building names, unit details or free text (PII-free by design, LLD §7).

/** Calendar date 'YYYY-MM-DD' (IST business dates). */
export type IsoDate = string;

export type AreaBasis = 'Carpet' | 'Builtup' | 'Saleable';

export type OfferLifeStage = 'Fresh' | 'Ageing' | 'Stale' | 'Expired' | 'Paused';
export type OfferCommercialStatus =
  'Upcoming' | 'Available' | 'Matched' | 'In proposal' | 'Site visit' | 'In process' | 'Closed' | 'Inactive';

export interface OfferMx {
  id: string;
  tenantId: string;
  code: string;
  propertyId: string;
  projectId: string | null;
  /** Opaque hash of the building identity (never the name). */
  buildingKey: string | null;
  dealType: string;
  market: string | null;
  segment: string | null;
  propertyTypes: string[];
  bhkMin: number | null;
  bhkMax: number | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  areaBasis: AreaBasis | null;
  landAreaSqft: number | null;
  salePriceInrMin: number | null;
  salePriceInrMax: number | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  depositInr: number | null;
  currentRentInr: number | null;
  micromarket: string | null;
  locality: string | null;
  /** Node keys: most specific node + ancestors up to micromarket level (LLD §4.8). */
  mmPath: string[];
  outsideLaunchArea: boolean;
  tenancyStatus: string | null;
  saleMode: string | null;
  possessionStatus: string | null;
  possessionDateRaw: string | null;
  tenure: string | null;
  agreementForm: string | null;
  isJodi: boolean | null;
  parking: number | null;
  amenities: string[];
  floorBand: string | null;
  totalFloors: number | null;
  priceSheetDate: IsoDate | null;
  lastSeenDate: IsoDate | null;
  furnishing: string | null;
  unitCount: number | null;
  recordStage: string | null;
  lifeStage: string;
  commercialStatus: string;
  voided: boolean;
  mergedInto: string | null;
  factsVersion: number;
}

export interface DemandMx {
  id: string;
  tenantId: string;
  code: string;
  dealTypes: string[];
  market: string | null;
  segment: string | null;
  propertyTypes: string[];
  bhkMin: number | null;
  bhkMax: number | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  areaBasis: AreaBasis | null;
  budgetInrMin: number | null;
  budgetInrMax: number | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  micromarkets: string[];
  localities: string[];
  /** Listed nodes + descendants + parent micromarket of listed localities (LLD §4.8). */
  mmExpanded: string[];
  moveInFrom: IsoDate | null;
  moveInBy: IsoDate | null;
  /** Controlled values the client stated (tenancy_status, sale_mode, furnishing, parking, amenity:<name>, ...). */
  statedTags: Record<string, string>;
  outsideLaunchArea: boolean;
  recordStage: string | null;
  qualified: boolean;
  lifeStage: string;
  commercialStatus: string;
  exitType: string | null;
  voided: boolean;
  mergedInto: string | null;
}

export const FACTORS = ['micromarket', 'price', 'area', 'bhk', 'timing', 'furnishing'] as const;
export type FactorName = (typeof FACTORS)[number];

export const FLAGS = ['price_above_budget', 'reconfirm', 'area_basis_unknown', 'market_unknown'] as const;
export type MatchFlag = (typeof FLAGS)[number];

export interface FactorResult {
  factor: FactorName;
  weight: number;
  value: number;
  points: number;
  applicable: boolean;
  note?: string;
}

export type HardFilterName =
  | 'side'
  | 'record_scope'
  | 'launch_area'
  | 'offer_live'
  | 'demand_live'
  | 'deal_type'
  | 'market'
  | 'segment'
  | 'property_type'
  | 'stated_tags'
  | 'micromarket'
  | 'possession_window';

export interface FilterCheck {
  filter: HardFilterName;
  passed: boolean;
  detail?: string;
}

export const EXCLUSION_REASONS = [
  'available_too_late',
  'offer_expired',
  'offer_inactive',
  'demand_stale',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const MATCH_STATUSES = ['Suggested', 'Confirmed', 'Rejected', 'Closed'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const CLOSE_REASONS = [
  'leased_to_another_client',
  'sold_to_another_client',
  'offer_retired',
  'offer_expired',
  'demand_exited',
  'demand_closed',
  'deal_closed',
  'superseded',
  'merged',
  'voided',
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const REOPEN_REASONS = [
  'deal_cancelled',
  'merge_undone',
  'offer_reactivated',
  'demand_reactivated',
] as const;
export type ReopenReason = (typeof REOPEN_REASONS)[number];

export const REJECT_REASONS = [
  'too_expensive',
  'wrong_location',
  'too_small',
  'too_large',
  'timing',
  'wrong_type',
  'client_not_interested',
  'already_seen',
  'owner_unwilling',
  'other',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type BundleGrouping = 'same_building' | 'same_micromarket' | 'adjacent_micromarket';

/** Reserved system actor for automatic actions (R-7, JB-8). */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';
