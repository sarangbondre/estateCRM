/**
 * Seeded, streaming generator of synthetic extractor rows (PRD Appendix C, 91 columns).
 *
 * - Deterministic: the same options give the same rows.
 * - Constant memory: rows are produced one at a time; only small ring buffers of earlier rows are
 *   kept (for repeats and duplicate record_ids).
 * - Every row that is not an injected error passes `@11e/vocabulary` validation; this is asserted
 *   while generating (a failing row is a generator bug and throws).
 */
import {
  displayLabels,
  routeFor,
  validateClassification,
  type AreaBasis,
  type DealType,
  type LandAreaUnit,
  type LandUse,
  type Market,
  type PartyType,
  type PropertyType,
  type RecordScope,
  type Segment,
  type Side,
} from '@11e/vocabulary';
import {
  BANKS,
  BUILDING_A,
  BUILDING_B,
  BUSINESS_DESCRIPTIONS,
  COMMERCIAL_B,
  COMMERCIAL_FEATURES,
  EQUIPMENT_DETAILS,
  EXTRACTOR_NOTES,
  LANDMARKS,
  MMR_LOCALITIES,
  NEWSPAPERS,
  NEWSPAPER_PAGES,
  OUTSIDE_MMR_LOCALITIES,
  PROJECT_B,
  RESIDENTIAL_FEATURES,
  WHATSAPP_GROUPS,
  companyName,
  developerName,
  type Locality,
} from './catalog.js';
import { blankRow, type ExtractorColumn, type ExtractorRow } from './columns.js';
import { anonymisedOtherContact, phoneInText, syntheticPerson, type SyntheticPerson } from './contacts.js';
import { injectError, type InjectedIssue } from './errors.js';
import { addDays, daysBetween, groupIndian, inrShort, roundArea, roundPrice, weekday } from './format.js';
import {
  resolveOptions,
  type InjectedErrorCode,
  type InjectedWarningCode,
  type SyntheticOptions,
} from './options.js';
import {
  BHK_WEIGHTS,
  BUSINESS_DEAL_TYPE_WEIGHTS,
  CAPITAL_DEAL_TYPE_WEIGHTS,
  CONFIDENCE_WEIGHTS,
  DEMAND_DEAL_TYPE_WEIGHTS,
  FURNISHING_WEIGHTS,
  LAND_UNIT_WEIGHTS,
  LAND_USE_WEIGHTS,
  OTHER_REVIEW_REASONS,
  PARTICIPANT_ROLE_WEIGHTS,
  PARTY_TYPE_WEIGHTS,
  POSSESSION_WEIGHTS,
  PROPERTY_DEAL_TYPE_WEIGHTS,
  PROPERTY_TYPE_WEIGHTS,
  RECORD_SCOPE_WEIGHTS,
  SEGMENT_WEIGHTS,
  SIGNAL_TYPE_WEIGHTS,
  SPLIT_SIZE_WEIGHTS,
  SQFT_PER_UNIT,
  TIMES_SEEN_WEIGHTS,
} from './profile.js';
import { Rng, feistel48, hex12, type Weighted } from './rng.js';

export type RowKind = 'ad' | 'split' | 'repeat';

export interface RowMeta {
  /** 1-based data row number across the whole dataset. */
  readonly rowNo: number;
  /** 0-based output file index (see `rowsPerFile`). */
  readonly fileIndex: number;
  readonly kind: RowKind;
  /** The injected strict-mode error, or null for a loadable row. */
  readonly error: InjectedIssue<InjectedErrorCode> | null;
  /** The injected warning (row still loads), or null. */
  readonly warning: InjectedIssue<InjectedWarningCode> | null;
  /** record_id of the ad this row re-posts (repeats only). */
  readonly repeatOf: string | null;
  /** True when the repeat carries `possible_repeat_of`. */
  readonly flaggedRepeat: boolean;
  /** Synthetic person index behind the contact columns, or null. */
  readonly personIndex: number | null;
  /** null when the row has no city. */
  readonly outsideMmr: boolean | null;
  /** Expected needs_review after strict intake (extractor flag or blank side, intake LLD §4.4). */
  readonly needsReview: boolean;
}

export interface SyntheticRecord {
  readonly row: ExtractorRow;
  readonly meta: RowMeta;
}

interface Classified {
  readonly scope: RecordScope;
  readonly side: Side | null;
  readonly sideNote: 'stated' | 'defaulted' | 'unclear';
  readonly dealTypes: readonly DealType[];
  readonly market: Market | null;
  readonly segment: Segment | null;
  readonly propertyTypes: readonly PropertyType[];
  readonly landUse: LandUse | null;
}

interface Source {
  readonly channel: 'Newspaper' | 'WhatsApp';
  readonly name: string;
  readonly edition: string | null;
  readonly supplement: string | null;
  readonly date: string;
  readonly page: number | null;
  readonly files: string;
  readonly language: string | null;
  readonly ocr: boolean;
}

interface Contact {
  readonly person: SyntheticPerson | null;
  readonly partyType: PartyType | null;
  readonly showName: boolean;
  readonly company: string | null;
  readonly showEmail: boolean;
  readonly whatsapp: boolean;
  readonly rera: string | null;
  readonly other: string | null;
  readonly phoneStyle: number;
}

interface Unit {
  locality: Locality | null;
  propertyType: PropertyType | null;
  detail: string;
  bhkMin: number | null;
  bhkMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  areaBasis: AreaBasis | null;
  landValue: number | null;
  landUnit: LandAreaUnit | null;
  landSqft: number | null;
  saleMin: number | null;
  saleMax: number | null;
  saleRate: number | null;
  saleRateUnit: 'sqft' | 'acre' | null;
  rentMin: number | null;
  rentMax: number | null;
  rentPsf: number | null;
  deposit: number | null;
  depositMonths: number | null;
  currentRent: number | null;
  yieldPct: number | null;
  building: string | null;
  projectName: string | null;
  features: string | null;
  priceText: string | null;
  areaText: string | null;
  text: string;
}

const RING_SIZE = 1024;

const RESIDENTIAL_MULTIPLIER: Partial<Record<PropertyType, number>> = {
  Apartment: 1,
  Penthouse: 1.3,
  Studio: 1.05,
  Villa: 0.9,
  Bungalow: 1.1,
  'Row House': 0.85,
  Farmhouse: 0.35,
  Building: 0.75,
  'Serviced Apartment': 1.1,
  Office: 1.15,
  Shop: 1.6,
  Showroom: 1.4,
  'Restaurant Space': 1.3,
  'Commercial Building': 0.9,
  Coworking: 1,
  Hotel: 0.8,
  Resort: 0.5,
  'Institutional Building': 0.7,
  'Commercial Space': 1,
  Gala: 0.45,
  Shed: 0.3,
  Warehouse: 0.25,
  Factory: 0.3,
  'Industrial Building': 0.35,
  'Cold Storage': 0.3,
  Plot: 0.35,
  'Land Parcel': 0.12,
  'Agricultural Land': 0.03,
};

const AREA_RANGE: Partial<Record<PropertyType, readonly [number, number]>> = {
  Penthouse: [3000, 8000],
  Villa: [2000, 6000],
  Bungalow: [2500, 8000],
  'Row House': [1200, 2500],
  Farmhouse: [2000, 6000],
  Building: [8000, 40000],
  Office: [400, 15000],
  Shop: [150, 1500],
  Showroom: [1000, 6000],
  'Restaurant Space': [800, 4000],
  'Commercial Building': [10000, 80000],
  Coworking: [3000, 20000],
  Hotel: [15000, 100000],
  Resort: [20000, 120000],
  'Institutional Building': [10000, 60000],
  'Commercial Space': [500, 20000],
  Gala: [300, 3000],
  Shed: [2000, 30000],
  Warehouse: [5000, 150000],
  Factory: [10000, 200000],
  'Industrial Building': [20000, 100000],
  'Cold Storage': [5000, 40000],
};

const BHK_AREA: readonly (readonly [number, number, number])[] = [
  [0.5, 250, 350],
  [1, 380, 550],
  [2, 600, 900],
  [2.5, 850, 1000],
  [3, 950, 1500],
  [3.5, 1300, 1700],
  [4, 1600, 2800],
  [4.5, 2200, 3000],
  [5, 2800, 4500],
  [8, 4000, 8000],
];

const BHK_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
  'Apartment',
  'Penthouse',
  'Studio',
  'Villa',
  'Bungalow',
  'Row House',
  'Serviced Apartment',
]);

function cumulativeLocalities(list: readonly Locality[]): Weighted<Locality> {
  return list.map((l) => [l, l.weight] as const);
}

const MMR_WEIGHTED = cumulativeLocalities(MMR_LOCALITIES);
const MMR_INDUSTRIAL = cumulativeLocalities(MMR_LOCALITIES.filter((l) => l.industrial === true));
const OUTSIDE_WEIGHTED = cumulativeLocalities(OUTSIDE_MMR_LOCALITIES);

function nonNull<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`generator bug: missing ${what}`);
  return value;
}

/** Cumulative weights for fast date picks over long ranges. */
class DateTable {
  private readonly dates: string[] = [];
  private readonly cumulative: number[] = [];
  private total = 0;

  constructor(from: string, to: string) {
    const days = daysBetween(from, to);
    for (let d = 0; d <= days; d += 1) {
      const date = addDays(from, d);
      const day = weekday(date);
      // Newspaper property pages concentrate on weekends (profile: top dates are Sat/Sun).
      this.total += day === 0 ? 5 : day === 6 ? 3 : 1;
      this.dates.push(date);
      this.cumulative.push(this.total);
    }
  }

  pick(rng: Rng): string {
    const r = rng.next() * this.total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cumulative[mid] as number) > r) hi = mid;
      else lo = mid + 1;
    }
    return this.dates[lo] as string;
  }
}

/** Synthetic crm_notes values (no personal data). */
const SYNTHETIC_CRM_NOTES: readonly string[] = [
  'Synthetic note: owner prefers calls after 6 pm',
  'Synthetic note: keys with the society office',
  'Synthetic note: revisit price next month',
  'Synthetic note: broker says flexible on deposit',
];

export class SyntheticGenerator {
  readonly options: SyntheticOptions;
  private readonly rng: Rng;
  private readonly errorRng: Rng;
  /** CR-012 columns (floor, crm_notes): a separate stream, so the other columns stay as they were per seed. */
  private readonly extraRng: Rng;
  private readonly idKey: number;
  private readonly dates: DateTable;
  private idCounter = 0;
  private rowNo = 0;
  private readonly pending: {
    row: ExtractorRow;
    meta: Omit<RowMeta, 'rowNo' | 'fileIndex' | 'error' | 'warning'>;
  }[] = [];
  /** Recent loadable, non-split rows (repeat sources; never reset). */
  private readonly repeatRing: { readonly row: ExtractorRow; readonly personIndex: number | null }[] = [];
  /** record_ids of loadable rows of the current file (duplicate-external-ref targets). */
  private readonly fileIds: string[] = [];
  /** Per new ad: probability it is split (so that splitRate of all rows are split children). */
  private readonly pSplit: number;
  /** Per draw: probability of a repeat (so that repeatRate of all rows are repeats). */
  private readonly pRepeat: number;

  constructor(input: Partial<SyntheticOptions> & { readonly rows: number }) {
    this.options = resolveOptions(input);
    this.rng = Rng.derive(this.options.seed, 'rows');
    this.errorRng = Rng.derive(this.options.seed, 'errors');
    this.extraRng = Rng.derive(this.options.seed, 'cr012');
    this.idKey = Rng.derive(this.options.seed, 'ids').nextUint32() & 0xffffff;
    this.dates = new DateTable(this.options.dateFrom, this.options.dateTo);
    // Rows per draw: a repeat is 1 row; a new ad is 1 row, or meanSplit rows when split.
    const { repeatRate: r, splitRate } = this.options;
    let weight = 0;
    let rows = 0;
    for (const [n, w] of SPLIT_SIZE_WEIGHTS) {
      weight += w;
      rows += n * w;
    }
    const meanSplit = rows / weight;
    const s = r >= 1 ? 0 : Math.min(0.9, splitRate / (1 - r));
    this.pSplit = s / (meanSplit * (1 - s) + s);
    const meanAd = 1 - this.pSplit + this.pSplit * meanSplit;
    this.pRepeat = r >= 1 ? 1 : (r * meanAd) / (1 - r + r * meanAd);
  }

  /** Yields `options.rows` records. */
  *records(): Generator<SyntheticRecord> {
    const { rows, rowsPerFile } = this.options;
    while (this.rowNo < rows) {
      const fileIndex = Math.floor(this.rowNo / rowsPerFile);
      const leftInFile = Math.min(rows, (fileIndex + 1) * rowsPerFile) - this.rowNo;
      if (this.rowNo % rowsPerFile === 0) this.fileIds.length = 0;
      if (this.pending.length === 0) this.fillPending(leftInFile);
      const next = nonNull(this.pending.shift(), 'pending row');
      this.rowNo += 1;
      yield this.finish(next.row, { ...next.meta, rowNo: this.rowNo, fileIndex });
    }
  }

  private finish(row: ExtractorRow, meta: Omit<RowMeta, 'error' | 'warning'>): SyntheticRecord {
    const { errorRate, invalidPhoneRate } = this.options;
    const r = this.errorRng.next();
    if (r < errorRate) {
      const error = injectError(row, this.errorRng, this.options.errorCodes, this.fileIds);
      return { row, meta: { ...meta, error, warning: null, needsReview: false } };
    }
    const id = row.record_id;
    if (typeof id === 'string') this.fileIds.push(id);
    if (this.fileIds.length > RING_SIZE) this.fileIds.shift();
    if (meta.kind !== 'split') {
      // A copy: the caller owns the yielded row, and a warning below must not leak into repeats.
      this.repeatRing.push({ row: { ...row }, personIndex: meta.personIndex });
      if (this.repeatRing.length > RING_SIZE) this.repeatRing.shift();
    }
    let warning: InjectedIssue<InjectedWarningCode> | null = null;
    if (r < errorRate + invalidPhoneRate) {
      row.phones = this.errorRng.pick(['12345', 'ph 0000', '+91 12']);
      warning = { code: 'invalid-phone', column: 'phones' };
    }
    return { row, meta: { ...meta, error: null, warning } };
  }

  private nextId(): string {
    const id = hex12(feistel48(this.idCounter, this.idKey));
    this.idCounter += 1;
    return id;
  }

  private fillPending(leftInFile: number): void {
    if (this.repeatRing.length > 0 && this.rng.chance(this.pRepeat)) {
      this.pending.push(this.repeat());
      return;
    }
    let size = 1;
    if (this.rng.chance(this.pSplit)) size = this.rng.weighted(SPLIT_SIZE_WEIGHTS);
    if (size > leftInFile) size = 1;
    for (const item of this.newAd(size)) this.pending.push(item);
  }

  // --- Repeats ----------------------------------------------------------------------------------

  private repeat(): { row: ExtractorRow; meta: Omit<RowMeta, 'rowNo' | 'fileIndex' | 'error' | 'warning'> } {
    const { row: base, personIndex } = this.rng.pick(this.repeatRing);
    const baseId = nonNull(base.record_id, 'repeat base id') as string;
    const row: ExtractorRow = { ...base };
    const flagged = this.rng.chance(this.options.flaggedRepeatShare);
    row.record_id = this.nextId();
    row.possible_repeat_of = flagged ? baseId : null;
    const baseDate = typeof base.last_seen_date === 'string' ? base.last_seen_date : this.options.dateFrom;
    const room = Math.max(0, daysBetween(baseDate, this.options.dateTo));
    const date = addDays(baseDate, Math.min(room, this.rng.int(1, 28)));
    row.source_date = date;
    row.first_seen_date = date;
    row.last_seen_date = date;
    row.times_seen = 1;
    if (row.source_channel === 'Newspaper') {
      const name = this.rng.weighted(NEWSPAPERS);
      const page = this.rng.weighted(NEWSPAPER_PAGES);
      row.source_name = name;
      row.source_page = page;
      row.source_files = sourceFile(name, 'Mumbai', date, page);
    }
    // Near repeat: small price change and slightly different wording (exact repeat otherwise).
    if (this.rng.chance(0.6)) {
      const factor = this.rng.pick([0.95, 0.97, 1.03, 1.05]);
      for (const column of [
        'sale_price_inr_min',
        'sale_price_inr_max',
        'rent_monthly_inr_min',
        'rent_monthly_inr_max',
      ] as const) {
        const value = row[column];
        if (typeof value === 'number') row[column] = roundPrice(value * factor);
      }
      if (typeof row.raw_text === 'string')
        row.raw_text = `${row.raw_text} ${this.rng.pick(['Revised price.', 'Urgent.', 'Genuine buyers only.', 'Call now.'])}`;
      if (row.sale_price_inr_min !== null || row.rent_monthly_inr_min !== null) {
        row.price_text = typeof row.price_text === 'string' ? `${row.price_text} (revised)` : null;
      }
    }
    return {
      row,
      meta: {
        kind: 'repeat',
        repeatOf: baseId,
        flaggedRepeat: flagged,
        personIndex,
        outsideMmr: outsideMmrOf(base),
        needsReview: expectedNeedsReview(row),
      },
    };
  }

  // --- New ads ----------------------------------------------------------------------------------

  private newAd(
    size: number,
  ): { row: ExtractorRow; meta: Omit<RowMeta, 'rowNo' | 'fileIndex' | 'error' | 'warning'> }[] {
    const rng = this.rng;
    const c = this.classify();
    const source = this.source();
    const contact = this.contact(c);
    const baseLocality = this.locality(c);
    const units: Unit[] = [];
    for (let k = 0; k < size; k += 1) {
      const locality = k > 0 && rng.chance(0.4) ? this.nearbyLocality(baseLocality) : baseLocality;
      units.push(this.unit(c, locality, size > 1, contact.partyType === 'Bank'));
    }
    const parentId = size > 1 ? this.nextId() : null;
    const timesSeen = rng.weighted(TIMES_SEEN_WEIGHTS);
    const lastSeen = addDays(
      source.date,
      Math.min(Math.max(0, daysBetween(source.date, this.options.dateTo)), (timesSeen - 1) * rng.int(3, 10)),
    );
    const reasons = this.reviewReasons(c, units);
    const text = this.adText(c, source, contact, units);
    const variants =
      source.channel === 'WhatsApp' && timesSeen > 1 ? `${text}\n---\n${text.replace(/\. /g, ', ')}` : null;
    const deadline =
      c.scope === 'Property' && contact.partyType === 'Bank' && rng.chance(0.65)
        ? addDays(source.date, rng.int(12, 45))
        : null;
    const tags = this.dealTags(c, units[0] ?? null);
    const notes =
      size > 1 ? 'multiple units in one ad; split' : rng.chance(0.42) ? rng.pick(EXTRACTOR_NOTES) : null;
    const confidence = rng.chance(0.94) ? rng.weighted(CONFIDENCE_WEIGHTS) : null;

    return units.map((u, k) => {
      const row = blankRow();
      row.lead_status = 'New';
      row.record_id = this.nextId();
      row.parent_record_id = parentId;
      row.split_index = size > 1 ? `${k + 1} of ${size}` : null;
      this.writeClassification(row, c, u);
      this.writeContact(row, contact);
      this.writeTags(row, tags, deadline);
      this.writeNonProperty(row, c, u);
      this.writeUnit(row, u, rng);
      this.writePrivate(row, u);
      this.writeSource(row, source, timesSeen, lastSeen);
      row.needs_review = reasons.length > 0;
      row.review_reason = reasons.length > 0 ? reasons.join('; ') : null;
      row.raw_text = text;
      row.text_variants = variants;
      row.extraction_confidence = confidence;
      row.extractor_notes = notes;
      this.assertValid(row);
      return {
        row,
        meta: {
          kind: size > 1 ? ('split' as const) : ('ad' as const),
          repeatOf: null,
          flaggedRepeat: false,
          personIndex: contact.person?.index ?? null,
          outsideMmr: outsideMmrOf(row),
          needsReview: expectedNeedsReview(row),
        },
      };
    });
  }

  private assertValid(row: ExtractorRow): void {
    const result = validateClassification({
      recordScope: row.record_scope as string | null,
      dealType: row.deal_type as string | null,
      market: row.market as string | null,
      segment: row.segment as string | null,
      propertyType: row.property_type as string | null,
      landUse: row.land_use as string | null,
      side: row.side as string | null,
    });
    if (!result.ok) {
      throw new Error(`generator bug: invalid classification ${JSON.stringify(result.issues)}`);
    }
  }

  // --- Classification ---------------------------------------------------------------------------

  private classify(): Classified {
    const rng = this.rng;
    const scope = rng.weighted(RECORD_SCOPE_WEIGHTS);
    if (scope === 'Market Participant' || scope === 'Market Signal') {
      return {
        scope,
        side: 'None',
        sideNote: 'stated',
        dealTypes: [],
        market: null,
        segment: null,
        propertyTypes: [],
        landUse: null,
      };
    }
    if (scope !== 'Property') {
      const dealTypes =
        scope === 'Business'
          ? rng.weighted(BUSINESS_DEAL_TYPE_WEIGHTS)
          : scope === 'Capital'
            ? rng.weighted(CAPITAL_DEAL_TYPE_WEIGHTS)
            : rng.weighted<readonly DealType[]>([
                [['Sale'], 9],
                [['Lease'], 3],
              ]);
      const demand = scope === 'Capital' ? rng.chance(0.6) : rng.chance(0.15);
      return {
        scope,
        side: demand ? 'Demand' : 'Supply',
        sideNote: 'stated',
        dealTypes,
        market: null,
        segment: null,
        propertyTypes: [],
        landUse: null,
      };
    }
    return this.classifyProperty();
  }

  private classifyProperty(): Classified {
    const rng = this.rng;
    const s = rng.next();
    // Property sides (profile): Supply ≈ 96.7%, Demand ≈ 2.1%, blank ≈ 1.2%; ~28% of Supply is "defaulted".
    const side: Side | null = s < 0.012 ? null : s < 0.033 ? 'Demand' : 'Supply';
    const sideNote =
      side === null ? 'unclear' : side === 'Supply' && rng.chance(0.28) ? 'defaulted' : 'stated';
    const dealTypes =
      (side === 'Demand'
        ? rng.weighted(DEMAND_DEAL_TYPE_WEIGHTS)
        : rng.weighted(PROPERTY_DEAL_TYPE_WEIGHTS)) ?? [];
    let segment = rng.weighted(SEGMENT_WEIGHTS);
    if (dealTypes.includes('JV') && segment !== null) segment = rng.chance(0.5) ? 'Land' : 'Residential';
    if (dealTypes.includes('Pagdi')) segment = rng.chance(0.7) ? 'Residential' : 'Commercial';
    let propertyTypes: PropertyType[] = [];
    if (segment !== null && !rng.chance(0.012)) {
      const first =
        dealTypes.includes('JV') && segment === 'Residential'
          ? 'Building'
          : rng.weighted(PROPERTY_TYPE_WEIGHTS[segment]);
      propertyTypes = [first];
      if (rng.chance(0.02)) {
        const second = rng.weighted(PROPERTY_TYPE_WEIGHTS[segment]);
        if (second !== first) propertyTypes.push(second);
      }
    }
    let market: Market | null = null;
    if (dealTypes.includes('Sale')) {
      const newBuild = segment === 'Residential' || segment === 'Commercial';
      market =
        side === 'Demand'
          ? rng.weighted<Market | null>([
              [null, 40],
              ['Any', 35],
              ['Secondary', 20],
              ['Primary', 5],
            ])
          : rng.weighted<Market | null>([
              [null, 58],
              ['Secondary', 35],
              ['Primary', newBuild ? 7 : 0],
            ]);
    }
    let landUse: LandUse | null = null;
    if (segment === 'Land' && rng.chance(0.45)) {
      landUse = propertyTypes[0] === 'Agricultural Land' ? 'Agricultural' : rng.weighted(LAND_USE_WEIGHTS);
    } else if (segment === 'Industrial' && rng.chance(0.1)) {
      landUse = 'Industrial';
    }
    return { scope: 'Property', side, sideNote, dealTypes, market, segment, propertyTypes, landUse };
  }

  private writeClassification(row: ExtractorRow, c: Classified, u: Unit): void {
    row.record_scope = c.scope;
    row.deal_type = c.dealTypes.length > 0 ? c.dealTypes.join('|') : null;
    row.market = c.market;
    row.segment = c.segment;
    const types = u.propertyType !== null ? [u.propertyType, ...c.propertyTypes.slice(1)] : c.propertyTypes;
    row.property_type = types.length > 0 ? types.join('|') : null;
    row.property_detail = u.detail;
    row.land_use = c.landUse;
    row.side = c.side;
    row.side_evidence = this.rng.chance(0.97) ? sideEvidence(c, this.rng) : null;
    row.route_to = routeFor(c.scope, c.side);
  }

  private reviewReasons(c: Classified, units: readonly Unit[]): string[] {
    const reasons: string[] = [];
    if (c.sideNote === 'defaulted') reasons.push('side defaulted to Supply');
    if (c.sideNote === 'unclear') reasons.push('side unclear');
    if (c.scope === 'Property' && c.dealTypes.length === 0) reasons.push('deal type not stated');
    if (c.scope === 'Property' && c.segment !== null && units.some((u) => u.propertyType === null)) {
      reasons.push('property type not stated');
    }
    if (this.rng.chance(0.07)) reasons.push(this.rng.pick(OTHER_REVIEW_REASONS));
    return reasons;
  }

  // --- Deal tags --------------------------------------------------------------------------------

  private dealTags(c: Classified, u: Unit | null): Partial<Record<ExtractorColumn, string | boolean | null>> {
    const rng = this.rng;
    const tags: Partial<Record<ExtractorColumn, string | boolean | null>> = {};
    if (c.scope !== 'Property') return tags;
    const sale = c.dealTypes.includes('Sale');
    const lease = c.dealTypes.includes('Lease');
    const residential = c.segment === 'Residential';
    if (sale && c.side === 'Supply' && c.segment === 'Commercial' && rng.chance(0.12)) {
      tags.tenancy_status = rng.chance(0.8) ? 'Tenanted' : 'Vacant';
    }
    if (c.segment === 'Industrial' && rng.chance(0.25))
      tags.tenure = rng.chance(0.67) ? 'Leasehold' : 'Freehold';
    if (lease && residential && rng.chance(0.12)) tags.agreement_form = 'Leave and License';
    if (residential && u?.propertyType === 'Apartment' && rng.chance(0.03)) tags.is_jodi = rng.chance(0.95);
    let possession: string | null = null;
    if (c.market === 'Primary') possession = rng.chance(0.6) ? 'Under Construction' : null;
    else if (c.dealTypes.includes('JV') && rng.chance(0.1)) possession = 'Under Redevelopment';
    else if (rng.chance(0.15))
      possession = rng.weighted(POSSESSION_WEIGHTS.filter(([v]) => v !== 'Under Construction'));
    tags.possession_status = possession;
    if (possession === 'Under Construction' && rng.chance(0.3)) {
      tags.possession_date = rng.pick(['2027', '2027-12', '2028-06', '2027-03']);
    } else if (possession === 'Available From' && rng.chance(0.5)) {
      tags.possession_date = rng.pick(['2026-10', '2026-11-01', '2026-12', '2027-01-15']);
    }
    const furnishable = residential || c.segment === 'Commercial';
    if (lease && furnishable && rng.chance(0.5)) tags.furnishing = rng.weighted(FURNISHING_WEIGHTS);
    else if (sale && residential && rng.chance(0.05)) tags.furnishing = rng.weighted(FURNISHING_WEIGHTS);
    return tags;
  }

  private writeTags(
    row: ExtractorRow,
    tags: Partial<Record<ExtractorColumn, string | boolean | null>>,
    deadline: string | null,
  ): void {
    for (const [column, value] of Object.entries(tags) as [ExtractorColumn, string | boolean | null][]) {
      row[column] = value;
    }
    // Auction notices come from lenders (profile: sale_mode is only ever Auction).
    if (row.party_type === 'Bank') row.sale_mode = 'Auction';
    row.deadline_date = deadline;
  }

  // --- Non-property -----------------------------------------------------------------------------

  private writeNonProperty(row: ExtractorRow, c: Classified, u: Unit): void {
    const rng = this.rng;
    if (c.scope === 'Business') {
      const sector = u.detail.split(':')[0] ?? 'Other';
      row.sector = sector;
      row.property_detail = u.detail.split(':')[1]?.trim() ?? u.detail;
      row.business_description = row.property_detail;
      if (rng.chance(0.5)) row.includes_property = rng.chance(0.84) ? 'Yes' : 'No';
    } else if (c.scope === 'Market Participant') {
      row.participant_role = rng.weighted(PARTICIPANT_ROLE_WEIGHTS);
    } else if (c.scope === 'Market Signal') {
      row.signal_type = rng.weighted(SIGNAL_TYPE_WEIGHTS);
    }
  }

  // --- Location ---------------------------------------------------------------------------------

  private locality(c: Classified): Locality {
    const rng = this.rng;
    if (rng.chance(this.options.outsideMmrRate)) return rng.weighted(OUTSIDE_WEIGHTED);
    if (c.segment === 'Industrial' && rng.chance(0.6)) return rng.weighted(MMR_INDUSTRIAL);
    return rng.weighted(MMR_WEIGHTED);
  }

  private nearbyLocality(base: Locality): Locality {
    const list = (base.mmr ? MMR_LOCALITIES : OUTSIDE_MMR_LOCALITIES).filter((l) => l.city === base.city);
    return list.length > 0 ? this.rng.pick(list) : base;
  }

  // --- Units (area, price, configuration) --------------------------------------------------------

  private unit(c: Classified, locality: Locality, split: boolean, auction: boolean): Unit {
    const rng = this.rng;
    const u: Unit = {
      locality,
      propertyType: c.propertyTypes[0] ?? null,
      detail: '',
      bhkMin: null,
      bhkMax: null,
      areaMin: null,
      areaMax: null,
      areaBasis: null,
      landValue: null,
      landUnit: null,
      landSqft: null,
      saleMin: null,
      saleMax: null,
      saleRate: null,
      saleRateUnit: null,
      rentMin: null,
      rentMax: null,
      rentPsf: null,
      deposit: null,
      depositMonths: null,
      currentRent: null,
      yieldPct: null,
      building: null,
      projectName: null,
      features: null,
      priceText: null,
      areaText: null,
      text: '',
    };
    if (c.scope !== 'Property') {
      u.detail = nonPropertyDetail(c, rng);
      u.text = u.detail;
      return u;
    }
    const type = u.propertyType;
    const demand = c.side === 'Demand';
    const rate =
      rng.float(locality.rate[0], locality.rate[1]) *
      (type === null ? 1 : (RESIDENTIAL_MULTIPLIER[type] ?? 1));
    const perSqft = c.market === 'Primary' ? rate * 1.1 : rate;

    // Configuration
    if (type !== null && BHK_TYPES.has(type) && rng.chance(0.88)) {
      const bhk =
        type === 'Studio' ? 0.5 : type === 'Penthouse' ? rng.pick([4, 5, 6]) : rng.weighted(BHK_WEIGHTS);
      u.bhkMin = bhk;
      u.bhkMax = (demand || c.market === 'Primary') && bhk < 5 && rng.chance(0.5) ? bhk + 1 : bhk;
    }

    // Area
    let area: number | null = null;
    if (c.segment === 'Land' || (type === 'Farmhouse' && rng.chance(0.5))) {
      if (rng.chance(0.85)) this.landArea(u, type);
    } else if (type !== null && rng.chance(split ? 0.8 : 0.58)) {
      area = this.area(type, u.bhkMin);
      u.areaMin = area;
      u.areaMax =
        demand || (c.market === 'Primary' && rng.chance(0.4)) ? roundArea(area * rng.float(1.15, 1.6)) : area;
      if (rng.chance(0.38))
        u.areaBasis = rng.weighted<AreaBasis>([
          ['Carpet', 389],
          ['Builtup', 24],
          ['Saleable', 1],
        ]);
      u.areaText =
        u.areaMin === u.areaMax
          ? `${groupIndian(u.areaMin)} sq ft${u.areaBasis === null ? '' : ` ${u.areaBasis.toLowerCase()}`}`
          : `${groupIndian(u.areaMin)}-${groupIndian(u.areaMax)} sq ft${u.areaBasis === null ? '' : ` ${u.areaBasis.toLowerCase()}`}`;
    }
    const valueArea = area ?? u.landSqft ?? (type === null ? 1000 : this.area(type, u.bhkMin));
    const value = valueArea * perSqft;
    this.price(u, c, value, perSqft, split, auction);

    // Building, project, features
    const commercial = c.segment === 'Commercial' || c.segment === 'Industrial';
    if (c.segment !== 'Land' && rng.chance(0.3)) {
      u.building = `${rng.pick(BUILDING_A)} ${commercial ? rng.pick(COMMERCIAL_B) : rng.pick(BUILDING_B)}`;
    }
    if (c.market === 'Primary') u.projectName = `${rng.pick(BUILDING_A)} ${rng.pick(PROJECT_B)}`;
    else if (u.building !== null && rng.chance(0.5)) u.projectName = u.building;
    if (rng.chance(0.96)) {
      u.features = rng
        .sample(commercial ? COMMERCIAL_FEATURES : RESIDENTIAL_FEATURES, rng.int(1, 4))
        .join(', ');
    }
    const typeText = type ?? 'Property';
    const bhkText =
      u.bhkMin === null ? '' : u.bhkMin === 0.5 ? '1 RK ' : `${formatBhk(u.bhkMin, u.bhkMax)} BHK `;
    u.detail = rng.chance(0.25)
      ? typeText
      : `${bhkText}${typeText}${u.building === null ? '' : ` in ${u.building}`}`;
    const parts = [
      `${bhkText}${typeText}`,
      u.building,
      u.areaText ?? (u.landValue === null ? null : `${u.landValue} ${u.landUnit ?? ''}`.trim()),
      locality.name,
      u.priceText,
    ];
    u.text = parts.filter((p): p is string => p !== null && p !== '').join(', ');
    return u;
  }

  private area(type: PropertyType, bhk: number | null): number {
    const rng = this.rng;
    if (bhk !== null && (type === 'Apartment' || type === 'Studio' || type === 'Serviced Apartment')) {
      const band = BHK_AREA.find(([b]) => bhk <= b) ?? BHK_AREA[BHK_AREA.length - 1];
      const [, lo, hi] = nonNull(band, 'bhk band');
      return roundArea(rng.float(lo, hi));
    }
    const [lo, hi] = AREA_RANGE[type] ?? [500, 1500];
    // Log-uniform: many small units, few very large ones.
    return roundArea(Math.exp(rng.float(Math.log(lo), Math.log(hi))));
  }

  private landArea(u: Unit, type: PropertyType | null): void {
    const rng = this.rng;
    const unit: LandAreaUnit =
      type === 'Plot' && rng.chance(0.6)
        ? rng.pick(['sqft', 'sqm', 'sqyd'] as const)
        : rng.weighted(LAND_UNIT_WEIGHTS);
    const ranges: Record<LandAreaUnit, readonly [number, number]> = {
      acre: [0.5, 50],
      sqft: [2000, 60000],
      sqm: [400, 20000],
      sqyd: [200, 5000],
      gunta: [5, 40],
      bigha: [1, 20],
    };
    const [lo, hi] = ranges[unit];
    let value = Math.exp(rng.float(Math.log(lo), Math.log(hi)));
    value =
      unit === 'acre'
        ? Math.round(value * 2) / 2
        : unit === 'gunta' || unit === 'bigha'
          ? Math.round(value)
          : roundArea(value);
    u.landValue = value;
    u.landUnit = unit;
    u.landSqft = Math.round(value * SQFT_PER_UNIT[unit]);
    u.areaText = `${groupIndian(value)} ${unit}`;
  }

  private price(
    u: Unit,
    c: Classified,
    value: number,
    perSqft: number,
    split: boolean,
    auction: boolean,
  ): void {
    const rng = this.rng;
    const sale = c.dealTypes.includes('Sale');
    const lease = c.dealTypes.includes('Lease');
    const pagdi = c.dealTypes.includes('Pagdi');
    const demand = c.side === 'Demand';
    const bump = split ? 0.15 : 0;
    if (sale || pagdi) {
      // Auction notices almost always state a reserve price.
      const pSale = auction ? 0.95 : demand ? 0.3 : c.market === 'Primary' ? 0.6 : 0.27;
      if (rng.chance(pSale + bump)) {
        const amount = roundPrice(pagdi && !sale ? value * 0.6 : value);
        if (demand) {
          u.saleMax = roundPrice(amount * rng.float(1, 1.2));
          u.saleMin = rng.chance(0.5) ? roundPrice(u.saleMax * 0.8) : null;
          u.priceText =
            u.saleMin === null
              ? `budget up to Rs ${inrShort(u.saleMax)}`
              : `budget Rs ${inrShort(u.saleMin)}-${inrShort(u.saleMax)}`;
        } else if (c.market === 'Primary' && rng.chance(0.3)) {
          u.saleMin = amount;
          u.priceText = `Rs ${inrShort(amount)} onwards`;
        } else if (
          c.market === 'Primary' &&
          u.areaMax !== null &&
          u.areaMin !== null &&
          u.areaMax > u.areaMin
        ) {
          u.saleMin = amount;
          u.saleMax = roundPrice((amount * u.areaMax) / u.areaMin);
          u.priceText = `Rs ${inrShort(u.saleMin)}-${inrShort(u.saleMax)}`;
        } else {
          u.saleMin = amount;
          u.saleMax = amount;
          u.priceText = `Rs ${inrShort(amount)}`;
        }
        if (c.segment === 'Land' && rng.chance(0.2)) {
          u.saleRateUnit = u.landUnit === 'acre' ? 'acre' : 'sqft';
          u.saleRate = roundPrice(u.saleRateUnit === 'acre' ? perSqft * 43560 : perSqft);
          u.priceText = `${u.priceText} (Rs ${inrShort(u.saleRate)} per ${u.saleRateUnit})`;
        } else if (c.segment === 'Commercial' && rng.chance(0.03)) {
          u.saleRateUnit = 'sqft';
          u.saleRate = Math.round(perSqft / 500) * 500;
        }
      }
    }
    if (lease || pagdi) {
      const yieldMonthly = c.segment === 'Residential' ? 0.0025 : 0.0055;
      if (pagdi) {
        u.rentMin = roundPrice(rng.int(2, 10) * 1000);
        u.rentMax = u.rentMin;
      } else if (rng.chance(0.14 + bump)) {
        const rent = roundPrice(value * yieldMonthly);
        u.rentMin = demand && rng.chance(0.5) ? roundPrice(rent * 0.8) : rent;
        u.rentMax = rent;
        const rentText = `rent Rs ${inrShort(rent)}/month`;
        u.priceText = u.priceText === null ? rentText : `${u.priceText}; ${rentText}`;
        if (rng.chance(0.15)) {
          u.depositMonths = c.segment === 'Residential' ? rng.pick([3, 6]) : 6;
          u.deposit = rent * u.depositMonths;
        }
        if (c.segment === 'Commercial' && u.areaMin !== null && rng.chance(0.05)) {
          u.rentPsf = Math.round((rent / u.areaMin) * 10) / 10;
        }
      }
    }
    if (sale && c.segment === 'Commercial' && !demand && u.saleMin !== null && rng.chance(0.08)) {
      u.currentRent = roundPrice(u.saleMin * rng.float(0.004, 0.006));
      if (rng.chance(0.3)) u.yieldPct = Math.round(((u.currentRent * 12) / u.saleMin) * 1000) / 10;
    }
    if (u.priceText !== null && rng.chance(0.1)) u.priceText = `${u.priceText} negotiable`;
  }

  /** CR-012: building_name when the ad names one, sometimes a floor; a few rows carry synthetic crm_notes. */
  private writePrivate(row: ExtractorRow, u: Unit): void {
    const x = this.extraRng;
    row.building_name = u.building;
    if (u.building !== null && x.chance(0.4)) {
      row.floor = x.chance(0.1) ? 'G' : x.chance(0.2) ? `${x.int(1, 20)} of 20` : String(x.int(1, 30));
    }
    if (x.chance(0.03)) row.crm_notes = x.pick(SYNTHETIC_CRM_NOTES);
  }

  private writeUnit(row: ExtractorRow, u: Unit, rng: Rng): void {
    const loc = u.locality;
    row.bhk_min = u.bhkMin;
    row.bhk_max = u.bhkMax;
    row.features = u.features;
    row.area_sqft_min = u.areaMin;
    row.area_sqft_max = u.areaMax;
    row.area_basis = u.areaBasis;
    row.land_area_value = u.landValue;
    row.land_area_unit = u.landUnit;
    row.land_area_sqft = u.landSqft;
    row.area_text = u.areaText;
    row.price_text = u.priceText;
    row.sale_price_inr_min = u.saleMin;
    row.sale_price_inr_max = u.saleMax;
    row.sale_rate_inr = u.saleRate;
    row.sale_rate_unit = u.saleRateUnit;
    row.price_negotiable = u.priceText?.endsWith('negotiable') === true ? true : null;
    row.rent_monthly_inr_min = u.rentMin;
    row.rent_monthly_inr_max = u.rentMax;
    row.rent_rate_psf = u.rentPsf;
    row.deposit_inr = u.deposit;
    row.deposit_months = u.depositMonths;
    row.current_rent_inr = u.currentRent;
    row.yield_pct = u.yieldPct;
    row.project_name = u.projectName;
    if (loc !== null) {
      const stateShown = rng.chance(0.9);
      row.state = stateShown ? loc.state : null;
      row.city = stateShown && rng.chance(0.945) ? loc.city : null;
      row.locality = rng.chance(0.79) ? loc.name : null;
      const landmark = rng.chance(0.26) ? rng.pick(LANDMARKS) : null;
      row.landmark = landmark;
      row.location_text = rng.chance(0.99)
        ? [loc.name, landmark, loc.city === 'Mumbai' ? null : loc.city].filter((p) => p !== null).join(', ')
        : null;
    }
  }

  // --- Contact ----------------------------------------------------------------------------------

  private contact(c: Classified): Contact {
    const rng = this.rng;
    const anonymised = this.options.anonymised;
    let partyType: PartyType | null = null;
    if (c.scope === 'Property' && c.side === 'Supply' && c.dealTypes.includes('Sale') && rng.chance(0.075)) {
      partyType = 'Bank';
    } else if (c.market === 'Primary' && rng.chance(0.6)) partyType = 'Developer';
    else if (c.dealTypes.includes('JV') && rng.chance(0.4)) partyType = 'Society';
    else if (c.scope === 'Market Participant') partyType = rng.chance(0.8) ? 'Broker' : null;
    else if (c.scope === 'Market Signal') partyType = rng.chance(0.4) ? 'Government' : 'Society';
    else if (rng.chance(0.29)) partyType = rng.weighted(PARTY_TYPE_WEIGHTS);

    const people = this.options.people;
    let person: SyntheticPerson | null = null;
    if (rng.chance(0.93)) {
      // Brokers are few and post often (skewed over the first 30% of the pool); others uniform.
      const brokerPool = Math.max(1, Math.floor(people * 0.3));
      const index =
        partyType === 'Broker' || (partyType === null && rng.chance(0.4))
          ? Math.floor(brokerPool * rng.next() ** 2)
          : brokerPool + Math.floor((people - brokerPool) * rng.next());
      person = syntheticPerson(Math.min(people - 1, index), anonymised);
    }
    let company: string | null = null;
    if (partyType === 'Bank') company = rng.pick(BANKS);
    else if (partyType === 'Developer') company = developerName(rng.int(0, 999));
    else if (partyType === 'Society') company = `${rng.pick(BUILDING_A)} CHS`;
    else if (partyType === 'Company') company = companyName(rng.int(0, 999));
    else if (partyType !== 'Government' && person !== null && person.company !== null && rng.chance(0.55)) {
      company = person.company;
    }
    const reraEligible =
      partyType === 'Broker' || partyType === 'Developer' || c.scope === 'Market Participant';
    const rera =
      reraEligible && rng.chance(0.1)
        ? `${partyType === 'Developer' ? 'P' : 'A'}999${String(rng.int(0, 99_999_999)).padStart(8, '0')}`
        : null;
    let other: string | null = null;
    if (rng.chance(0.05)) {
      other = anonymised
        ? anonymisedOtherContact(person?.index ?? rng.int(0, 999_999))
        : `www.${(company ?? 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.com`;
    }
    return {
      person,
      partyType,
      showName: person !== null && rng.chance(0.28),
      company,
      showEmail: person !== null && rng.chance(0.1),
      whatsapp: person !== null && rng.chance(0.02),
      rera,
      other,
      phoneStyle: rng.int(0, 3),
    };
  }

  private writeContact(row: ExtractorRow, k: Contact): void {
    const p = k.person;
    row.party_type = k.partyType;
    row.company_name = k.company;
    row.contact_name = p !== null && k.showName ? p.name : null;
    row.phones = p !== null ? p.phones.join('|') : null;
    row.whatsapp_phone = p !== null && k.whatsapp ? (p.phones[0] ?? null) : null;
    row.emails = p !== null && k.showEmail ? p.email : null;
    row.rera_number = k.rera;
    row.other_contact = k.other;
    if (row.party_type === 'Developer' && row.company_name !== null) row.developer_name = row.company_name;
  }

  // --- Source -----------------------------------------------------------------------------------

  private source(): Source {
    const rng = this.rng;
    const date = this.dates.pick(rng);
    if (rng.chance(this.options.whatsappRate)) {
      const group = rng.pick(WHATSAPP_GROUPS);
      return {
        channel: 'WhatsApp',
        name: group,
        edition: null,
        supplement: null,
        date,
        page: null,
        files: `chat-export_${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${date}.txt`,
        language: 'English',
        ocr: false,
      };
    }
    const name = rng.weighted(NEWSPAPERS);
    const edition = rng.weighted<string>([
      ['Mumbai', 2145],
      ['Pune', 7],
      ['Ahmedabad', 2],
    ]);
    const page = rng.weighted(NEWSPAPER_PAGES);
    return {
      channel: 'Newspaper',
      name,
      edition,
      supplement: name === 'Times of India' && rng.chance(0.004) ? 'Bombay Times' : null,
      date,
      page,
      files: sourceFile(name, edition, date, page),
      language: name === 'Gujarat Samachar' ? 'Gujarati' : rng.chance(0.876) ? 'English' : null,
      ocr: rng.chance(0.87),
    };
  }

  private writeSource(row: ExtractorRow, s: Source, timesSeen: number, lastSeen: string): void {
    row.source_channel = s.channel;
    row.source_name = s.name;
    row.source_edition = s.edition;
    row.source_supplement = s.supplement;
    row.source_date = s.date;
    row.source_page = s.page;
    row.source_files = s.files;
    row.first_seen_date = s.date;
    row.last_seen_date = lastSeen;
    row.times_seen = timesSeen;
    row.source_language = s.language;
    row.ocr_used = s.ocr;
    if (s.channel === 'WhatsApp' && row.phones !== null) {
      row.sender_name = row.contact_name ?? (typeof row.company_name === 'string' ? row.company_name : null);
      row.sender_phone = (row.phones as string).split('|')[0] ?? null;
    }
  }

  // --- Ad text ----------------------------------------------------------------------------------

  private adText(c: Classified, s: Source, k: Contact, units: readonly Unit[]): string {
    const rng = this.rng;
    const parts: string[] = [];
    const first = units[0];
    if (c.scope === 'Property') {
      if (k.partyType === 'Bank') {
        parts.push(`E-AUCTION SALE NOTICE. ${k.company ?? 'The secured creditor'} invites bids.`);
      } else if (c.sideNote === 'stated') {
        const labels = displayLabels({
          recordScope: c.scope,
          side: c.side,
          dealTypes: c.dealTypes,
          market: c.market,
          segment: c.segment,
        }).map((l) => l.text);
        const heading = labels.length > 0 ? labels.join(' / ') : c.side === 'Demand' ? 'Wanted' : 'Available';
        parts.push(`${heading.toUpperCase()}:`);
      }
      if (units.length === 1 && first !== undefined) parts.push(`${first.text}.`);
      else units.forEach((u, i) => parts.push(`${i + 1}) ${u.text}.`));
      if (first?.features !== null && first?.features !== undefined)
        parts.push(`${capitalise(first.features)}.`);
      if (k.partyType === 'Bank') parts.push('Reserve price as stated; EMD applicable.');
    } else {
      parts.push(nonPropertyText(c, first, k, rng));
    }
    const contactBits: string[] = [];
    if (k.company !== null) contactBits.push(k.company);
    if (k.person !== null) {
      if (k.showName) contactBits.push(k.person.name);
      contactBits.push(...k.person.phones.map((p, i) => phoneInText(p, k.phoneStyle + i)));
      if (k.showEmail) contactBits.push(k.person.email);
    }
    if (k.rera !== null) contactBits.push(`RERA ${k.rera}`);
    if (k.other !== null) contactBits.push(k.other);
    if (contactBits.length > 0) parts.push(`Contact: ${contactBits.join(', ')}`);
    if (s.channel === 'Newspaper' && rng.chance(0.05)) parts.push('Brokers excuse.');
    return parts.join(' ');
  }
}

// --- Helpers ----------------------------------------------------------------------------------------

function sourceFile(name: string, edition: string, date: string, page: number): string {
  const code = name
    .split(/[\s-]+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  return `${code}_${edition}_${date}_p${String(page).padStart(2, '0')}.jpg`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${(text[0] as string).toUpperCase()}${text.slice(1)}`;
}

function formatBhk(min: number, max: number | null): string {
  return max === null || max === min ? String(min) : `${min}-${max}`;
}

function sideEvidence(c: Classified, rng: Rng): string {
  if (c.sideNote === 'defaulted') return 'no side wording; defaulted to Supply';
  if (c.sideNote === 'unclear') return 'ad wording ambiguous';
  if (c.scope === 'Market Participant') return 'services advertised';
  if (c.scope === 'Market Signal') return 'public notice';
  if (c.side === 'Demand') return rng.pick(['Wanted', 'Required', 'Looking for', 'Client requires']);
  if (c.dealTypes.includes('Lease')) return rng.pick(['Available on rent', 'On lease', 'For rent']);
  return rng.pick(['For Sale', 'Available', 'Sale', 'Offered']);
}

function nonPropertyDetail(c: Classified, rng: Rng): string {
  switch (c.scope) {
    case 'Business': {
      const [sector, text] = rng.weighted(BUSINESS_DESCRIPTIONS);
      return `${sector}: ${text}`;
    }
    case 'Capital':
      return rng.pick([
        'Funding for residential redevelopment project',
        'Loan against commercial property',
        'Equity partner for project',
        'Stressed asset portfolio',
      ]);
    case 'Equipment':
      return rng.pick(EQUIPMENT_DETAILS);
    case 'Market Participant':
      return rng.pick([
        'Property consultant',
        'Real estate broker',
        'Auction services',
        'Architect and planner',
      ]);
    case 'Market Signal':
      return rng.pick([
        'Society redevelopment notice',
        'Tender for plot allotment',
        'Draft land policy notice',
      ]);
    default:
      return 'Property';
  }
}

function nonPropertyText(c: Classified, u: Unit | undefined, k: Contact, rng: Rng): string {
  const detail = u?.detail.split(':').pop()?.trim() ?? '';
  const where = u?.locality?.name ?? 'Mumbai';
  const deal = c.dealTypes.join(' / ').toLowerCase();
  switch (c.scope) {
    case 'Business':
      return `${c.side === 'Demand' ? 'WANTED' : 'AVAILABLE'}: ${detail} in ${where} for ${deal}.`;
    case 'Capital':
      return `${c.side === 'Demand' ? 'FUNDS REQUIRED' : 'FUNDS AVAILABLE'}: ${detail}, ${where}. Rs ${inrShort(rng.int(5, 200) * 1e6)}.`;
    case 'Equipment':
      return `${detail} for ${deal}, good working condition, ${where}.`;
    case 'Market Participant':
      return `${k.company ?? 'Established firm'}: ${detail.toLowerCase()} for residential and commercial deals in ${where}.`;
    case 'Market Signal':
      return `PUBLIC NOTICE: ${detail} at ${where}. Offers invited.`;
    default:
      return detail;
  }
}

function outsideMmrOf(row: ExtractorRow): boolean | null {
  const city = row.city;
  if (typeof city !== 'string') return null;
  return !MMR_LOCALITIES.some((l) => l.city === city);
}

const NO_SIDE_SCOPES: readonly string[] = ['Market Participant', 'Market Signal'];

/** needs_review after strict intake: extractor flag, or blank side outside MP/MS (intake LLD §4.4). */
export function expectedNeedsReview(row: ExtractorRow): boolean {
  if (row.needs_review === true) return true;
  return row.side === null && !NO_SIDE_SCOPES.includes(String(row.record_scope));
}

/** Convenience: generates all records into memory (tests and small datasets only). */
export function generate(input: Partial<SyntheticOptions> & { readonly rows: number }): SyntheticRecord[] {
  return [...new SyntheticGenerator(input).records()];
}
