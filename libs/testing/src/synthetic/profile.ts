/**
 * Distributions taken from the PII-free profile of the real extractor master
 * (`docs/inputs/extractor-master-profile.md`, 2,155 records). Counts are used as weights.
 * Only controlled values and numbers are used; no free text or contact value of the real file.
 */
import type {
  DealType,
  LandAreaUnit,
  LandUse,
  ParticipantRole,
  PartyType,
  PossessionStatus,
  PropertyType,
  RecordScope,
  Segment,
  SignalType,
  Furnishing,
} from '@11e/vocabulary';
import type { Weighted } from './rng.js';

export const RECORD_SCOPE_WEIGHTS: Weighted<RecordScope> = [
  ['Property', 2044],
  ['Market Participant', 43],
  ['Business', 37],
  ['Capital', 13],
  ['Equipment', 12],
  ['Market Signal', 6],
];

/** Property deal types (pipe lists as they appear); `null` = deal type not stated. */
export const PROPERTY_DEAL_TYPE_WEIGHTS: Weighted<readonly DealType[] | null> = [
  [['Sale'], 1415],
  [['Lease'], 383],
  [['Sale', 'Lease'], 165],
  [['JV'], 27],
  [['Sale', 'JV'], 23],
  [['Pagdi'], 3],
  [['Sale', 'Lease', 'JV'], 2],
  [null, 60],
];

export const DEMAND_DEAL_TYPE_WEIGHTS: Weighted<readonly DealType[] | null> = [
  [['Sale'], 30],
  [['Lease'], 20],
  [['JV'], 3],
  [['Pagdi'], 1],
  [null, 1],
];

export const BUSINESS_DEAL_TYPE_WEIGHTS: Weighted<readonly DealType[]> = [
  [['Sale'], 18],
  [['Partnership'], 5],
  [['Sale', 'Partnership'], 3],
  [['Lease'], 5],
  [['Lease', 'Partnership'], 2],
  [['Distribution'], 2],
];

export const CAPITAL_DEAL_TYPE_WEIGHTS: Weighted<readonly DealType[]> = [
  [['Equity'], 7],
  [['Project Funding'], 4],
  [['Debt'], 1],
  [['Asset Sale'], 1],
];

export const SEGMENT_WEIGHTS: Weighted<Segment | null> = [
  ['Residential', 1152],
  ['Commercial', 543],
  ['Land', 226],
  ['Industrial', 93],
  [null, 30],
];

export const PROPERTY_TYPE_WEIGHTS: { readonly [S in Segment]: Weighted<PropertyType> } = {
  Residential: [
    ['Apartment', 991],
    ['Bungalow', 35],
    ['Building', 30],
    ['Villa', 25],
    ['Penthouse', 20],
    ['Row House', 12],
    ['Farmhouse', 12],
    ['Studio', 8],
    ['Serviced Apartment', 6],
  ],
  Commercial: [
    ['Office', 239],
    ['Commercial Space', 125],
    ['Shop', 65],
    ['Showroom', 40],
    ['Commercial Building', 18],
    ['Restaurant Space', 16],
    ['Institutional Building', 12],
    ['Coworking', 10],
    ['Hotel', 10],
    ['Resort', 5],
  ],
  Industrial: [
    ['Gala', 28],
    ['Warehouse', 23],
    ['Shed', 14],
    ['Factory', 14],
    ['Industrial Building', 9],
    ['Cold Storage', 5],
  ],
  Land: [
    ['Land Parcel', 107],
    ['Plot', 103],
    ['Agricultural Land', 16],
  ],
};

export const LAND_USE_WEIGHTS: Weighted<LandUse> = [
  ['Industrial', 28],
  ['NA', 24],
  ['Agricultural', 19],
  ['Residential', 10],
  ['Mixed', 10],
  ['Commercial', 9],
];

export const BHK_WEIGHTS: Weighted<number> = [
  [3, 309],
  [2, 206],
  [4, 182],
  [1, 78],
  [5, 45],
  [2.5, 13],
  [6, 10],
  [7, 9],
  [3.5, 8],
  [8, 5],
  [4.5, 3],
];

export const PARTY_TYPE_WEIGHTS: Weighted<PartyType> = [
  ['Broker', 428],
  ['Owner', 171],
  ['Developer', 45],
  ['Society', 25],
  ['Company', 16],
  ['Government', 13],
];

export const PARTICIPANT_ROLE_WEIGHTS: Weighted<ParticipantRole> = [
  ['Broker', 36],
  ['Auctioneer', 2],
  ['Consultant', 2],
  ['Architect', 2],
  ['Developer', 1],
];

export const SIGNAL_TYPE_WEIGHTS: Weighted<SignalType> = [
  ['Redevelopment Upcoming', 4],
  ['Government Tender', 1],
  ['Land Policy', 1],
];

export const POSSESSION_WEIGHTS: Weighted<PossessionStatus> = [
  ['Ready', 277],
  ['Under Construction', 46],
  ['Available From', 23],
  ['Under Redevelopment', 4],
];

export const FURNISHING_WEIGHTS: Weighted<Furnishing> = [
  ['Furnished', 214],
  ['Semi Furnished', 26],
  ['Unfurnished', 13],
  ['Bare Shell', 7],
];

export const LAND_UNIT_WEIGHTS: Weighted<LandAreaUnit> = [
  ['acre', 117],
  ['sqft', 40],
  ['sqm', 35],
  ['sqyd', 7],
  ['gunta', 7],
  ['bigha', 3],
];

/** Square feet per land unit. Bigha varies by state; 27,000 sq ft is used (README assumption). */
export const SQFT_PER_UNIT: { readonly [U in LandAreaUnit]: number } = {
  acre: 43560,
  sqft: 1,
  sqm: 10.7639,
  sqyd: 9,
  gunta: 1089,
  bigha: 27000,
};

export const TIMES_SEEN_WEIGHTS: Weighted<number> = [
  [1, 1865],
  [2, 199],
  [3, 56],
  [4, 22],
  [5, 8],
  [6, 2],
  [7, 1],
  [8, 2],
];

export const CONFIDENCE_WEIGHTS: Weighted<number> = [
  [0.8, 228],
  [0.85, 225],
  [0.72, 172],
  [0.75, 128],
  [0.6, 127],
  [0.78, 114],
  [0.9, 113],
  [0.5, 100],
  [0.7, 99],
  [0.55, 91],
  [0.82, 90],
  [0.68, 80],
  [0.65, 77],
  [0.87, 59],
];

/** Split ads: number of records per split ad (profile: 169 × "n of 2", 51 × "n of 3", rest larger). */
export const SPLIT_SIZE_WEIGHTS: Weighted<number> = [
  [2, 169],
  [3, 51],
  [4, 22],
  [5, 12],
  [6, 7],
  [8, 4],
  [10, 2],
];

/** Other review reasons the extractor writes (reason code `other`). */
export const OTHER_REVIEW_REASONS: readonly string[] = [
  'price unclear',
  'multiple properties in one ad',
  'location unclear',
  'low OCR confidence',
  'contact missing',
];
