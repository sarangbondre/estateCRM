/**
 * The "expected" manifest: counts that tests and load tests assert against (what intake should
 * read, reject, load and send to review). Built incrementally in constant memory.
 */
import { VOCABULARY_VERSION } from '@11e/vocabulary';
import { EXTRACTOR_COLUMNS, LEGACY_OMITTED_COLUMNS, type ExtractorColumn } from './columns.js';
import type { SyntheticRecord } from './generator.js';
import {
  INJECTED_ERROR_CODES,
  INJECTED_WARNING_CODES,
  type InjectedErrorCode,
  type InjectedWarningCode,
  type SyntheticOptions,
} from './options.js';

export const BLANK = '(blank)';

export interface ManifestFile {
  readonly index: number;
  readonly path: string | null;
  readonly rows: number;
  readonly firstRowNo: number;
  readonly lastRowNo: number;
}

export interface ClassificationCounts {
  readonly recordScope: Record<string, number>;
  readonly side: Record<string, number>;
  readonly dealType: Record<string, number>;
  readonly market: Record<string, number>;
  readonly segment: Record<string, number>;
  readonly propertyType: Record<string, number>;
  readonly routeTo: Record<string, number>;
}

export interface SyntheticManifest {
  readonly generator: string;
  readonly vocabularyVersion: string;
  readonly options: SyntheticOptions;
  /** Header written to the files, in order. */
  readonly columns: readonly ExtractorColumn[];
  /** Intake mode the header selects (intake LLD §4.2). */
  readonly mode: 'strict' | 'mapping';
  readonly files: readonly ManifestFile[];
  readonly totals: {
    readonly rows: number;
    /** Rows intake loads (not rejected); includes warning rows. */
    readonly loaded: number;
    /** Rows with an injected error (rejected in strict mode). */
    readonly rejected: number;
    /** Loaded rows that intake sends to review (extractor flag or blank side). */
    readonly needsReview: number;
    readonly warnings: number;
    readonly splitChildren: number;
    readonly splitParents: number;
    readonly repeats: number;
    readonly flaggedRepeats: number;
    readonly unflaggedRepeats: number;
    /** Loaded rows with a city, and those outside the MMR. */
    readonly withCity: number;
    readonly outsideMmr: number;
    readonly whatsapp: number;
    readonly timesSeenOverOne: number;
    /** Distinct synthetic people referenced by loaded rows. */
    readonly distinctPeople: number;
  };
  readonly errors: Record<InjectedErrorCode, number>;
  readonly warnings: Record<InjectedWarningCode, number>;
  /** Counts over loaded rows; blank values are counted under "(blank)". Pipe lists as written. */
  readonly classification: ClassificationCounts;
}

function bump(counts: Record<string, number>, value: unknown): void {
  const key = value === null || value === undefined || value === '' ? BLANK : String(value);
  counts[key] = (counts[key] ?? 0) + 1;
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export class ManifestBuilder {
  private rows = 0;
  private loaded = 0;
  private rejected = 0;
  private needsReview = 0;
  private warningRows = 0;
  private splitChildren = 0;
  private readonly splitParents = new Set<string>();
  private splitParentCount = 0;
  private repeats = 0;
  private flaggedRepeats = 0;
  private withCity = 0;
  private outsideMmr = 0;
  private whatsapp = 0;
  private timesSeenOverOne = 0;
  private readonly peopleSeen: Uint8Array;
  private distinctPeople = 0;
  private readonly errors = zeroes(INJECTED_ERROR_CODES);
  private readonly warnings = zeroes(INJECTED_WARNING_CODES);
  private readonly classification: ClassificationCounts = {
    recordScope: {},
    side: {},
    dealType: {},
    market: {},
    segment: {},
    propertyType: {},
    routeTo: {},
  };

  constructor(private readonly options: SyntheticOptions) {
    this.peopleSeen = new Uint8Array(options.people);
  }

  add({ row, meta }: SyntheticRecord): void {
    this.rows += 1;
    if (meta.kind === 'repeat') {
      this.repeats += 1;
      if (meta.flaggedRepeat) this.flaggedRepeats += 1;
    }
    if (meta.kind === 'split') {
      this.splitChildren += 1;
      const parent = row.parent_record_id;
      // Split children of one ad are consecutive, so only the current parent needs remembering.
      if (typeof parent === 'string' && !this.splitParents.has(parent)) {
        this.splitParents.clear();
        this.splitParents.add(parent);
        this.splitParentCount += 1;
      }
    }
    if (meta.error !== null) {
      this.rejected += 1;
      this.errors[meta.error.code] += 1;
      return;
    }
    this.loaded += 1;
    if (meta.warning !== null) {
      this.warningRows += 1;
      this.warnings[meta.warning.code] += 1;
    }
    if (meta.needsReview) this.needsReview += 1;
    if (meta.outsideMmr !== null) {
      this.withCity += 1;
      if (meta.outsideMmr) this.outsideMmr += 1;
    }
    if (row.source_channel === 'WhatsApp') this.whatsapp += 1;
    if (typeof row.times_seen === 'number' && row.times_seen > 1) this.timesSeenOverOne += 1;
    if (meta.personIndex !== null && this.peopleSeen[meta.personIndex] === 0) {
      this.peopleSeen[meta.personIndex] = 1;
      this.distinctPeople += 1;
    }
    const c = this.classification;
    bump(c.recordScope, row.record_scope);
    bump(c.side, row.side);
    bump(c.dealType, row.deal_type);
    bump(c.market, row.market);
    bump(c.segment, row.segment);
    bump(c.propertyType, row.property_type);
    bump(c.routeTo, row.route_to);
  }

  build(files: readonly ManifestFile[]): SyntheticManifest {
    const omitted = new Set<string>(this.options.omitColumns);
    const columns = EXTRACTOR_COLUMNS.filter((c) => !omitted.has(c));
    return {
      generator: '@11e/testing synthetic extractor generator v1',
      vocabularyVersion: VOCABULARY_VERSION,
      options: this.options,
      columns,
      // the 89-column files of older extractor versions (without building_name and floor) are strict too (CR-012)
      mode: [...omitted].every((c) => LEGACY_OMITTED_COLUMNS.includes(c as ExtractorColumn)) ? 'strict' : 'mapping',
      files,
      totals: {
        rows: this.rows,
        loaded: this.loaded,
        rejected: this.rejected,
        needsReview: this.needsReview,
        warnings: this.warningRows,
        splitChildren: this.splitChildren,
        splitParents: this.splitParentCount,
        repeats: this.repeats,
        flaggedRepeats: this.flaggedRepeats,
        unflaggedRepeats: this.repeats - this.flaggedRepeats,
        withCity: this.withCity,
        outsideMmr: this.outsideMmr,
        whatsapp: this.whatsapp,
        timesSeenOverOne: this.timesSeenOverOne,
        distinctPeople: this.distinctPeople,
      },
      errors: { ...this.errors },
      warnings: { ...this.warnings },
      classification: this.classification,
    };
  }
}
