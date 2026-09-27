// Review reason codes (US-07a AC5, CR-006 Z-6, LLD §4.8): extractor review_reason text → codes, intake-side causes →
// catalogue codes, and the primary code (the one in rows.classified.v1 and on the review item).
export const REASON_CODES = [
  'side_unclear',
  'deal_type_missing',
  'property_type_missing',
  'value_not_translatable',
  'low_confidence',
  'model_unavailable',
  'side_defaulted',
  'other',
] as const;
/** Priority order = array order (LLD §4.8). */
export type ReasonCode = (typeof REASON_CODES)[number];

export type DetailCode =
  | 'extractor_flag'
  | 'value_not_translatable'
  | 'model_unavailable'
  | 'low_confidence'
  | 'redaction_uncertain'
  | 'side_missing'
  | 'scope_unclear';

export interface Reason {
  code: ReasonCode;
  detail: DetailCode;
}

/** Extractor `review_reason` (";"-joined free text) → codes, each with detail `extractor_flag`. */
export function extractorReasons(text: string | null | undefined): Reason[] {
  if (!text) return [];
  const out: Reason[] = [];
  for (const part of text.split(';')) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    let code: ReasonCode = 'other';
    if (p.includes('side defaulted')) code = 'side_defaulted';
    else if (/deal type (not stated|missing)/.test(p)) code = 'deal_type_missing';
    else if (p.includes('side unclear')) code = 'side_unclear';
    else if (/property type (not stated|missing)/.test(p)) code = 'property_type_missing';
    out.push({ code, detail: 'extractor_flag' });
  }
  return out;
}

/** Intake-side cause → catalogue code (LLD §4.8). */
export function intakeReason(detail: DetailCode): Reason {
  switch (detail) {
    case 'side_missing':
      return { code: 'side_unclear', detail };
    case 'value_not_translatable':
      return { code: 'value_not_translatable', detail };
    case 'model_unavailable':
      return { code: 'model_unavailable', detail };
    case 'low_confidence':
      return { code: 'low_confidence', detail };
    default:
      return { code: 'other', detail };
  }
}

/** The reason with the highest-priority code (first by LLD §4.8 order); undefined when there is none. */
export function primaryReason(reasons: readonly Reason[]): Reason | undefined {
  let best: Reason | undefined;
  for (const r of reasons) {
    if (!best || REASON_CODES.indexOf(r.code) < REASON_CODES.indexOf(best.code)) best = r;
  }
  return best;
}

export const uniqueCodes = (reasons: readonly Reason[]): ReasonCode[] => [
  ...new Set(reasons.map((r) => r.code)),
];
