// Domain model of listings (LLD §3–§4). Pure data: no framework, ORM or I/O types.

export const LEVELS = ['Private', 'Anonymous', 'Public'] as const;
export type Level = (typeof LEVELS)[number];
export type VisibleLevel = Exclude<Level, 'Private'>;

export type SubjectType = 'offer' | 'project' | 'demand_post';
/** Subject type as the public API and change feed name it. */
export type PublicSubjectType = 'listing' | 'project' | 'demand_post';

export const publicSubjectType = (t: SubjectType): PublicSubjectType => (t === 'offer' ? 'listing' : t);

export type LifeStage = 'Fresh' | 'Ageing' | 'Stale' | 'Expired' | 'Paused';

/** Offer facts as last received from records and journeys events (offer_input). */
export interface OfferFacts {
  id: string;
  code: string;
  propertyId: string;
  projectId: string | null;
  dealType: string;
  market: string | null;
  segment: string | null;
  propertyTypes: string[];
  bhkMin: number | null;
  bhkMax: number | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  areaBasis: 'Carpet' | 'Builtup' | 'Saleable' | null;
  landAreaSqft: number | null;
  salePriceInrMin: number | null;
  salePriceInrMax: number | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  locality: string | null;
  micromarket: string | null;
  city: string | null;
  outsideLaunchArea: boolean;
  tenancyStatus: string | null;
  saleMode: string | null;
  possessionStatus: string | null;
  furnishing: string | null;
  possessionDate: string | null;
  unitCount: number | null;
  floorBand: 'Low' | 'Mid' | 'High' | null;
  totalFloors: number | null;
  parking: number | null;
  amenities: string[];
  selectedPhotoIds: string[];
  voidedReason: string | null;
  recordStage: string | null;
  hasRealPhotos: boolean;
  commercialStatus: string | null;
  lifeStage: LifeStage | null;
  lifeDay: number | null;
  retiredReason: string | null;
  mergedIntoId: string | null;
  recordsVersion: number;
  journeysVersion: number;
}

export interface ProjectFacts {
  id: string;
  code: string;
  name: string;
  developerName: string | null;
  city: string | null;
  micromarket: string | null;
  locality: string | null;
  reraNumber: string | null;
  possessionDate: string | null;
  amenities: string[];
  offerIds: string[];
  recordsVersion: number;
}

export interface DemandFacts {
  id: string;
  code: string;
  dealTypes: string[];
  market: string | null;
  segment: string | null;
  propertyTypes: string[];
  micromarkets: string[];
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  areaBasis: 'Carpet' | 'Builtup' | 'Saleable' | null;
  budgetInrMin: number | null;
  budgetInrMax: number | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  moveInBy: string | null;
  status: string | null;
  lifeStage: LifeStage | null;
  exitType: string | null;
  matched: boolean;
  postRequested: boolean;
  sourcingRequestId: string | null;
  voidedReason: string | null;
  mergedIntoId: string | null;
  recordsVersion: number;
  journeysVersion: number;
}

export type ChangeReason =
  'user' | 'ceiling_dropped' | 'closed' | 'retired' | 'expired' | 'merged' | 'voided';

export interface Publication {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  level: Level;
  ceiling: Level;
  ceilingReasons: string[];
  lifeStage: string | null;
  publicId: string | null;
  /** Staff-edited text (PII-possible until scanned). Null = generated. */
  publicDescription: string | null;
  descriptionSource: 'generated' | 'staff';
  lastScanId: string | null;
  lastChangeReason: ChangeReason | null;
  lastChangedBy: string | null;
  publishedAt: Date | null;
  version: number;
  updatedAt: Date;
}

export interface PublicationSettings {
  mahareraAgentNumber: string | null;
  note: string;
  version: number;
  updatedAt: Date;
  updatedBy: string | null;
}

export type PhotoStatus = 'pending' | 'ready' | 'failed' | 'removed';

export interface PhotoInfo {
  id: string;
  propertyId: string;
  isReal: boolean;
  status: PhotoStatus;
  hasTextDetected: boolean | null;
  publicPath: string | null;
  publicName: string | null;
  width: number | null;
  height: number | null;
  sortOrder: number;
}

/** The reserved system actor (R-7). */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export const DEFAULT_NOTE = 'Details subject to confirmation';
/** Shown instead of the agent number while it is not set (pilot only, questionnaire A7). */
export const RERA_PENDING = 'MahaRERA registration pending';
