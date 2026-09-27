// Synthetic, PII-free fixtures for domain tests: a small Mumbai hierarchy and offer/demand builders.
import { Hierarchy } from '../../src/domain/micromarket.js';
import type { MmSourceNode } from '../../src/domain/micromarket.js';
import type { ScoringContext } from '../../src/domain/scoring.js';
import type { DemandMx, OfferMx } from '../../src/domain/types.js';
import { DEFAULT_WEIGHTS } from '../../src/domain/weights.js';
import type { Weights } from '../../src/domain/weights.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';

const n = (
  id: string,
  level: MmSourceNode['level'],
  name: string,
  parentId: string | null,
  extra: Partial<MmSourceNode> = {},
): MmSourceNode => ({
  id,
  parentId,
  level,
  name,
  aliases: [],
  adjacentIds: [],
  inLaunchArea: true,
  ...extra,
});

/** Node ids are readable keys in tests (records uses UUIDs; the domain treats keys as opaque). */
export const MM = {
  westernSuburbs: 'z-ws',
  andheriEast: 'mm-andheri-east',
  andheriWest: 'mm-andheri-west',
  powai: 'mm-powai',
  bkc: 'mm-bkc',
  bhiwandi: 'mm-bhiwandi',
  chakala: 'loc-chakala',
  marol: 'loc-marol',
  midc: 'loc-midc',
  sakiNaka: 'loc-saki-naka',
  marolNaka: 'sub-marol-naka',
  lokhandwala: 'loc-lokhandwala',
  versova: 'loc-versova',
  hiranandani: 'loc-hiranandani',
  vadape: 'loc-vadape',
} as const;

export const SOURCE: MmSourceNode[] = [
  n(MM.westernSuburbs, 'zone', 'Western Suburbs', null),
  n(MM.andheriEast, 'micromarket', 'Andheri East', MM.westernSuburbs, {
    adjacentIds: [MM.powai, MM.andheriWest],
  }),
  n(MM.andheriWest, 'micromarket', 'Andheri West', MM.westernSuburbs, { adjacentIds: [MM.andheriEast] }),
  n(MM.powai, 'micromarket', 'Powai', MM.westernSuburbs, { adjacentIds: [MM.andheriEast] }),
  n(MM.bkc, 'micromarket', 'Bandra Kurla Complex', null, { aliases: ['BKC'] }),
  n(MM.bhiwandi, 'micromarket', 'Bhiwandi', null),
  n(MM.chakala, 'locality', 'Chakala', MM.andheriEast),
  n(MM.marol, 'locality', 'Marol', MM.andheriEast),
  n(MM.midc, 'locality', 'MIDC', MM.andheriEast, { aliases: ['MIDC Andheri'] }),
  n(MM.sakiNaka, 'locality', 'Saki Naka', MM.andheriEast),
  n(MM.marolNaka, 'sub_locality', 'Marol Naka', MM.marol),
  n(MM.lokhandwala, 'locality', 'Lokhandwala', MM.andheriWest),
  n(MM.versova, 'locality', 'Versova', MM.andheriWest),
  n(MM.hiranandani, 'locality', 'Hiranandani Gardens', MM.powai),
  n(MM.vadape, 'locality', 'Vadape', MM.bhiwandi),
];

export const hierarchy = Hierarchy.fromSource(SOURCE);

export const TODAY = '2026-10-01';

export function ctx(weights: Weights = DEFAULT_WEIGHTS, today = TODAY): ScoringContext {
  return { hierarchy, weights, today };
}

let seq = 0;
const nextId = (prefix: string) => {
  seq++;
  return `${prefix}${String(seq).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
};

export function offer(p: Partial<OfferMx> = {}): OfferMx {
  const base: OfferMx = {
    id: nextId('0ffe'),
    tenantId: TENANT,
    code: `INV-${String(seq).padStart(5, '0')}`,
    propertyId: nextId('9000'),
    projectId: null,
    buildingKey: null,
    dealType: 'Lease',
    market: null,
    segment: 'Commercial',
    propertyTypes: ['Office'],
    bhkMin: null,
    bhkMax: null,
    areaSqftMin: 6000,
    areaSqftMax: 6000,
    areaBasis: 'Builtup',
    landAreaSqft: null,
    salePriceInrMin: null,
    salePriceInrMax: null,
    rentMonthlyInrMin: 900_000,
    rentMonthlyInrMax: null,
    depositInr: null,
    currentRentInr: null,
    micromarket: 'Andheri East',
    locality: 'Marol',
    mmPath: [],
    outsideLaunchArea: false,
    tenancyStatus: null,
    saleMode: null,
    possessionStatus: 'Ready',
    possessionDateRaw: null,
    tenure: null,
    agreementForm: null,
    isJodi: null,
    parking: null,
    amenities: [],
    floorBand: null,
    totalFloors: null,
    priceSheetDate: null,
    lastSeenDate: null,
    furnishing: null,
    unitCount: null,
    recordStage: 'Verified',
    lifeStage: 'Fresh',
    commercialStatus: 'Available',
    voided: false,
    mergedInto: null,
    factsVersion: 1,
  };
  const o = { ...base, ...p };
  if (!p.mmPath) o.mmPath = hierarchy.offerPath(o.micromarket, o.locality);
  return o;
}

export function demand(p: Partial<DemandMx> = {}): DemandMx {
  const base: DemandMx = {
    id: nextId('dea0'),
    tenantId: TENANT,
    code: `DEM-${String(seq).padStart(6, '0')}`,
    dealTypes: ['Lease'],
    market: null,
    segment: 'Commercial',
    propertyTypes: ['Office'],
    bhkMin: null,
    bhkMax: null,
    areaSqftMin: 5000,
    areaSqftMax: 7000,
    areaBasis: 'Builtup',
    budgetInrMin: null,
    budgetInrMax: null,
    rentMonthlyInrMin: 800_000,
    rentMonthlyInrMax: 1_000_000,
    micromarkets: ['Andheri East'],
    localities: ['Marol'],
    mmExpanded: [],
    moveInFrom: null,
    moveInBy: null,
    statedTags: {},
    outsideLaunchArea: false,
    recordStage: 'Qualified',
    qualified: true,
    lifeStage: 'Fresh',
    commercialStatus: 'New',
    exitType: null,
    voided: false,
    mergedInto: null,
  };
  const d = { ...base, ...p };
  if (!p.mmExpanded) d.mmExpanded = hierarchy.demandExpanded(d.micromarkets, d.localities);
  return d;
}
