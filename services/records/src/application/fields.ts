// API field ↔ column mapping with vocabulary validation (conventions §8: x-vocabulary fields are checked at runtime
// against the active release, R-11 canonical spelling), and the staff-edit bookkeeping of LLD §4.3.
import { RecordsError } from '../domain/errors.js';
import { PROPERTY_DEAL_TYPES } from '@11e/vocabulary';
import type { VocabularyIndex } from '../domain/vocabulary.js';

export interface FieldSpec {
  /** API (camelCase) name. */
  key: string;
  column: string;
  /** Vocabulary field (x-vocabulary). */
  vocab?: string;
  trim?: boolean;
}

export const PROPERTY_FIELDS: readonly FieldSpec[] = [
  { key: 'segment', column: 'segment', vocab: 'segment' },
  { key: 'propertyTypes', column: 'property_types', vocab: 'property_type' },
  { key: 'propertyDetail', column: 'property_detail', trim: true },
  { key: 'landUse', column: 'land_use', vocab: 'land_use' },
  { key: 'locality', column: 'locality', trim: true },
  { key: 'micromarketId', column: 'micromarket_id' },
  { key: 'city', column: 'city', trim: true },
  { key: 'state', column: 'state', trim: true },
  { key: 'landmark', column: 'landmark', trim: true },
  { key: 'locationText', column: 'location_text', trim: true },
  { key: 'buildingName', column: 'building_name', trim: true },
  { key: 'wing', column: 'wing', trim: true },
  { key: 'unitNo', column: 'unit_no', trim: true },
  { key: 'floorNo', column: 'floor_no' },
  { key: 'totalFloors', column: 'total_floors' },
  { key: 'areaSqftMin', column: 'area_sqft_min' },
  { key: 'areaSqftMax', column: 'area_sqft_max' },
  { key: 'areaBasis', column: 'area_basis' },
  { key: 'landAreaValue', column: 'land_area_value' },
  { key: 'landAreaUnit', column: 'land_area_unit', vocab: 'land_area_unit' },
  { key: 'landAreaSqft', column: 'land_area_sqft' },
  { key: 'areaText', column: 'area_text', trim: true },
  { key: 'bhkMin', column: 'bhk_min' },
  { key: 'bhkMax', column: 'bhk_max' },
  { key: 'features', column: 'features', trim: true },
  { key: 'amenities', column: 'amenities' },
  { key: 'parking', column: 'parking' },
];

export const OFFER_FIELDS: readonly FieldSpec[] = [
  { key: 'dealType', column: 'deal_type', vocab: 'deal_type' },
  { key: 'market', column: 'market', vocab: 'market' },
  { key: 'salePriceInrMin', column: 'sale_price_inr_min' },
  { key: 'salePriceInrMax', column: 'sale_price_inr_max' },
  { key: 'saleRateInr', column: 'sale_rate_inr' },
  { key: 'saleRateUnit', column: 'sale_rate_unit', vocab: 'sale_rate_unit' },
  { key: 'rentMonthlyInrMin', column: 'rent_monthly_inr_min' },
  { key: 'rentMonthlyInrMax', column: 'rent_monthly_inr_max' },
  { key: 'rentRatePsf', column: 'rent_rate_psf' },
  { key: 'depositInr', column: 'deposit_inr' },
  { key: 'depositMonths', column: 'deposit_months' },
  { key: 'currentRentInr', column: 'current_rent_inr' },
  { key: 'yieldPct', column: 'yield_pct' },
  { key: 'priceNegotiable', column: 'price_negotiable' },
  { key: 'priceText', column: 'price_text', trim: true },
  { key: 'saleMode', column: 'sale_mode', vocab: 'sale_mode' },
  { key: 'deadlineDate', column: 'deadline_date' },
  { key: 'tenancyStatus', column: 'tenancy_status', vocab: 'tenancy_status' },
  { key: 'tenure', column: 'tenure', vocab: 'tenure' },
  { key: 'agreementForm', column: 'agreement_form', vocab: 'agreement_form' },
  { key: 'isJodi', column: 'is_jodi' },
  { key: 'possessionStatus', column: 'possession_status', vocab: 'possession_status' },
  { key: 'possessionDate', column: 'possession_date' },
  { key: 'furnishing', column: 'furnishing', vocab: 'furnishing' },
  { key: 'description', column: 'description', trim: true },
  { key: 'revenueShareText', column: 'revenue_share_text', trim: true },
  { key: 'revenueSharePct', column: 'revenue_share_pct' },
  { key: 'unitCount', column: 'unit_count' },
  { key: 'ownerUserId', column: 'owner_user_id' },
];

export const DEMAND_FIELDS: readonly FieldSpec[] = [
  { key: 'dealTypes', column: 'deal_types', vocab: 'deal_type' },
  { key: 'market', column: 'market', vocab: 'market' },
  { key: 'segment', column: 'segment', vocab: 'segment' },
  { key: 'propertyTypes', column: 'property_types', vocab: 'property_type' },
  { key: 'micromarketIds', column: 'micromarket_ids' },
  { key: 'localities', column: 'localities' },
  { key: 'budgetInrMin', column: 'budget_inr_min' },
  { key: 'budgetInrMax', column: 'budget_inr_max' },
  { key: 'rentMonthlyInrMin', column: 'rent_monthly_inr_min' },
  { key: 'rentMonthlyInrMax', column: 'rent_monthly_inr_max' },
  { key: 'areaSqftMin', column: 'area_sqft_min' },
  { key: 'areaSqftMax', column: 'area_sqft_max' },
  { key: 'areaBasis', column: 'area_basis' },
  { key: 'bhkMin', column: 'bhk_min' },
  { key: 'bhkMax', column: 'bhk_max' },
  { key: 'moveInFrom', column: 'move_in_from' },
  { key: 'moveInBy', column: 'move_in_by' },
  { key: 'moveInText', column: 'move_in_text', trim: true },
  { key: 'statedTags', column: 'stated_tags' },
  { key: 'decisionMaker', column: 'decision_maker', trim: true },
  { key: 'introducingBrokerPersonId', column: 'introducing_broker_person_id' },
  { key: 'sharedCommissionNote', column: 'shared_commission_note', trim: true },
  { key: 'sharedCommissionPct', column: 'shared_commission_pct' },
  { key: 'ownerUserId', column: 'owner_user_id' },
  { key: 'companyName', column: 'company_name', trim: true },
];

const STATED_TAGS: [string, string][] = [
  ['saleMode', 'sale_mode'],
  ['tenancyStatus', 'tenancy_status'],
  ['tenure', 'tenure'],
  ['agreementForm', 'agreement_form'],
  ['possessionStatus', 'possession_status'],
  ['furnishing', 'furnishing'],
];

/**
 * Maps the present API fields to columns, canonicalising vocabulary values (400 vocabulary-value-invalid).
 * Absent fields are left out; `null` clears. `prefix` names the body path in field errors.
 */
export function mapFields(
  input: Record<string, unknown>,
  specs: readonly FieldSpec[],
  vocab: VocabularyIndex | undefined,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const controlled = specs
    .filter((s) => s.vocab && input[s.key] !== undefined)
    .map((s) => ({ path: `${prefix}${s.key}`, field: s.vocab as string, value: input[s.key] as string | string[] | null }));
  const canonical = vocab ? vocab.validate(controlled) : new Map(controlled.map((c) => [c.path, c.value]));
  for (const s of specs) {
    const v = input[s.key];
    if (v === undefined) continue;
    if (s.vocab) out[s.column] = canonical.get(`${prefix}${s.key}`) ?? null;
    else if (s.trim && typeof v === 'string') out[s.column] = v.trim() === '' ? null : v.trim();
    else out[s.column] = v;
  }
  if (input['statedTags'] !== undefined && specs.some((s) => s.key === 'statedTags')) {
    const tags = (input['statedTags'] ?? {}) as Record<string, unknown>;
    const checked = vocab
      ? vocab.validate(
          STATED_TAGS.filter(([k]) => typeof tags[k] === 'string').map(([k, field]) => ({
            path: `${prefix}statedTags/${k}`,
            field,
            value: tags[k] as string,
          })),
        )
      : new Map<string, unknown>();
    const clean: Record<string, unknown> = {};
    for (const [k] of STATED_TAGS) {
      if (typeof tags[k] === 'string') clean[k] = checked.get(`${prefix}statedTags/${k}`) ?? tags[k];
    }
    if (typeof tags['isJodi'] === 'boolean') clean['isJodi'] = tags['isJodi'];
    out['stated_tags'] = clean;
  }
  return out;
}

/** Offers carry exactly one PROPERTY deal type; market only with Sale (R-11 market-on-non-sale). */
export function assertOfferDealType(dealType: unknown, market: unknown, path: string): void {
  if (!(PROPERTY_DEAL_TYPES as readonly unknown[]).includes(dealType)) {
    throw new RecordsError('vocabulary-value-invalid', undefined, {
      errors: [{ field: `${path}dealType`, code: 'not-a-property-deal-type' }],
    });
  }
  if (market !== null && market !== undefined && dealType !== 'Sale') {
    throw new RecordsError('vocabulary-value-invalid', undefined, {
      errors: [{ field: `${path}market`, code: 'market-on-non-sale' }],
    });
  }
}

/** Columns whose value differs (staff_edited_fields bookkeeping and change detection). */
export function changedColumns(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(patch[k] ?? null));
}

export function mergeEdited(existing: readonly string[], changed: readonly string[]): string[] {
  return [...new Set([...existing, ...changed])];
}
