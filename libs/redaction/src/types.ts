/** Kinds of personal data the redactor masks. */
export type PiiKind = 'PHONE' | 'EMAIL' | 'URL' | 'NAME' | 'UNIT' | 'ID';

export const PII_KINDS: readonly PiiKind[] = ['PHONE', 'EMAIL', 'URL', 'NAME', 'UNIT', 'ID'];

/** One detected span in the input text (UTF-16 offsets, end exclusive). */
export interface Detection {
  readonly kind: PiiKind;
  readonly start: number;
  readonly end: number;
  /** The original characters of the span. PII: never log it. */
  readonly value: string;
}

/**
 * `square` → `[PHONE_1]` (intake LLD §4.8, default).
 * `angle` → `⟨PHONE_1⟩` (insight LLD §4.1).
 */
export type PlaceholderStyle = 'square' | 'angle';

export interface RedactOptions {
  /** Kinds to mask. Default: all. */
  readonly kinds?: readonly PiiKind[];
  /** Placeholder style. Default `square`. */
  readonly placeholderStyle?: PlaceholderStyle;
  /**
   * Extra terms (localities, micromarkets, vocabulary values, building names) that are never masked as NAME.
   * Matched case-insensitively per word.
   */
  readonly allowTerms?: Iterable<string>;
  /**
   * Custom replacement (e.g. intake's consistent fakes, LLD intake §4.9). Receives the detection and the placeholder
   * the redactor would have used. When given, the returned string is inserted instead of the placeholder.
   */
  readonly replacer?: (detection: Detection, placeholder: string) => string;
}

export interface RedactionResult {
  /** The redacted text. */
  readonly text: string;
  /** Number of masked spans per kind (counts only, safe to store: insight `redaction_counts`). */
  readonly counts: Readonly<Record<PiiKind, number>>;
  /**
   * Placeholder → original value. **Request memory only**: never store, log or send it anywhere (insight LLD §4.1).
   * A `Map` serialises to `{}` with JSON.stringify, which keeps accidental logging harmless.
   */
  readonly mapping: ReadonlyMap<string, string>;
  /**
   * True when the output still fails the residual post-check (a run of ≥ 7 digits or an `@`), intake LLD §4.8.
   * Callers must not send such text to the model (intake: needs_review `redaction_uncertain`).
   */
  readonly uncertain: boolean;
}
