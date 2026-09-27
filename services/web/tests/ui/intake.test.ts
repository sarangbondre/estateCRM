// Intake cards logic (C-04 upload, C-05 review): mapping targets vs contract, request builders, step derivation,
// progress maths, review grouping and labels.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAPPING_TARGETS,
  buildBulk,
  buildCreateUpload,
  buildMappingBody,
  buildMerge,
  buildResolve,
  canCancel,
  canReview,
  chunkPercent,
  classificationFrom,
  contentTypeFor,
  dealTypeOptions,
  draftForReason,
  draftFrom,
  draftMissing,
  etaText,
  fieldsFor,
  fileProblem,
  gapText,
  initialColumnMap,
  isTerminal,
  mappingProblems,
  pollUpload,
  reasonLabel,
  rejectionReasons,
  reportTiles,
  reviewGroups,
  scorePct,
  sourcePriceText,
  stagePercents,
  stepFor,
} from '@/ui/cards/intake/logic';
import type { Classification, ReviewItem } from '@/ui/cards/intake/logic';

const contract = JSON.parse(
  readFileSync(new URL('../../../../contracts/generated/openapi/intake.json', import.meta.url), 'utf8'),
) as {
  components: { schemas: Record<string, { properties: Record<string, { additionalProperties?: { enum?: unknown[] }; enum?: unknown[] }> }> };
};

describe('mapping targets', () => {
  it('equal the putUploadMapping columnMap enum (without null)', () => {
    const e = contract.components.schemas['Mapping']!.properties['columnMap']!.additionalProperties!.enum!;
    expect([...MAPPING_TARGETS]).toEqual(e.filter((v) => v !== null));
  });

  it('prefill from template, then suggestion, dropping unknown and repeated targets', () => {
    const map = initialColumnMap(
      ['Ad text', 'Locality', 'Type', 'Phone', 'Other'],
      { 'Ad text': 'raw_text', Locality: 'locality', Type: 'raw_text', Phone: 'phones', Other: 'Unknown' },
      { Type: 'property_type' },
    );
    expect(map).toEqual({ 'Ad text': 'raw_text', Locality: 'locality', Type: 'property_type', Phone: 'phones', Other: null });
    expect(initialColumnMap(['A', 'B'], { A: 'city', B: 'city' })).toEqual({ A: 'city', B: null });
    expect(initialColumnMap(undefined, null)).toEqual({});
  });

  it('checks required targets and duplicates', () => {
    expect(mappingProblems({ a: 'raw_text', b: 'record_scope' }, null)).toEqual([]);
    expect(mappingProblems({ a: 'raw_text' }, 'Property')).toEqual([]);
    const p = mappingProblems({ a: 'city', b: 'city' }, null);
    expect(p).toHaveLength(3);
    expect(p[0]).toMatch(/City/);
  });

  it('builds the mapping body (constant scope only when record_scope is not mapped)', () => {
    expect(
      buildMappingBody({
        columnMap: { a: 'raw_text', b: null },
        sheetName: 'Sheet1',
        constantRecordScope: 'Property',
        templateId: null,
        saveAsTemplate: '  TOI v2 ',
      }),
    ).toEqual({
      columnMap: { a: 'raw_text', b: null },
      sheetName: 'Sheet1',
      constants: { recordScope: 'Property' },
      saveAsTemplate: { name: 'TOI v2' },
    });
    expect(buildMappingBody({ columnMap: { a: 'record_scope' }, constantRecordScope: 'Business' })).toEqual({
      columnMap: { a: 'record_scope' },
    });
  });
});

describe('attach', () => {
  it('derives the contract content type from the extension', () => {
    expect(contentTypeFor('leads.CSV')).toBe('text/csv');
    expect(contentTypeFor('a.xls')).toBe('application/vnd.ms-excel');
    expect(contentTypeFor('a.b.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(contentTypeFor('notes.pdf')).toBeNull();
  });

  it('rejects wrong type, empty and > 50 MB files', () => {
    expect(fileProblem({ name: 'a.pdf', size: 10 })).toMatch(/Excel/);
    expect(fileProblem({ name: 'a.csv', size: 0 })).toMatch(/empty/);
    expect(fileProblem({ name: 'a.csv', size: 52_428_801 })).toMatch(/50 MB/);
    expect(fileProblem({ name: 'a.csv', size: 52_428_800 })).toBeNull();
  });

  it('builds createUpload without empty optional fields', () => {
    expect(
      buildCreateUpload({ name: 'x.csv', size: 12 }, { sourceType: 'Digi', sourceDetail: '  ', anonymise: true, templateId: null }),
    ).toEqual({
      fileName: 'x.csv',
      contentType: 'text/csv',
      sizeBytes: 12,
      sourceType: 'Digi',
      anonymise: true,
      importCrmNotes: false,
    });
    expect(
      buildCreateUpload({ name: 'x.xlsx', size: 5 }, { sourceType: 'Channel', sourceDetail: 'TOI', anonymise: false, templateId: 't1' }),
    ).toMatchObject({ sourceDetail: 'TOI', templateId: 't1', anonymise: false });
  });
});

describe('steps', () => {
  it('maps every upload status to a step', () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'attach'],
      ['awaiting_file', 'awaiting_file'],
      ['inspecting', 'inspecting'],
      ['awaiting_mapping', 'mapping'],
      ['ready', 'ready'],
      ['awaiting_duplicate_confirmation', 'duplicate'],
      ['queued', 'progress'],
      ['processing', 'progress'],
      ['completed', 'report'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['something-new', 'inspecting'],
    ];
    for (const [s, step] of cases) expect(stepFor(s)).toBe(step);
  });

  it('knows terminal, pollable and cancellable statuses', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('processing')).toBe(false);
    expect(pollUpload('inspecting')).toBe(true);
    expect(pollUpload('processing')).toBe(false);
    expect(canCancel('queued')).toBe(true);
    expect(canCancel('cancelled')).toBe(false);
  });
});

describe('progress', () => {
  it('computes chunk percent safely', () => {
    expect(chunkPercent(3, 12)).toBe(25);
    expect(chunkPercent(5, 0)).toBe(0);
    expect(chunkPercent(20, 10)).toBe(100);
    expect(chunkPercent(null, null)).toBe(0);
  });

  it('fills earlier stages, the current one by chunks, later ones empty', () => {
    expect(stagePercents({ status: 'processing', stage: 'classifying', chunksDone: 1, chunkCount: 4 })).toEqual([100, 100, 25, 0]);
    expect(stagePercents({ status: 'processing', stage: null, chunksDone: 1, chunkCount: 2 })).toEqual([50, 0, 0, 0]);
    expect(stagePercents({ status: 'queued', stage: null, chunksDone: 0, chunkCount: null })).toEqual([0, 0, 0, 0]);
    expect(stagePercents({ status: 'completed', stage: 'emitting', chunksDone: 4, chunkCount: 4 })).toEqual([100, 100, 100, 100]);
  });

  it('formats the ETA', () => {
    expect(etaText(null)).toBe('');
    expect(etaText(30)).toBe('less than a minute left');
    expect(etaText(180)).toBe('about 3 min left');
    expect(etaText(3900)).toBe('about 1 h 5 min left');
  });
});

describe('report', () => {
  it('shows the five tiles and optional ones when present', () => {
    expect(reportTiles({ read: 10, accepted: 7, rejected: 1, needsReview: 2, unchanged: 0 }).map((t) => t[0])).toEqual([
      'Rows read',
      'Accepted',
      'Rejected',
      'Needs review',
      'Unchanged',
    ]);
    expect(reportTiles({ read: 1, accepted: 1, rejected: 0, needsReview: 0, unchanged: 0, unclassified: 3 })).toContainEqual([
      'Unclassified',
      3,
    ]);
    expect(reportTiles(undefined).every(([, n]) => n === 0)).toBe(true);
  });

  it('counts rejection reasons by code, errors only', () => {
    expect(
      rejectionReasons([
        { code: 'invalid-date', severity: 'error' },
        { code: 'value-not-in-list', severity: 'error' },
        { code: 'value-not-in-list', severity: 'error' },
        { code: 'invalid-phone', severity: 'warning' },
      ]),
    ).toEqual([
      { code: 'value-not-in-list', label: 'Value not in the controlled list', count: 2 },
      { code: 'invalid-date', label: 'Invalid date', count: 1 },
    ]);
  });
});

describe('review queue', () => {
  const me = { role: 'Demand agent' as const, isDataOperator: false, permissions: [] as string[] };

  it('is for Admin, Manager, Data operator and flagged agents', () => {
    expect(canReview(me)).toBe(false);
    expect(canReview({ ...me, isDataOperator: true })).toBe(true);
    expect(canReview({ ...me, permissions: ['review.work'] })).toBe(true);
    expect(canReview({ ...me, role: 'Manager' })).toBe(true);
    expect(canReview({ ...me, role: 'Data operator' })).toBe(true);
  });

  it('groups by reason in priority order, folds unknown codes into other, then record-side groups', () => {
    const groups = reviewGroups(
      [
        { reasonCode: 'side_defaulted', open: 41, oldestAt: '2026-09-02T00:00:00Z' },
        { reasonCode: 'side_unclear', open: 214 },
        { reasonCode: 'mystery', open: 2, oldestAt: '2026-09-01T00:00:00Z' },
        { reasonCode: 'other', open: 3, oldestAt: '2026-09-05T00:00:00Z' },
        { reasonCode: 'low_confidence', open: 0 },
      ],
      { merges: { open: 2, more: false }, priceGaps: { open: 50, more: true } },
    );
    expect(groups.map((g) => [g.key, g.open])).toEqual([
      ['side_unclear', 214],
      ['side_defaulted', 41],
      ['other', 5],
      ['uncertain_merge', 2],
      ['price_gap', 50],
    ]);
    expect(groups.find((g) => g.key === 'other')?.oldestAt).toBe('2026-09-01T00:00:00Z');
    expect(groups.at(-1)?.more).toBe(true);
    expect(reviewGroups(undefined, { merges: { open: 0, more: false } })).toEqual([]);
  });

  it('labels reasons and offers the right fix fields', () => {
    expect(reasonLabel('side_unclear')).toBe('Side unclear');
    expect(reasonLabel('uncertain_merge')).toBe('Uncertain merge');
    expect(reasonLabel('brand_new_code')).toBe('brand new code');
    expect(fieldsFor('side_defaulted')).toEqual(['side']);
    expect(fieldsFor('deal_type_missing')).toEqual(['dealType', 'market']);
    expect(fieldsFor('property_type_missing')).toEqual(['segment', 'propertyType']);
    expect(fieldsFor('other')).toContain('recordScope');
  });

  const current: Classification = {
    recordScope: 'Property',
    side: 'Supply',
    dealTypes: ['Rent'],
    market: null,
    segment: 'Commercial',
    propertyTypes: ['Office'],
  };

  it('builds resolve bodies: set merges the draft over current values; market only with Sale', () => {
    expect(buildResolve('set', { current, draft: { side: 'Demand' } })).toEqual({
      action: 'set',
      classification: { ...current, side: 'Demand' },
    });
    expect(buildResolve('set', { current, draft: { dealType: 'Sale', market: 'Resale' } }).classification).toMatchObject({
      dealTypes: ['Sale'],
      market: 'Resale',
    });
    expect(classificationFrom(current, { dealType: 'Rent', market: 'Resale' }).market).toBeNull();
    expect(buildResolve('skip', { current, draft: { side: 'Demand' }, note: ' later ' })).toEqual({ action: 'skip', note: 'later' });
    expect(buildResolve('confirm')).toEqual({ action: 'confirm' });
  });

  it('limits the draft to the reason fields and reports what is missing', () => {
    const item = { current: { ...current, side: null }, suggested: { side: 'Demand' as const } } as Pick<
      ReviewItem,
      'current' | 'suggested'
    >;
    const d = draftFrom(item);
    expect(d.side).toBe('Demand');
    expect(d.propertyType).toBe('Office');
    expect(draftForReason('side_unclear', d)).toEqual({ side: 'Demand' });
    expect(draftMissing('side_unclear', { side: null })).toEqual(['side']);
    expect(draftMissing('deal_type_missing', { dealType: 'Rent' })).toEqual([]);
  });

  it('builds bulk bodies (unique ids, at most 100)', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    const b = buildBulk([...ids, 'id-1'], 'confirm');
    expect(b.ids).toHaveLength(100);
    expect(b).not.toHaveProperty('classification');
    expect(() => buildBulk([], 'confirm')).toThrow();
    expect(buildBulk(['a'], 'set', current)).toEqual({ ids: ['a'], action: 'set', classification: current });
  });

  it('builds a merge keeping the existing record, only when the incoming one exists', () => {
    expect(buildMerge({ id: 'c', aggregateType: 'demand', leftId: 'L', rightId: 'R' })).toEqual({
      aggregateType: 'demand',
      survivorId: 'L',
      mergedIds: ['R'],
      candidateId: 'c',
    });
    expect(buildMerge({ id: 'c', aggregateType: 'offer', leftId: 'L', rightId: null })).toBeNull();
  });

  it('formats scores, gaps and second-source prices', () => {
    expect(scorePct(0.873)).toBe('87%');
    expect(scorePct(undefined)).toBe('—');
    expect(gapText(7.54)).toBe('+7.5%');
    expect(gapText(-3)).toBe('−3%');
    expect(sourcePriceText({ salePriceInrMin: 800000, salePriceInrMax: 850000 })).toBe('₹8 L – ₹8.5 L');
    expect(sourcePriceText({ rentMonthlyInrMin: 45000, rentMonthlyInrMax: null })).toBe('₹45,000 /month');
    expect(sourcePriceText({})).toBe('—');
  });

  it('narrows deal types by record scope', () => {
    const vocab = {
      fields: { deal_type: { values: ['Sale', 'Rent', 'Lease', 'Funding'] } },
      recordScopes: [{ value: 'Capital', allowedDealTypes: ['Funding'] }],
    };
    expect(dealTypeOptions(vocab, 'Capital')).toEqual(['Funding']);
    expect(dealTypeOptions(vocab, 'Property')).toEqual(['Sale', 'Rent', 'Lease', 'Funding']);
    expect(dealTypeOptions(undefined, null)).toEqual([]);
  });
});
