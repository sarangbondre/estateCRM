// Legacy and everyday terms → stored values (LLD §4.3 rule 3, BRD §4.2 "absorbs"). Labels are never values: "For
// Rent" is not in this table, so it is rejected; "rent" is translated to deal_type Lease and listed in
// howIGotThis.translatedTerms. Pure.
import { matchKey, translateLegacyTerm } from '@11e/vocabulary';
import type { VocabularyField } from '@11e/vocabulary';

/** Chat terms beyond the upload legacy table (field context → maps). */
const CHAT_TERMS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  deal_type: {
    rent: { deal_type: 'Lease' },
    rental: { deal_type: 'Lease' },
    lease: { deal_type: 'Lease' },
    'leave and license': { deal_type: 'Lease' },
    'leave and licence': { deal_type: 'Lease' },
    resale: { deal_type: 'Sale', market: 'Secondary' },
    'new project': { deal_type: 'Sale', market: 'Primary' },
    'new projects': { deal_type: 'Sale', market: 'Primary' },
    sale: { deal_type: 'Sale' },
    buy: { deal_type: 'Sale' },
    purchase: { deal_type: 'Sale' },
  },
  property_type: {
    gala: { property_type: 'Gala', segment: 'Industrial' },
    galas: { property_type: 'Gala', segment: 'Industrial' },
    office: { property_type: 'Office', segment: 'Commercial' },
    offices: { property_type: 'Office', segment: 'Commercial' },
    shop: { property_type: 'Shop', segment: 'Commercial' },
    shops: { property_type: 'Shop', segment: 'Commercial' },
    warehouse: { property_type: 'Warehouse', segment: 'Industrial' },
    warehouses: { property_type: 'Warehouse', segment: 'Industrial' },
    flat: { property_type: 'Apartment', segment: 'Residential' },
    flats: { property_type: 'Apartment', segment: 'Residential' },
    apartment: { property_type: 'Apartment', segment: 'Residential' },
    apartments: { property_type: 'Apartment', segment: 'Residential' },
    '1 rk': { property_type: 'Studio', segment: 'Residential' },
    '1rk': { property_type: 'Studio', segment: 'Residential' },
  },
  market: { resale: { market: 'Secondary' }, 'new project': { market: 'Primary' } },
};

export interface Translation {
  /** Field → canonical value (the asked field plus any implied fields, e.g. market for "resale"). */
  maps: Record<string, string>;
  /** Present when a legacy / everyday term was used: "resale → deal_type Sale, market Secondary". */
  note?: string;
}

/**
 * Canonical value of `raw` for a vocabulary field, via the active release (R-11 match), then the chat and upload
 * legacy tables. `allowed` is the active release's value list for the field. Undefined when not translatable.
 */
export function translateTerm(field: string, raw: string, allowed: readonly string[]): Translation | undefined {
  const key = matchKey(raw);
  const direct = allowed.find((v) => matchKey(v) === key);
  if (direct !== undefined) return { maps: { [field]: direct } };
  const chat = CHAT_TERMS[field]?.[key];
  let maps: Record<string, string> | undefined = chat ? { ...chat } : undefined;
  if (!maps) {
    const legacy = translateLegacyTerm(field as VocabularyField, raw);
    if (legacy.ok && legacy.translated && legacy.maps[field]) maps = { ...legacy.maps };
  }
  if (!maps) return undefined;
  const value = maps[field];
  if (value === undefined || !allowed.includes(value)) return undefined;
  const note = `${raw.trim()} → ${Object.entries(maps)
    .map(([f, v]) => `${f} ${v}`)
    .join(', ')}`;
  return { maps, note };
}
