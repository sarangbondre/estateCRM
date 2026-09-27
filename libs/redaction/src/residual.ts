/**
 * Post-check before any model call (intake LLD §4.8): text that still holds a run of ≥ 7 digits (ASCII, Devanagari
 * or fullwidth) or an `@` must not be sent. Deliberately blunt: it also trips on RERA ids and unformatted prices,
 * which then go to review instead of the model. That is the privacy-safe direction.
 */
const DIGIT_RUN = /[0-9०-९０-９]{7,}/u;
const AT = /[@＠]/u;

export function hasResidualRisk(text: string): boolean {
  return DIGIT_RUN.test(text) || AT.test(text);
}
