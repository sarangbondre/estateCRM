// The standard upload schema (PRD Appendix C, CR-006 Z-1), strict vs mapping mode detection (D-15, LLD §4.2),
// header fingerprints, suggested mappings and mapping validation.
import { createHash } from 'node:crypto';
import { isValidValue } from '@11e/vocabulary';
import type { FieldIssue } from './errors.js';

/** The 91 Appendix C columns (CR-012 added building_name and floor), in Appendix C order. */
export const STANDARD_COLUMNS = [
  'lead_status', 'follow_up_date', 'crm_notes', 'route_to',
  'needs_review', 'review_reason',
  'record_id', 'parent_record_id', 'split_index',
  'record_scope', 'deal_type', 'market', 'segment', 'property_type', 'property_detail',
  'building_name', 'floor', 'land_use', 'side', 'side_evidence',
  'sale_mode', 'deadline_date', 'tenancy_status', 'tenure', 'agreement_form', 'is_jodi', 'possession_status',
  'possession_date', 'furnishing',
  'sector', 'includes_property', 'business_description', 'participant_role', 'signal_type',
  'project_name', 'developer_name',
  'bhk_min', 'bhk_max', 'features',
  'locality', 'city', 'state', 'landmark', 'location_text',
  'area_sqft_min', 'area_sqft_max', 'area_basis', 'land_area_value', 'land_area_unit', 'land_area_sqft', 'area_text',
  'price_text', 'sale_price_inr_min', 'sale_price_inr_max', 'sale_rate_inr', 'sale_rate_unit', 'price_negotiable',
  'rent_monthly_inr_min', 'rent_monthly_inr_max', 'rent_rate_psf', 'deposit_inr', 'deposit_months', 'current_rent_inr',
  'yield_pct',
  'contact_name', 'company_name', 'party_type', 'phones', 'whatsapp_phone', 'emails', 'rera_number', 'other_contact',
  'source_channel', 'source_name', 'source_edition', 'source_supplement', 'source_date', 'source_page', 'source_files',
  'first_seen_date', 'last_seen_date', 'times_seen', 'possible_repeat_of',
  'raw_text', 'source_language', 'ocr_used', 'extraction_confidence', 'extractor_notes',
  'sender_name', 'sender_phone', 'text_variants',
] as const; // prettier-ignore
export type StandardColumn = (typeof STANDARD_COLUMNS)[number];

/** Mapping-mode targets beyond Appendix C (Digi exports, broker sheets; LLD §10 Q-I3). */
export const EXTRA_TARGETS = [
  'external_id',
  'campaign_ref',
  'form_ref',
  'listing_ref',
  'project_ref',
  'enquiry_message',
  'enquiry_received_at',
  'photo_urls',
  'free_text',
] as const;
export type ExtraTarget = (typeof EXTRA_TARGETS)[number];
export type TargetField = StandardColumn | ExtraTarget;

export const MAPPING_TARGETS: readonly TargetField[] = [...STANDARD_COLUMNS, ...EXTRA_TARGETS];
const TARGET_SET: ReadonlySet<string> = new Set(MAPPING_TARGETS);
const STANDARD_SET: ReadonlySet<string> = new Set(STANDARD_COLUMNS);

/** Optional since CR-012: the 89-column files of older extractor versions lack them and are still strict. */
export const OPTIONAL_STANDARD_COLUMNS: readonly StandardColumn[] = ['building_name', 'floor'];
const LEGACY_SET: ReadonlySet<string> = new Set(
  STANDARD_COLUMNS.filter((c) => !OPTIONAL_STANDARD_COLUMNS.includes(c)),
);

/** Targets that may be mapped from several columns (values are concatenated). */
export const MULTI_TARGETS: ReadonlySet<TargetField> = new Set(['phones', 'emails', 'free_text']);

/** Fields holding personal data: never logged, never stored in row_errors.value (LLD §3.4, §7). */
export const PII_FIELDS: ReadonlySet<string> = new Set([
  'contact_name',
  'phones',
  'emails',
  'whatsapp_phone',
  'other_contact',
  'raw_text',
  'sender_name',
  'sender_phone',
  'text_variants',
  'crm_notes',
  'enquiry_message',
  'free_text',
  'side_evidence',
  // CR-012: private (never public); floor is PII-sensitive, the building name identifies the unit's location
  'building_name',
  'floor',
]);

export const LOAD_SHEET = 'leads';
export const MIGRATION_SHEET = 'migration_map';
export const RUN_LOG_SHEET = 'run_log';

/** LLD §4.2 step 1: trim, lower-case, spaces and hyphens → `_`. */
export function normaliseHeader(h: string | null | undefined): string {
  return (h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** sha256 of the sorted normalised headers (templates, duplicate header sets). */
export function headerFingerprint(headers: readonly (string | null)[]): string {
  const sorted = headers
    .map(normaliseHeader)
    .filter((h) => h !== '')
    .sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/**
 * Strict iff the normalised header set equals the 91 Appendix C names, or the 89 names of older extractor versions
 * (without building_name and floor, CR-012). Order ignored; no extras, no repeats.
 */
export function isStrictHeader(headers: readonly (string | null)[]): boolean {
  const names = headers.map(normaliseHeader).filter((h) => h !== '');
  const set = new Set(names);
  if (set.size !== names.length) return false;
  const equals = (want: ReadonlySet<string>) => set.size === want.size && [...set].every((n) => want.has(n));
  return equals(STANDARD_SET) || equals(LEGACY_SET);
}

/** Load sheet: `Leads` if present (case-insensitive), else the first sheet. */
export function chooseLoadSheet(sheetNames: readonly string[]): string | null {
  const special = new Set([MIGRATION_SHEET, RUN_LOG_SHEET]);
  return (
    sheetNames.find((s) => normaliseHeader(s) === LOAD_SHEET) ??
    sheetNames.find((s) => !special.has(normaliseHeader(s))) ??
    sheetNames[0] ??
    null
  );
}

/** Common headers of Digi exports and broker sheets → target (LLD §4.2 step 4). Keys are normalised headers. */
const SYNONYMS: Readonly<Record<string, TargetField>> = {
  mobile: 'phones',
  mobile_no: 'phones',
  mobile_number: 'phones',
  phone: 'phones',
  phone_no: 'phones',
  phone_number: 'phones',
  contact_no: 'phones',
  contact_number: 'phones',
  alternate_number: 'phones',
  whatsapp: 'whatsapp_phone',
  whatsapp_number: 'whatsapp_phone',
  email: 'emails',
  email_id: 'emails',
  e_mail: 'emails',
  name: 'contact_name',
  full_name: 'contact_name',
  customer_name: 'contact_name',
  contact_person: 'contact_name',
  client_name: 'contact_name',
  lead_name: 'contact_name',
  rent: 'rent_monthly_inr_min',
  monthly_rent: 'rent_monthly_inr_min',
  expected_rent: 'rent_monthly_inr_min',
  deposit: 'deposit_inr',
  price: 'price_text',
  budget: 'price_text',
  expected_price: 'price_text',
  lead_id: 'external_id',
  enquiry_id: 'external_id',
  id: 'external_id',
  campaign: 'campaign_ref',
  campaign_name: 'campaign_ref',
  campaign_id: 'campaign_ref',
  ad_name: 'campaign_ref',
  form: 'form_ref',
  form_name: 'form_ref',
  form_id: 'form_ref',
  listing_id: 'listing_ref',
  property_id: 'listing_ref',
  project: 'project_ref',
  project_id: 'project_ref',
  location: 'location_text',
  address: 'location_text',
  area_name: 'locality',
  sub_locality: 'locality',
  transaction_type: 'deal_type',
  deal: 'deal_type',
  requirement_type: 'deal_type',
  type: 'property_type',
  configuration: 'property_type',
  listing_category: 'property_type',
  asset_class: 'segment',
  broker_or_owner: 'party_type',
  posted_by: 'party_type',
  carpet_area: 'area_sqft_min',
  area_sqft: 'area_sqft_min',
  size: 'area_text',
  message: 'enquiry_message',
  comments: 'enquiry_message',
  requirement: 'free_text',
  description: 'free_text',
  details: 'free_text',
  remarks: 'free_text',
  ad_text: 'raw_text',
  text: 'raw_text',
  lead_date: 'enquiry_received_at',
  created_at: 'enquiry_received_at',
  created_time: 'enquiry_received_at',
  enquiry_date: 'enquiry_received_at',
  photos: 'photo_urls',
  images: 'photo_urls',
  source: 'source_name',
};

const DIGI_REF_TARGETS: readonly TargetField[] = ['campaign_ref', 'form_ref', 'listing_ref', 'project_ref'];

/** Target suggested for one header: exact Appendix C / extra name → synonym → null. */
export function suggestTarget(header: string): TargetField | null {
  const n = normaliseHeader(header);
  if (TARGET_SET.has(n)) return n as TargetField;
  return SYNONYMS[n] ?? null;
}

/** sourceHeader → target (never cell values). Uses the template map when its fingerprint matched. */
export function suggestMapping(
  headers: readonly string[],
  templateMap?: Readonly<Record<string, string | null>>,
): Record<string, TargetField | null> {
  const out: Record<string, TargetField | null> = {};
  const used = new Set<string>();
  for (const h of headers) {
    if (!h.trim()) continue;
    const fromTemplate = templateMap?.[h];
    let target: TargetField | null =
      fromTemplate !== undefined && (fromTemplate === null || TARGET_SET.has(fromTemplate))
        ? (fromTemplate as TargetField | null)
        : suggestTarget(h);
    if (target && used.has(target) && !MULTI_TARGETS.has(target)) target = null;
    if (target) used.add(target);
    out[h] = target;
  }
  return out;
}

export interface MappingConstants {
  sourceType?: string | undefined;
  sourceName?: string | undefined;
  sourceChannel?: string | null | undefined;
  recordScope?: string | undefined;
}

/**
 * LLD §4.2 step 5: each target at most once (except phones, emails, free_text); record_scope mapped or constant, or
 * at least one of raw_text / free_text / deal_type / property_type mapped; Digi uploads map a campaign/form/listing/
 * project reference when the header has a candidate column. Returns field issues (empty = valid).
 */
export function validateMapping(
  columnMap: Readonly<Record<string, string | null>>,
  constants: MappingConstants,
  sourceType: string,
  headers: readonly string[],
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const headerSet = new Set(headers);
  const seen = new Map<string, string>();
  for (const [header, target] of Object.entries(columnMap)) {
    if (!headerSet.has(header)) {
      issues.push({
        field: `columnMap.${header}`,
        code: 'unknown-column',
        message: `"${header}" is not in the header row`,
      });
    }
    if (target === null) continue;
    if (!TARGET_SET.has(target)) {
      issues.push({
        field: `columnMap.${header}`,
        code: 'unknown-target',
        message: `"${target}" is not a target field`,
      });
      continue;
    }
    const other = seen.get(target);
    if (other !== undefined && !MULTI_TARGETS.has(target as TargetField)) {
      issues.push({
        field: `columnMap.${header}`,
        code: 'duplicate-target',
        message: `"${target}" is already mapped from "${other}"`,
      });
    }
    seen.set(target, header);
  }
  if (constants.recordScope !== undefined && !isValidValue('record_scope', constants.recordScope)) {
    issues.push({
      field: 'constants.recordScope',
      code: 'value-not-in-list',
      message: 'not a record_scope value',
    });
  }
  const hasInput =
    seen.has('record_scope') ||
    constants.recordScope !== undefined ||
    ['raw_text', 'free_text', 'deal_type', 'property_type'].some((t) => seen.has(t));
  if (!hasInput) {
    issues.push({
      field: 'columnMap',
      code: 'classifier-input-missing',
      message:
        'map record_scope (or set it as a constant) or at least one of raw_text, free_text, deal_type, property_type',
    });
  }
  if (sourceType === 'Digi') {
    const candidate = headers.some((h) => {
      const t = suggestTarget(h);
      return t !== null && DIGI_REF_TARGETS.includes(t);
    });
    if (candidate && !DIGI_REF_TARGETS.some((t) => seen.has(t))) {
      issues.push({
        field: 'columnMap',
        code: 'digi-reference-missing',
        message: 'map one of campaign_ref, form_ref, listing_ref, project_ref (US-01 AC2)',
      });
    }
  }
  return issues;
}
