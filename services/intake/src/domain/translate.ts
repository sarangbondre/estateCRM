// Mapping-mode legacy-term translation (D-15, LLD §4.7 step 3) against the pinned release's legacy_terms, plus the
// "2BHK Flat" pattern for property types. Canonical values pass through (R-11); pipe lists translate item by item;
// anything else is untranslatable (the caller blanks the field and flags value_not_translatable).
import { LEGACY_TERMS, LIST_SEPARATOR, canonicalValue, isMultiField, legacyKey } from '@11e/vocabulary';
import type { VocabularyField } from '@11e/vocabulary';

export interface LegacyTermEntry {
  field: string;
  termNorm: string;
  maps: Record<string, string>;
}

export type Translation =
  | { ok: true; maps: Record<string, string>; translated: boolean }
  | { ok: false; field: VocabularyField; value: string };

/** The bundled release's terms, used when the cache has none (release v0.6 ships them with @11e/vocabulary). */
export const BUNDLED_LEGACY_TERMS: readonly LegacyTermEntry[] = LEGACY_TERMS.map((t) => ({
  field: t.field,
  termNorm: legacyKey(t.term),
  maps: { ...t.maps },
}));

const BHK_TYPE = /^(\d(?:\.5)?)\s*bhk\b\s*(.*)$/i;
const TYPE_SYNONYMS: Readonly<Record<string, string>> = {
  flat: 'Apartment',
  flats: 'Apartment',
  apartment: 'Apartment',
  apartments: 'Apartment',
  '': 'Apartment',
  'independent house': 'Bungalow',
  house: 'Bungalow',
  godown: 'Warehouse',
  'office space': 'Office',
  'commercial office': 'Office',
};

export class LegacyTable {
  readonly #index = new Map<string, Record<string, string>>();

  constructor(entries: readonly LegacyTermEntry[]) {
    for (const e of entries) this.#index.set(`${e.field}\u0000${e.termNorm}`, e.maps);
  }

  #lookup(field: VocabularyField, raw: string): Record<string, string> | undefined {
    const key = legacyKey(raw);
    return this.#index.get(`${field}\u0000${key}`) ?? this.#index.get(`*\u0000${key}`);
  }

  #item(field: VocabularyField, raw: string): { maps: Record<string, string>; translated: boolean } | null {
    if (raw.trim() === '') return { maps: {}, translated: false };
    const canonical = canonicalValue(field, raw);
    if (canonical !== undefined) return { maps: { [field]: canonical }, translated: false };
    const legacy = this.#lookup(field, raw);
    if (legacy) return { maps: { ...legacy }, translated: true };
    if (field === 'property_type') {
      const m = BHK_TYPE.exec(raw.trim());
      if (m) {
        const rest = (m[2] ?? '').trim().toLowerCase();
        const type = canonicalValue('property_type', rest) ?? TYPE_SYNONYMS[rest];
        if (type)
          return {
            maps: { property_type: type, bhk_min: m[1] as string, bhk_max: m[1] as string },
            translated: true,
          };
      }
      const t = TYPE_SYNONYMS[raw.trim().toLowerCase()];
      if (t) return { maps: { property_type: t }, translated: true };
    }
    return null;
  }

  translate(field: VocabularyField, raw: string | null | undefined): Translation {
    if (raw === null || raw === undefined) return { ok: true, maps: {}, translated: false };
    const whole = this.#item(field, raw);
    if (whole) return { ok: true, ...whole };
    if (!isMultiField(field) || !raw.includes(LIST_SEPARATOR)) return { ok: false, field, value: raw.trim() };
    const out: Record<string, string> = {};
    const list: string[] = [];
    let translated = false;
    for (const part of raw.split(LIST_SEPARATOR)) {
      const r: { maps: Record<string, string>; translated: boolean } | null =
        part.trim() === '' ? null : this.#item(field, part);
      if (!r) return { ok: false, field, value: part.trim() };
      translated ||= r.translated;
      for (const [k, v] of Object.entries(r.maps) as [string, string][]) {
        if (k === field) {
          for (const item of v.split(LIST_SEPARATOR)) if (!list.includes(item)) list.push(item);
        } else if (out[k] === undefined) out[k] = v;
        else if (out[k] !== v) return { ok: false, field, value: raw.trim() };
      }
    }
    if (list.length) out[field] = list.join(LIST_SEPARATOR);
    return { ok: true, maps: out, translated };
  }
}
