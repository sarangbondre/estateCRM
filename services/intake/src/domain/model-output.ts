// ModelOutputValidator (LLD §4.8): the model's answer is validated against the vocabulary; invalid values are dropped;
// a suggestion is merged into the row only for blank fields and only when the result passes the cross-field rules.
import { canonicalValue, validateClassification } from '@11e/vocabulary';
import type { Classification } from './rows.js';

export const LOW_CONFIDENCE = 0.7;

export interface ModelSuggestion {
  classification: Classification;
  confidence: number;
}

const one = (field: 'record_scope' | 'market' | 'segment' | 'side', v: unknown): string | null =>
  typeof v === 'string' ? (canonicalValue(field, v) ?? null) : null;

const many = (field: 'deal_type' | 'property_type', v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map((x) => (typeof x === 'string' ? canonicalValue(field, x) : undefined))
            .filter((x): x is NonNullable<typeof x> => !!x),
        ),
      ]
    : [];

export function validateModelOutput(out: Record<string, unknown>): ModelSuggestion {
  const c = typeof out['confidence'] === 'number' ? out['confidence'] : Number(out['confidence']);
  return {
    classification: {
      recordScope: one('record_scope', out['recordScope']) as Classification['recordScope'],
      dealTypes: many('deal_type', out['dealTypes']),
      market: one('market', out['market']),
      segment: one('segment', out['segment']),
      propertyTypes: many('property_type', out['propertyTypes']),
      landUse: null,
      side: one('side', out['side']) as Classification['side'],
    },
    confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0,
  };
}

/** Fills the blanks of `current` from `suggestion`; undefined when the merge breaks the cross-field rules. */
export function mergeSuggestion(current: Classification, s: Classification): Classification | undefined {
  const merged: Classification = {
    recordScope: current.recordScope ?? s.recordScope,
    dealTypes: current.dealTypes.length ? current.dealTypes : s.dealTypes,
    market: current.market ?? s.market,
    segment: current.segment ?? s.segment,
    propertyTypes: current.propertyTypes.length ? current.propertyTypes : s.propertyTypes,
    landUse: current.landUse,
    side: current.side ?? s.side,
  };
  const r = validateClassification({
    recordScope: merged.recordScope,
    dealType: merged.dealTypes.join('|') || null,
    market: merged.market,
    segment: merged.segment,
    propertyType: merged.propertyTypes.join('|') || null,
    landUse: merged.landUse,
    side: merged.side,
  });
  return r.ok ? merged : undefined;
}
