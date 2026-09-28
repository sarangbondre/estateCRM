// Pure logic for the intake cards (C-04 upload, C-05 review; PRD §5.4, US-01, US-02, US-07a AC5, BRD §4.7): mapping
// targets, request builders, step derivation from upload status, progress maths, review-reason grouping and labels.
// No React, no I/O: unit-tested in tests/ui/intake.test.ts.
import type { components as Intake, operations as IntakeOps } from '@11e/contracts/intake';
import type { components as Records, operations as RecordsOps } from '@11e/contracts/records';
import type { Body } from '../../lib/contract';
import type { Me } from '../../shell/types';
import { inr } from '../../lib/format';

export type Upload = Intake['schemas']['Upload'];
export type UploadStatus = Upload['status'];
export type Progress = Intake['schemas']['Progress'];
export type UploadCounts = Intake['schemas']['UploadCounts'];
export type Classification = Intake['schemas']['Classification'];
export type ReviewItem = Intake['schemas']['ReviewItem'];
export type ReviewReason = ReviewItem['reasonCode'];
export type RowError = Intake['schemas']['RowError'];
export type MergeCandidate = Records['schemas']['MergeCandidate'];
export type SecondSource = Records['schemas']['SecondSource'];

export type UploadCreateBody = Body<IntakeOps['createUpload']>;
export type MappingBody = Body<IntakeOps['putUploadMapping']>;
export type ResolveBody = Body<IntakeOps['resolveReviewItem']>;
export type BulkResolveBody = Body<IntakeOps['bulkResolveReviewItems']>;
export type MergeBody = Body<RecordsOps['mergeRecords']>;

// ---------------------------------------------------------------------------------------------------------------
// Attach

export const SOURCE_TYPES = ['Channel', 'Digi', 'Direct'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const UPLOAD_ACCEPT = '.xlsx,.xls,.csv';
/** PRD A-19: ≤ 50 MB (UploadCreate.sizeBytes maximum). */
export const MAX_UPLOAD_BYTES = 52_428_800;

const CONTENT_TYPES = {
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
export type UploadContentType = UploadCreateBody['contentType'];

/** The contract content type for a file name (browsers report CSV inconsistently, so the extension decides). */
export function contentTypeFor(fileName: string): UploadContentType | null {
  const ext = /\.([a-z]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext && ext in CONTENT_TYPES ? CONTENT_TYPES[ext as keyof typeof CONTENT_TYPES] : null;
}

/** A reason the file cannot be uploaded, or null when it is fine. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!contentTypeFor(file.name)) return 'Choose an Excel (.xlsx, .xls) or CSV file.';
  if (file.name.length > 255) return 'The file name is too long (255 characters at most).';
  if (file.size < 1) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 50 MB. Split it and upload the parts.';
  return null;
}

export interface AttachForm {
  sourceType: SourceType;
  sourceDetail: string;
  anonymise: boolean;
  templateId: string | null;
  /** One-time initial import: carry crm_notes as a note (CR-006 Z-8). Default false. */
  importCrmNotes?: boolean;
}

export function buildCreateUpload(file: { name: string; size: number }, form: AttachForm): UploadCreateBody {
  const contentType = contentTypeFor(file.name);
  if (!contentType) throw new Error('unsupported file type');
  const detail = form.sourceDetail.trim().slice(0, 200);
  return {
    fileName: file.name,
    contentType,
    sizeBytes: file.size,
    sourceType: form.sourceType,
    anonymise: form.anonymise,
    importCrmNotes: form.importCrmNotes ?? false,
    ...(detail ? { sourceDetail: detail } : {}),
    ...(form.templateId ? { templateId: form.templateId } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

export type Step =
  | 'attach'
  | 'awaiting_file'
  | 'inspecting'
  | 'mapping'
  | 'ready'
  | 'duplicate'
  | 'progress'
  | 'report'
  | 'failed'
  | 'cancelled';

/** Which part of C-04 to show for an upload status (no upload yet → attach). Unknown statuses fall back to inspecting. */
export function stepFor(status: string | null | undefined): Step {
  switch (status) {
    case undefined:
    case null:
      return 'attach';
    case 'awaiting_file':
      return 'awaiting_file';
    case 'inspecting':
      return 'inspecting';
    case 'awaiting_mapping':
      return 'mapping';
    case 'ready':
      return 'ready';
    case 'awaiting_duplicate_confirmation':
      return 'duplicate';
    case 'queued':
    case 'processing':
      return 'progress';
    case 'completed':
      return 'report';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'inspecting';
  }
}

export const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (status: string | null | undefined): boolean => !!status && TERMINAL_STATUSES.includes(status);

/** Statuses where the upload itself should be re-read every 2 s (inspection runs in the background). */
export const pollUpload = (status: string | null | undefined): boolean => status === 'inspecting';

/** Cancel is possible until the upload finishes. */
export const canCancel = (status: string | null | undefined): boolean => !!status && !isTerminal(status);

// ---------------------------------------------------------------------------------------------------------------
// Mapping (mapping mode, D-15)

/** Target fields a column can map to: the enum of putUploadMapping `columnMap` values (Appendix C), without null. */
export const MAPPING_TARGETS = [
  'route_to', 'needs_review', 'review_reason', 'record_id', 'parent_record_id', 'split_index', 'record_scope', 'deal_type',
  'market', 'segment', 'property_type', 'property_detail', 'land_use', 'side', 'side_evidence', 'sale_mode', 'deadline_date',
  'tenancy_status', 'tenure', 'agreement_form', 'is_jodi', 'possession_status', 'possession_date', 'furnishing', 'sector',
  'includes_property', 'business_description', 'participant_role', 'signal_type', 'project_name', 'developer_name', 'bhk_min',
  'bhk_max', 'features', 'locality', 'city', 'state', 'landmark', 'location_text', 'area_sqft_min', 'area_sqft_max',
  'area_basis', 'land_area_value', 'land_area_unit', 'land_area_sqft', 'area_text', 'price_text', 'sale_price_inr_min',
  'sale_price_inr_max', 'sale_rate_inr', 'sale_rate_unit', 'price_negotiable', 'rent_monthly_inr_min', 'rent_monthly_inr_max',
  'rent_rate_psf', 'deposit_inr', 'deposit_months', 'current_rent_inr', 'yield_pct', 'contact_name', 'company_name',
  'party_type', 'phones', 'whatsapp_phone', 'emails', 'rera_number', 'other_contact', 'source_channel', 'source_name',
  'source_edition', 'source_supplement', 'source_date', 'source_page', 'source_files', 'first_seen_date', 'last_seen_date',
  'times_seen', 'possible_repeat_of', 'raw_text', 'source_language', 'ocr_used', 'extraction_confidence', 'extractor_notes',
  'sender_name', 'sender_phone', 'text_variants', 'external_id', 'campaign_ref', 'form_ref', 'listing_ref', 'project_ref',
  'enquiry_message', 'enquiry_received_at', 'photo_urls', 'free_text',
] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];
const TARGET_SET: ReadonlySet<string> = new Set(MAPPING_TARGETS);
export const isMappingTarget = (v: unknown): v is MappingTarget => typeof v === 'string' && TARGET_SET.has(v);

/** "sale_price_inr_min" → "Sale price inr min" (display only; the stored value stays snake_case). */
export const targetLabel = (t: string): string => {
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export type ColumnMap = Record<string, MappingTarget | null>;

/**
 * The starting column map: a chosen template wins, then the service's suggestion, else "ignore". Values outside the
 * target list are dropped (never sent back), and a target already taken by an earlier column is not reused.
 */
export function initialColumnMap(
  header: readonly string[] | null | undefined,
  suggested: Record<string, string | null> | null | undefined,
  template?: Record<string, string | null> | null,
): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<string>();
  for (const h of header ?? []) {
    const pick = [template?.[h], suggested?.[h]].find((v) => isMappingTarget(v) && !used.has(v));
    const target = isMappingTarget(pick) ? pick : null;
    if (target) used.add(target);
    map[h] = target;
  }
  return map;
}

/** Targets that need a column or a constant (putUploadMapping description). */
export const CONTENT_TARGETS: readonly MappingTarget[] = ['raw_text', 'property_type', 'deal_type'];

export const RECORD_SCOPES = ['Property', 'Business', 'Capital', 'Equipment', 'Market Participant', 'Market Signal'] as const;

/** Client-side check before PUT /mapping; the service re-validates. Returns human messages (empty = ok). */
export function mappingProblems(map: ColumnMap, constantRecordScope: string | null): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const t of Object.values(map)) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([t]) => t);
  if (dupes.length) problems.push(`Each field can be used once: ${dupes.map(targetLabel).join(', ')}.`);
  if (!counts.has('record_scope') && !constantRecordScope) {
    problems.push('Map a column to Record scope, or choose one record scope for the whole file.');
  }
  if (!CONTENT_TARGETS.some((t) => counts.has(t))) {
    problems.push('Map at least one of Raw text, Property type or Deal type.');
  }
  return problems;
}

export function buildMappingBody(input: {
  columnMap: ColumnMap;
  sheetName?: string | null;
  constantRecordScope?: string | null;
  templateId?: string | null;
  saveAsTemplate?: string | null;
}): MappingBody {
  const name = input.saveAsTemplate?.trim().slice(0, 100);
  const scope = input.columnMap && Object.values(input.columnMap).includes('record_scope') ? null : input.constantRecordScope;
  return {
    columnMap: { ...input.columnMap },
    ...(input.sheetName ? { sheetName: input.sheetName } : {}),
    ...(scope ? { constants: { recordScope: scope } } : {}),
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(name ? { saveAsTemplate: { name } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Progress

/** Processing stages in order (Upload.stage); labels follow the prototype. */
export const STAGES = [
  { key: 'parsing', label: 'Parsing' },
  { key: 'normalising', label: 'Normalising' },
  { key: 'classifying', label: 'Classifying' },
  { key: 'emitting', label: 'Saving records' },
] as const;

const clampPct = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/** Overall percent from chunks (0 when the chunk count is not known yet). */
export function chunkPercent(chunksDone: number | null | undefined, chunkCount: number | null | undefined): number {
  if (!chunkCount || chunkCount <= 0) return 0;
  return clampPct(Math.round(((chunksDone ?? 0) / chunkCount) * 100));
}

/**
 * Per-stage bars: finished stages 100 %, the current stage at the chunk percent, later stages 0 %. Completed = all
 * 100 %; queued or unknown stage = all 0 % (the overall chunk percent shows in the first bar while processing).
 */
export function stagePercents(p: Pick<Progress, 'status' | 'stage' | 'chunksDone' | 'chunkCount'>): number[] {
  if (p.status === 'completed') return STAGES.map(() => 100);
  const pct = chunkPercent(p.chunksDone, p.chunkCount);
  const i = STAGES.findIndex((s) => s.key === p.stage);
  if (p.status !== 'processing') return STAGES.map(() => 0);
  if (i < 0) return STAGES.map((_, k) => (k === 0 ? pct : 0));
  return STAGES.map((_, k) => (k < i ? 100 : k === i ? pct : 0));
}

/** "about 3 min left" / "less than a minute left" / "" when unknown. */
export function etaText(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return 'less than a minute left';
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `about ${h} h${m ? ` ${m} min` : ''} left`;
}

// ---------------------------------------------------------------------------------------------------------------
// Report

/** Report tiles (US-01 AC4). Optional counts show only when present. */
export function reportTiles(c: Partial<UploadCounts> | null | undefined): [string, number][] {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const tiles: [string, number][] = [
    ['Rows read', n(c?.read)],
    ['Accepted', n(c?.accepted)],
    ['Rejected', n(c?.rejected)],
    ['Needs review', n(c?.needsReview)],
    ['Unchanged', n(c?.unchanged)],
  ];
  if (typeof c?.unclassified === 'number') tiles.push(['Unclassified', c.unclassified]);
  if (typeof c?.migrationEntries === 'number' && c.migrationEntries > 0) tiles.push(['Migration map entries', c.migrationEntries]);
  return tiles;
}

const ROW_ERROR_LABELS: Record<string, string> = {
  'value-not-in-list': 'Value not in the controlled list',
  'invalid-type': 'Wrong type of value',
  'invalid-date': 'Invalid date',
  'required-missing': 'Required value missing',
  'range-inverted': 'Minimum above maximum',
  'invalid-phone': 'Invalid phone number',
  'scope-deal-type-mismatch': 'Deal type not allowed for the record scope',
  'segment-property-type-mismatch': 'Property type not in the segment',
  'market-on-non-sale': 'Market given for a non-sale deal',
  'side-scope-mismatch': 'Side not allowed for the record scope',
  'duplicate-external-ref': 'Duplicate record id in the file',
  'migration-entry-invalid': 'Invalid migration map entry',
  'parse-error': 'Row could not be read',
};
export const rowErrorLabel = (code: string): string => ROW_ERROR_LABELS[code] ?? code.replace(/-/g, ' ');

/** Rejection reasons from a page of row errors: code → count, most frequent first (errors only, not warnings). */
export function rejectionReasons(errors: readonly Pick<RowError, 'code' | 'severity'>[]): { code: string; label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of errors) if (e.severity !== 'warning') m.set(e.code, (m.get(e.code) ?? 0) + 1);
  return [...m]
    .map(([code, count]) => ({ code, label: rowErrorLabel(code), count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------------------------------------------
// Review queue (C-05)

/** Can this person work the review queue? Admin, Manager, Data operator, or an agent with the Data operator flag. */
export function canReview(me: Pick<Me, 'role' | 'isDataOperator' | 'permissions'>): boolean {
  return (
    me.role === 'Admin' ||
    me.role === 'Manager' ||
    me.role === 'Data operator' ||
    me.isDataOperator ||
    (me.permissions ?? []).includes('review.work')
  );
}

/** Classification reasons (intake reasonCode) in the priority order of the LLD, then the two record-side groups. */
export const CLASSIFICATION_REASONS = [
  'side_unclear',
  'side_defaulted',
  'deal_type_missing',
  'property_type_missing',
  'value_not_translatable',
  'low_confidence',
  'model_unavailable',
  'other',
] as const satisfies readonly ReviewReason[];

export type RecordGroup = 'uncertain_merge' | 'price_gap';
export type ReviewGroupKey = ReviewReason | RecordGroup;

const REASON_LABELS: Record<ReviewGroupKey, string> = {
  side_unclear: 'Side unclear',
  side_defaulted: 'Side defaulted to Supply',
  deal_type_missing: 'Deal type missing',
  property_type_missing: 'Property type missing',
  value_not_translatable: 'Value not in list',
  low_confidence: 'Low confidence',
  model_unavailable: 'Classifier unavailable',
  other: 'Other (scope unclear, redaction)',
  uncertain_merge: 'Uncertain merge',
  price_gap: 'Price gap between sources',
};

const REASON_HINTS: Record<ReviewGroupKey, string> = {
  side_unclear: 'No side evidence. Choose Supply, Demand or None.',
  side_defaulted: 'Side was set to Supply by default. Confirm or correct it.',
  deal_type_missing: 'Choose the deal type (and market for Sale).',
  property_type_missing: 'Choose the segment and property type.',
  value_not_translatable: 'A legacy value had no match in the controlled list. Set the field.',
  low_confidence: 'The classifier was not sure. Check the classification.',
  model_unavailable: 'The classifier was not reachable. Check the classification.',
  other: 'Check the record scope and classification.',
  uncertain_merge: 'Possibly the same record. A phone number alone never merges records.',
  price_gap: 'Another source quotes a price more than 5% different.',
};

const isGroupKey = (k: string): k is ReviewGroupKey => k in REASON_LABELS;
export const reasonLabel = (k: string): string => (isGroupKey(k) ? REASON_LABELS[k] : k.replace(/_/g, ' '));
export const reasonHint = (k: string): string => (isGroupKey(k) ? REASON_HINTS[k] : '');

export interface ReviewGroup {
  key: ReviewGroupKey;
  label: string;
  open: number;
  /** true when the count is a lower bound (one page of a record-side queue). */
  more?: boolean;
  oldestAt?: string | null;
}

/**
 * Group headers for the review card: intake summary groups (unknown reason codes fold into "other"), in priority
 * order, then uncertain merges and price gaps. Empty groups are dropped.
 */
export function reviewGroups(
  summary: readonly { reasonCode: string; open: number; oldestAt?: string | null }[] | null | undefined,
  records: { merges?: { open: number; more: boolean } | null; priceGaps?: { open: number; more: boolean } | null } = {},
): ReviewGroup[] {
  const byCode = new Map<ReviewReason, { open: number; oldestAt: string | null }>();
  for (const g of summary ?? []) {
    const code: ReviewReason = (CLASSIFICATION_REASONS as readonly string[]).includes(g.reasonCode)
      ? (g.reasonCode as ReviewReason)
      : 'other';
    const open = typeof g.open === 'number' && g.open > 0 ? g.open : 0;
    const prev = byCode.get(code);
    const oldest = [prev?.oldestAt, g.oldestAt ?? null].filter((x): x is string => !!x).sort()[0] ?? null;
    byCode.set(code, { open: (prev?.open ?? 0) + open, oldestAt: oldest });
  }
  const groups: ReviewGroup[] = [];
  for (const code of CLASSIFICATION_REASONS) {
    const g = byCode.get(code);
    if (g && g.open > 0) groups.push({ key: code, label: REASON_LABELS[code], open: g.open, oldestAt: g.oldestAt });
  }
  if (records.merges && records.merges.open > 0) {
    groups.push({ key: 'uncertain_merge', label: REASON_LABELS.uncertain_merge, open: records.merges.open, more: records.merges.more });
  }
  if (records.priceGaps && records.priceGaps.open > 0) {
    groups.push({ key: 'price_gap', label: REASON_LABELS.price_gap, open: records.priceGaps.open, more: records.priceGaps.more });
  }
  return groups;
}

export type ClassField = 'recordScope' | 'side' | 'dealType' | 'market' | 'segment' | 'propertyType';

/** Which classification dropdowns an item of this reason offers (the fix, BRD order). */
export function fieldsFor(reason: string): ClassField[] {
  switch (reason) {
    case 'side_unclear':
    case 'side_defaulted':
      return ['side'];
    case 'deal_type_missing':
      return ['dealType', 'market'];
    case 'property_type_missing':
      return ['segment', 'propertyType'];
    default:
      return ['recordScope', 'dealType', 'market', 'segment', 'propertyType', 'side'];
  }
}

export const SIDES = ['Supply', 'Demand', 'None'] as const;

/** Draft of single-choice dropdown values; null = leave as is / blank. */
export interface ClassDraft {
  recordScope?: string | null;
  side?: string | null;
  dealType?: string | null;
  market?: string | null;
  segment?: string | null;
  propertyType?: string | null;
}

/** The draft to start editing from: suggestion first, then the current values. */
export function draftFrom(item: Pick<ReviewItem, 'current' | 'suggested'>): ClassDraft {
  const s = item.suggested ?? null;
  const c = item.current ?? {};
  const first = <T,>(...v: (T | null | undefined)[]): T | null => v.find((x) => x != null) ?? null;
  return {
    recordScope: first(s?.recordScope, c.recordScope),
    side: first(s?.side, c.side),
    dealType: first(s?.dealTypes?.[0], c.dealTypes?.[0]),
    market: first(s?.market, c.market),
    segment: first(s?.segment, c.segment),
    propertyType: first(s?.propertyTypes?.[0], c.propertyTypes?.[0]),
  };
}

/**
 * Classification for `set`: the current values with the draft applied (BRD order). A market is kept only when the deal
 * types include Sale (resolveReviewItem rule "market only with Sale").
 */
export function classificationFrom(current: Classification | null | undefined, draft: ClassDraft): Classification {
  const c = current ?? {};
  const pick = <T,>(d: T | null | undefined, cur: T | null | undefined): T | null => (d !== undefined ? d : cur) ?? null;
  const dealTypes = draft.dealType !== undefined ? (draft.dealType ? [draft.dealType] : []) : [...(c.dealTypes ?? [])];
  const propertyTypes =
    draft.propertyType !== undefined ? (draft.propertyType ? [draft.propertyType] : []) : [...(c.propertyTypes ?? [])];
  const market = dealTypes.includes('Sale') ? pick(draft.market, c.market) : null;
  return {
    recordScope: pick(draft.recordScope, c.recordScope) as Exclude<Classification['recordScope'], undefined>,
    side: pick(draft.side, c.side) as Exclude<Classification['side'], undefined>,
    dealTypes,
    market,
    segment: pick(draft.segment, c.segment),
    propertyTypes,
  };
}

/** Draft limited to the fields a reason offers (other fields keep their current values). */
export function draftForReason(reason: string, draft: ClassDraft): ClassDraft {
  const out: ClassDraft = {};
  for (const f of fieldsFor(reason)) out[f] = draft[f] ?? null;
  return out;
}

export function buildResolve(
  action: ResolveBody['action'],
  opts: { current?: Classification | null; draft?: ClassDraft; note?: string } = {},
): ResolveBody {
  const note = opts.note?.trim().slice(0, 500);
  return {
    action,
    ...(action === 'set' ? { classification: classificationFrom(opts.current, opts.draft ?? {}) } : {}),
    ...(note ? { note } : {}),
  };
}

/** What a draft is still missing before "Apply" (the fields the reason asks for must be chosen). */
export function draftMissing(reason: string, draft: ClassDraft): ClassField[] {
  return fieldsFor(reason).filter((f) => f !== 'market' && !draft[f]);
}

export const BULK_MAX = 100;

export function buildBulk(
  ids: readonly string[],
  action: BulkResolveBody['action'],
  classification?: Classification,
): BulkResolveBody {
  const unique = [...new Set(ids)].slice(0, BULK_MAX);
  if (unique.length === 0) throw new Error('no items selected');
  return { ids: unique, action, ...(action === 'set' && classification ? { classification } : {}) };
}

/** Bulk "set side" keeps each item's other values, so it is only offered for the side groups. */
export const bulkSideGroup = (reason: string): boolean => reason === 'side_unclear' || reason === 'side_defaulted';

/** Short text for a classification ("Property · Rent · Commercial · Office · Supply"); blanks are skipped. */
export function classificationText(c: Classification | null | undefined): string {
  if (!c) return '—';
  const parts = [
    c.recordScope,
    (c.dealTypes ?? []).join('/'),
    c.market,
    c.segment,
    (c.propertyTypes ?? []).join('/'),
    c.side ? `side ${c.side}` : null,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : 'Not classified';
}

// Record-side review (records service)

/** Merge the incoming record (right) into the existing one (left), keeping the existing record (prototype C-05). */
export function buildMerge(c: Pick<MergeCandidate, 'id' | 'aggregateType' | 'leftId' | 'rightId'>): MergeBody | null {
  if (!c.rightId || c.rightId === c.leftId) return null;
  return { aggregateType: c.aggregateType, survivorId: c.leftId, mergedIds: [c.rightId], candidateId: c.id };
}

const MERGE_REASON: Record<string, string> = {
  possible_repeat: 'Possible repeat post',
  property_match: 'Same building, floor and area',
  demand_similarity: 'Similar requirement',
  person_phone: 'Same phone number',
};
export const mergeReasonLabel = (r: string): string => MERGE_REASON[r] ?? r.replace(/_/g, ' ');

/** Score 0–1 → "87%". */
export const scorePct = (s: number | null | undefined): string =>
  typeof s === 'number' && Number.isFinite(s) ? `${Math.round(clampPct(s * 100))}%` : '—';

/** Plain evidence rows from a merge candidate (primitive values only, at most 8). */
export function evidenceRows(evidence: unknown): [string, string][] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(evidence as Record<string, unknown>)) {
    if (rows.length >= 8) break;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') rows.push([targetLabel(k), String(v)]);
  }
  return rows;
}

/** "+7.5%" / "−3%" / "—". */
export function gapText(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  const r = Math.round(pct * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}%`;
}

/** Price of a second source: sale range, else monthly rent range ("₹8 L – ₹8.5 L", "₹45,000 /month"). */
export function sourcePriceText(
  s: Pick<SecondSource, 'salePriceInrMin' | 'salePriceInrMax' | 'rentMonthlyInrMin' | 'rentMonthlyInrMax'>,
): string {
  const range = (a: number | null | undefined, b: number | null | undefined): string | null => {
    if (a == null && b == null) return null;
    if (a == null || b == null || a === b) return inr(a ?? b);
    return `${inr(a)} – ${inr(b)}`;
  };
  const sale = range(s.salePriceInrMin, s.salePriceInrMax);
  if (sale) return sale;
  const rent = range(s.rentMonthlyInrMin, s.rentMonthlyInrMax);
  return rent ? `${rent} /month` : '—';
}

/** Vocabulary shape used here (records GET /v1/vocabulary): field values and per-scope allowed deal types. */
export interface VocabLike {
  fields?: Record<string, { values?: string[]; bySegment?: Record<string, string[]> } | undefined>;
  recordScopes?: { value?: string; allowedDealTypes?: string[] }[];
}

/** Record scopes from the vocabulary (falls back to the contract enum). */
export function recordScopeOptions(vocab: VocabLike | undefined): string[] {
  const v = (vocab?.recordScopes ?? []).map((r) => r.value).filter((x): x is string => !!x);
  return v.length ? v : [...RECORD_SCOPES];
}

/** Deal types allowed for a record scope (scope → deal_type, BRD §4.2); all deal types when the scope is not known. */
export function dealTypeOptions(vocab: VocabLike | undefined, scope: string | null | undefined): string[] {
  const all = vocab?.fields?.['deal_type']?.values ?? [];
  const allowed = scope ? vocab?.recordScopes?.find((r) => r.value === scope)?.allowedDealTypes : undefined;
  if (!allowed?.length) return all;
  const inAll = all.filter((d) => allowed.includes(d));
  return inAll.length ? inAll : allowed;
}
