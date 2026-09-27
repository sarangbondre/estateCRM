/**
 * Legacy-term translation for mapping mode (PRD D-15, intake LLD §4.7): BRD §4.2 "Absorbs these older
 * terms", BRD §16 "Legacy terms", glossary and PRD D-17. Strict mode never translates.
 */
import { LIST_SEPARATOR, matchKey } from './normalise.js';
import { canonicalValue, isMultiField } from './validate.js';
import type { VocabularyField } from './release-v0.6.js';

/** Contract shape (records.yaml `VocabularyRelease.legacyTerms`). Empty `maps` = the term means blank. */
export interface LegacyTerm {
  readonly term: string;
  /** Field context the term is found in; `*` = any controlled field. */
  readonly field: VocabularyField | '*';
  /** Target field → canonical value (pipe list for deal_type). */
  readonly maps: Readonly<Record<string, string>>;
}

const sale = { deal_type: 'Sale' } as const;
const lease = { deal_type: 'Lease' } as const;
const jv = { deal_type: 'JV' } as const;
const pagdi = { deal_type: 'Pagdi' } as const;
const buy = { deal_type: 'Sale', side: 'Demand' } as const;
const saleAndLease = { deal_type: 'Sale|Lease' } as const;
const preleased = { deal_type: 'Sale', tenancy_status: 'Tenanted' } as const;
const oneRk = { property_type: 'Studio', bhk_min: '0.5', bhk_max: '0.5' } as const;

export const LEGACY_TERMS: readonly LegacyTerm[] = [
  // Sale absorbs: Sale, Sell, Resale, Buy, Purchase, Acquisition, Outright (BRD §4.2, §16).
  { term: 'Sell', field: 'deal_type', maps: sale },
  { term: 'Outright', field: 'deal_type', maps: sale },
  { term: 'Resale', field: 'deal_type', maps: { deal_type: 'Sale', market: 'Secondary' } },
  { term: 'New project', field: 'deal_type', maps: { deal_type: 'Sale', market: 'Primary' } },
  { term: 'Buy', field: 'deal_type', maps: buy },
  { term: 'Purchase', field: 'deal_type', maps: buy },
  { term: 'Acquisition', field: 'deal_type', maps: buy },
  // Lease absorbs: Rent, Lease, Lease Out, Rent Out, Leave and License, lease transfer of premises.
  { term: 'Rent', field: 'deal_type', maps: lease },
  { term: 'Lease / Rent', field: 'deal_type', maps: lease },
  { term: 'Lease Out', field: 'deal_type', maps: lease },
  { term: 'Rent Out', field: 'deal_type', maps: lease },
  {
    term: 'Leave and License',
    field: 'deal_type',
    maps: { deal_type: 'Lease', agreement_form: 'Leave and License' },
  },
  { term: 'lease transfer of premises', field: 'deal_type', maps: lease },
  // JV absorbs: JV, JD, Joint Venture, Joint Development, Redevelopment, Development Rights.
  { term: 'JD', field: 'deal_type', maps: jv },
  { term: 'Joint Venture', field: 'deal_type', maps: jv },
  { term: 'Joint Development', field: 'deal_type', maps: jv },
  { term: 'Redevelopment', field: 'deal_type', maps: jv },
  { term: 'Development Rights', field: 'deal_type', maps: jv },
  // Pagdi absorbs: Pagdi, Pagadi, Pagri, tenancy transfer.
  { term: 'Pagadi', field: 'deal_type', maps: pagdi },
  { term: 'Pagri', field: 'deal_type', maps: pagdi },
  { term: 'tenancy transfer', field: 'deal_type', maps: pagdi },
  // BRD §16.
  { term: 'Sale/Lease', field: 'deal_type', maps: saleAndLease },
  { term: 'Sale/Rent', field: 'deal_type', maps: saleAndLease },
  { term: 'Pre-leased', field: 'deal_type', maps: preleased },
  { term: 'Preleased', field: 'deal_type', maps: preleased },
  { term: 'Auction', field: 'deal_type', maps: { sale_mode: 'Auction' } },
  { term: 'Builder', field: 'party_type', maps: { party_type: 'Developer' } },
  // PRD D-17: 1 RK is stored as Studio with bhk 0.5.
  { term: '1 RK', field: 'property_type', maps: oneRk },
  { term: '1RK', field: 'property_type', maps: oneRk },
  // "Unknown" as a value → blank.
  { term: 'Unknown', field: '*', maps: {} },
];

/** Legacy column / field names (BRD §16) → current field names, for mapping suggestions. */
export const LEGACY_FIELD_NAMES: readonly { readonly term: string; readonly fields: readonly string[] }[] = [
  { term: 'Transaction type', fields: ['deal_type'] },
  { term: 'Listing category', fields: ['segment', 'property_type'] },
  { term: 'Asset class', fields: ['segment', 'property_type'] },
  { term: 'Configuration', fields: ['property_type', 'bhk_min', 'bhk_max'] },
  { term: 'Broker or owner', fields: ['party_type'] },
];

/** Party role words no longer used (BRD §4.2 party fields, §16). */
export const LEGACY_ROLE_NAMES: Readonly<Record<string, string>> = {
  Lessor: 'Landlord',
  Lessee: 'Tenant',
};

/** Legacy lookup key: R-11 plus no spaces around "/" ("Lease / Rent" = "Lease/Rent"). */
export function legacyKey(raw: string): string {
  return matchKey(raw).replace(/\s*\/\s*/gu, '/');
}

const TERM_INDEX: ReadonlyMap<string, LegacyTerm> = new Map(
  LEGACY_TERMS.map((entry) => [`${entry.field}\u0000${legacyKey(entry.term)}`, entry]),
);

function lookupTerm(field: VocabularyField, raw: string): LegacyTerm | undefined {
  const key = legacyKey(raw);
  return TERM_INDEX.get(`${field}\u0000${key}`) ?? TERM_INDEX.get(`*\u0000${key}`);
}

export type TranslationResult =
  | {
      readonly ok: true;
      /** Field → canonical value; empty = blank (unknown). */
      readonly maps: Readonly<Record<string, string>>;
      /** True when at least one legacy term was used (false = already canonical or blank). */
      readonly translated: boolean;
    }
  | { readonly ok: false; readonly field: VocabularyField; readonly value: string };

type ItemResult = { maps: Readonly<Record<string, string>>; translated: boolean } | null;

function translateItem(field: VocabularyField, raw: string): ItemResult {
  if (raw.trim() === '') return { maps: {}, translated: false };
  const canonical = canonicalValue(field, raw);
  if (canonical !== undefined) return { maps: { [field]: canonical }, translated: false };
  const legacy = lookupTerm(field, raw);
  return legacy === undefined ? null : { maps: legacy.maps, translated: true };
}

/** Merges item maps; list fields are unioned, any other field must agree. Null on conflict. */
function merge(
  field: VocabularyField,
  parts: readonly Readonly<Record<string, string>>[],
): Record<string, string> | null {
  const out: Record<string, string> = {};
  const list: string[] = [];
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === field) {
        for (const item of value.split(LIST_SEPARATOR)) if (!list.includes(item)) list.push(item);
      } else if (out[key] === undefined) {
        out[key] = value;
      } else if (out[key] !== value) {
        return null;
      }
    }
  }
  if (list.length > 0) out[field] = list.join(LIST_SEPARATOR);
  return out;
}

/**
 * Mapping-mode translation of one raw value found in `field`. Canonical values pass through (R-11),
 * legacy terms are translated, and pipe lists are translated item by item. Anything else is
 * `ok: false` (the caller sets the field blank with needs_review `value_not_translatable`).
 */
export function translateLegacyTerm(
  field: VocabularyField,
  raw: string | null | undefined,
): TranslationResult {
  if (raw === null || raw === undefined) return { ok: true, maps: {}, translated: false };
  const whole = translateItem(field, raw);
  if (whole !== null) return { ok: true, ...whole };
  if (!isMultiField(field) || !raw.includes(LIST_SEPARATOR)) {
    return { ok: false, field, value: raw.trim() };
  }
  const items = raw.split(LIST_SEPARATOR).map((item) => ({ item, result: translateItem(field, item) }));
  const failed = items.find((entry) => entry.result === null || entry.item.trim() === '');
  if (failed !== undefined) return { ok: false, field, value: failed.item.trim() };
  const results = items.map((entry) => entry.result as NonNullable<ItemResult>);
  const maps = merge(
    field,
    results.map((result) => result.maps),
  );
  if (maps === null) return { ok: false, field, value: raw.trim() };
  return { ok: true, maps, translated: results.some((result) => result.translated) };
}

/** Legacy column name → current field names, or undefined. */
export function translateLegacyFieldName(header: string): readonly string[] | undefined {
  const key = matchKey(header);
  return LEGACY_FIELD_NAMES.find((entry) => matchKey(entry.term) === key)?.fields;
}
