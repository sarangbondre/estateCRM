/**
 * The 91-column extractor upload schema (PRD Appendix C, CR-006 Z-1; CR-012 added building_name and floor), in
 * Appendix C order. A file whose header equals this set (or this set without building_name and floor, the older
 * 89-column files) is read by intake in strict mode (intake LLD §4.2).
 * `tests/columns.test.ts` checks this list against the PRD so the two cannot drift.
 */
export const EXTRACTOR_COLUMNS = [
  // CRM working columns
  'lead_status',
  'follow_up_date',
  'crm_notes',
  'route_to',
  // Review
  'needs_review',
  'review_reason',
  // Identity and splits
  'record_id',
  'parent_record_id',
  'split_index',
  // Classification
  'record_scope',
  'deal_type',
  'market',
  'segment',
  'property_type',
  'property_detail',
  'building_name',
  'floor',
  'land_use',
  'side',
  'side_evidence',
  // Deal tags
  'sale_mode',
  'deadline_date',
  'tenancy_status',
  'tenure',
  'agreement_form',
  'is_jodi',
  'possession_status',
  'possession_date',
  'furnishing',
  // Non-property
  'sector',
  'includes_property',
  'business_description',
  'participant_role',
  'signal_type',
  // Project
  'project_name',
  'developer_name',
  // Configuration and features
  'bhk_min',
  'bhk_max',
  'features',
  // Location
  'locality',
  'city',
  'state',
  'landmark',
  'location_text',
  // Area
  'area_sqft_min',
  'area_sqft_max',
  'area_basis',
  'land_area_value',
  'land_area_unit',
  'land_area_sqft',
  'area_text',
  // Price
  'price_text',
  'sale_price_inr_min',
  'sale_price_inr_max',
  'sale_rate_inr',
  'sale_rate_unit',
  'price_negotiable',
  'rent_monthly_inr_min',
  'rent_monthly_inr_max',
  'rent_rate_psf',
  'deposit_inr',
  'deposit_months',
  'current_rent_inr',
  'yield_pct',
  // Contact (PII)
  'contact_name',
  'company_name',
  'party_type',
  'phones',
  'whatsapp_phone',
  'emails',
  'rera_number',
  'other_contact',
  // Source
  'source_channel',
  'source_name',
  'source_edition',
  'source_supplement',
  'source_date',
  'source_page',
  'source_files',
  // Repeats
  'first_seen_date',
  'last_seen_date',
  'times_seen',
  'possible_repeat_of',
  // Extraction
  'raw_text',
  'source_language',
  'ocr_used',
  'extraction_confidence',
  'extractor_notes',
  // WhatsApp extractor
  'sender_name',
  'sender_phone',
  'text_variants',
] as const;

export type ExtractorColumn = (typeof EXTRACTOR_COLUMNS)[number];

/** Optional since CR-012: without them the header is the legacy 89-column one, which intake still reads as strict. */
export const LEGACY_OMITTED_COLUMNS: readonly ExtractorColumn[] = ['building_name', 'floor'];

/** A cell value. Dates are ISO `YYYY-MM-DD` strings; blank is `null`. */
export type CellValue = string | number | boolean | null;

/** One row of the extractor file, keyed by column name. */
export type ExtractorRow = Record<ExtractorColumn, CellValue>;

/** Date columns (written as real date cells in XLSX, like the extractor master). */
export const DATE_COLUMNS: ReadonlySet<ExtractorColumn> = new Set<ExtractorColumn>([
  'follow_up_date',
  'deadline_date',
  'source_date',
  'first_seen_date',
  'last_seen_date',
]);

/** Contact columns that are PII (Appendix C "Contact", WhatsApp sender). */
export const PII_COLUMNS: ReadonlySet<ExtractorColumn> = new Set<ExtractorColumn>([
  'contact_name',
  'phones',
  'whatsapp_phone',
  'emails',
  'other_contact',
  'raw_text',
  'sender_name',
  'sender_phone',
  'text_variants',
  'crm_notes',
]);

/** A row with every column blank. */
export function blankRow(): ExtractorRow {
  const row = {} as Record<ExtractorColumn, CellValue>;
  for (const column of EXTRACTOR_COLUMNS) row[column] = null;
  return row;
}
