// Field dictionary of the upload schema (PRD Appendix C + mapping extras): the IntakeRow (camelCase) name and the kind
// of parsing each column needs (LLD §4.4). Classification fields are validated together (see rows.ts).
import type { VocabularyField } from '@11e/vocabulary';
import type { TargetField } from './schema.js';

export type FieldKind =
  | 'ignored' // lead_status, follow_up_date (CR-006 Z-8)
  | 'text'
  | 'bool'
  | 'int'
  | 'number'
  | 'date'
  | 'datetime'
  | 'possession'
  | 'controlled'
  | 'phones'
  | 'phone'
  | 'emails'
  | 'urls'
  | 'special'; // handled explicitly: identity, review flag, classification, crm_notes, free_text

export interface FieldSpec {
  kind: FieldKind;
  /** IntakeRow property (absent for special/ignored columns). */
  key?: string;
  /** Vocabulary field for `controlled`. */
  vocab?: VocabularyField;
}

const t = (key: string): FieldSpec => ({ kind: 'text', key });
const c = (key: string, vocab: VocabularyField): FieldSpec => ({ kind: 'controlled', key, vocab });

export const FIELD_SPECS: Readonly<Record<TargetField, FieldSpec>> = {
  lead_status: { kind: 'ignored' },
  follow_up_date: { kind: 'ignored' },
  crm_notes: { kind: 'special', key: 'crmNotes' },
  route_to: c('routeTo', 'route_to'),
  needs_review: { kind: 'special' },
  review_reason: { kind: 'special', key: 'reviewReason' },
  record_id: { kind: 'special' },
  parent_record_id: { kind: 'special' },
  split_index: t('splitIndex'),
  record_scope: { kind: 'special', key: 'recordScope' },
  deal_type: { kind: 'special', key: 'dealTypes' },
  market: { kind: 'special', key: 'market' },
  segment: { kind: 'special', key: 'segment' },
  property_type: { kind: 'special', key: 'propertyTypes' },
  property_detail: t('propertyDetail'),
  land_use: { kind: 'special', key: 'landUse' },
  side: { kind: 'special', key: 'side' },
  side_evidence: t('sideEvidence'),
  sale_mode: c('saleMode', 'sale_mode'),
  deadline_date: { kind: 'date', key: 'deadlineDate' },
  tenancy_status: c('tenancyStatus', 'tenancy_status'),
  tenure: c('tenure', 'tenure'),
  agreement_form: c('agreementForm', 'agreement_form'),
  is_jodi: { kind: 'bool', key: 'isJodi' },
  possession_status: c('possessionStatus', 'possession_status'),
  possession_date: { kind: 'possession', key: 'possessionDate' },
  furnishing: c('furnishing', 'furnishing'),
  sector: c('sector', 'sector'),
  includes_property: c('includesProperty', 'includes_property'),
  business_description: t('businessDescription'),
  participant_role: c('participantRole', 'participant_role'),
  signal_type: c('signalType', 'signal_type'),
  project_name: t('projectName'),
  developer_name: t('developerName'),
  bhk_min: { kind: 'number', key: 'bhkMin' },
  bhk_max: { kind: 'number', key: 'bhkMax' },
  features: t('features'),
  locality: t('locality'),
  city: t('city'),
  state: t('state'),
  landmark: t('landmark'),
  location_text: t('locationText'),
  area_sqft_min: { kind: 'number', key: 'areaSqftMin' },
  area_sqft_max: { kind: 'number', key: 'areaSqftMax' },
  area_basis: c('areaBasis', 'area_basis'),
  land_area_value: { kind: 'number', key: 'landAreaValue' },
  land_area_unit: c('landAreaUnit', 'land_area_unit'),
  land_area_sqft: { kind: 'number', key: 'landAreaSqft' },
  area_text: t('areaText'),
  price_text: t('priceText'),
  sale_price_inr_min: { kind: 'int', key: 'salePriceInrMin' },
  sale_price_inr_max: { kind: 'int', key: 'salePriceInrMax' },
  sale_rate_inr: { kind: 'int', key: 'saleRateInr' },
  sale_rate_unit: c('saleRateUnit', 'sale_rate_unit'),
  price_negotiable: { kind: 'bool', key: 'priceNegotiable' },
  rent_monthly_inr_min: { kind: 'int', key: 'rentMonthlyInrMin' },
  rent_monthly_inr_max: { kind: 'int', key: 'rentMonthlyInrMax' },
  rent_rate_psf: { kind: 'number', key: 'rentRatePsf' },
  deposit_inr: { kind: 'int', key: 'depositInr' },
  deposit_months: { kind: 'int', key: 'depositMonths' },
  current_rent_inr: { kind: 'int', key: 'currentRentInr' },
  yield_pct: { kind: 'number', key: 'yieldPct' },
  contact_name: t('contactName'),
  company_name: t('companyName'),
  party_type: c('partyType', 'party_type'),
  phones: { kind: 'phones', key: 'phones' },
  whatsapp_phone: { kind: 'phone', key: 'whatsappPhone' },
  emails: { kind: 'emails', key: 'emails' },
  rera_number: t('reraNumber'),
  other_contact: t('otherContact'),
  source_channel: c('sourceChannel', 'source_channel'),
  source_name: t('sourceName'),
  source_edition: t('sourceEdition'),
  source_supplement: t('sourceSupplement'),
  source_date: { kind: 'date', key: 'sourceDate' },
  source_page: { kind: 'int', key: 'sourcePage' },
  source_files: t('sourceFiles'),
  first_seen_date: { kind: 'date', key: 'firstSeenDate' },
  last_seen_date: { kind: 'date', key: 'lastSeenDate' },
  times_seen: { kind: 'int', key: 'timesSeen' },
  possible_repeat_of: t('possibleRepeatOf'),
  raw_text: t('rawText'),
  source_language: t('sourceLanguage'),
  ocr_used: { kind: 'bool', key: 'ocrUsed' },
  extraction_confidence: { kind: 'number', key: 'extractionConfidence' },
  extractor_notes: t('extractorNotes'),
  sender_name: t('senderName'),
  sender_phone: { kind: 'phone', key: 'senderPhone' },
  text_variants: t('textVariants'),
  external_id: { kind: 'special' },
  campaign_ref: t('campaignRef'),
  form_ref: t('formRef'),
  listing_ref: t('listingRef'),
  project_ref: t('projectRef'),
  enquiry_message: t('enquiryMessage'),
  enquiry_received_at: { kind: 'datetime', key: 'enquiryReceivedAt' },
  photo_urls: { kind: 'urls', key: 'photoUrls' },
  free_text: { kind: 'special' },
};

/** `_min` > `_max` → range-inverted (R-11). */
export const RANGE_PAIRS: readonly (readonly [TargetField, TargetField, string, string])[] = [
  ['bhk_min', 'bhk_max', 'bhkMin', 'bhkMax'],
  ['area_sqft_min', 'area_sqft_max', 'areaSqftMin', 'areaSqftMax'],
  ['sale_price_inr_min', 'sale_price_inr_max', 'salePriceInrMin', 'salePriceInrMax'],
  ['rent_monthly_inr_min', 'rent_monthly_inr_max', 'rentMonthlyInrMin', 'rentMonthlyInrMax'],
];
