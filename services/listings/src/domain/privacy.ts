// Blocking privacy scan (LLD §4.4, rules ps-1). Pure: callers supply the matched private-term hashes.
// Findings carry kinds and offsets only; the matched text is never returned, stored or logged.
import { detect } from '@11e/redaction';

export const RULES_VERSION = 'ps-1';

export type FindingKind =
  | 'phone'
  | 'email'
  | 'url'
  | 'social_handle'
  | 'building_name'
  | 'society_name'
  | 'wing_unit'
  | 'exact_floor'
  | 'street_address'
  | 'photo_text';

export interface Finding {
  kind: FindingKind;
  severity: 'block' | 'warn';
  field: 'description' | 'photo';
  start?: number;
  end?: number;
  photoId?: string;
}

export type ScanOutcome = 'pass' | 'warning' | 'blocked';

export const outcomeOf = (findings: readonly Finding[]): ScanOutcome =>
  findings.some((f) => f.severity === 'block') ? 'blocked' : findings.length ? 'warning' : 'pass';

// ---- normalisation: number words → digits, with a map back to original offsets ------------------------------------

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  do: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  shunya: '0',
  shoonya: '0',
  ek: '1',
  teen: '3',
  char: '4',
  chaar: '4',
  paanch: '5',
  panch: '5',
  chhe: '6',
  che: '6',
  chheh: '6',
  saat: '7',
  aath: '8',
  aat: '8',
  nau: '9',
  nou: '9',
};
const MULTIPLIERS: Record<string, number> = { double: 2, triple: 3 };

interface Normalised {
  text: string;
  /** For each character of `text`, the original [start, end) it came from. */
  map: [number, number][];
}

/** NFKC-free lower-casing plus number words → digits ("nine eight double two" → "9 8 22"). Offsets preserved. */
export function normaliseForDigits(input: string): Normalised {
  const out: string[] = [];
  const map: [number, number][] = [];
  const re = /[a-z]+|[^a-z]/gi;
  let pendingMultiplier: { n: number; start: number } | null = null;
  for (const m of input.matchAll(re)) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    const lower = tok.toLowerCase();
    const mult = MULTIPLIERS[lower];
    if (mult !== undefined) {
      pendingMultiplier = { n: mult, start };
      continue;
    }
    const digit = NUMBER_WORDS[lower];
    if (digit !== undefined) {
      const n = pendingMultiplier?.n ?? 1;
      const from = pendingMultiplier?.start ?? start;
      for (let i = 0; i < n; i++) {
        out.push(digit);
        map.push([from, end]);
      }
      pendingMultiplier = null;
      continue;
    }
    if (pendingMultiplier && /^\s$/.test(tok)) continue;
    if (pendingMultiplier) {
      // "double" not followed by a number word: keep it as text.
      for (let i = pendingMultiplier.start; i < start; i++) {
        out.push((input[i] as string).toLowerCase());
        map.push([i, i + 1]);
      }
      pendingMultiplier = null;
    }
    // A single digit written as a word next to a digit ("9 8 two") joins the digit run via separators below.
    for (let i = 0; i < tok.length; i++) {
      out.push((tok[i] as string).toLowerCase());
      map.push([start + i, start + i + 1]);
    }
  }
  return { text: out.join(''), map };
}

const LOOKALIKE: Record<string, string> = { o: '0', l: '1', i: '1' };

/** Runs of ≥ 8 digits (after look-alikes and separators) that aren't a price, area, date or allowed identifier. */
function digitRunFindings(input: string, allowIds: ReadonlySet<string>): Finding[] {
  const n = normaliseForDigits(input);
  const findings: Finding[] = [];
  const run = /[\doli](?:[\s.\-/()]*[\doli])+/g;
  for (const m of n.text.matchAll(run)) {
    // Look-alike letters count only inside a run: trim them (and separators) at both ends.
    const lead = /^[^\d]*/.exec(m[0])?.[0].length ?? 0;
    const raw = m[0].slice(lead).replace(/[^\d]+$/, '');
    const at = m.index + lead;
    if (!raw) continue;
    const mapped = raw.replace(/[oli]/g, (c) => LOOKALIKE[c] ?? c);
    const digits = mapped.replace(/\D/g, '');
    const realDigits = raw.replace(/\D/g, '').length;
    if (digits.length < 8 || realDigits < 6) continue;
    const start = n.map[at]?.[0] ?? 0;
    const end = n.map[at + raw.length - 1]?.[1] ?? input.length;
    const original = input.slice(start, end);
    if (isExemptNumber(input, start, end, original, allowIds)) continue;
    findings.push({ kind: 'phone', severity: 'block', field: 'description', start, end });
  }
  return findings;
}

function isExemptNumber(
  input: string,
  start: number,
  end: number,
  original: string,
  allowIds: ReadonlySet<string>,
): boolean {
  const before = input.slice(Math.max(0, start - 8), start).toLowerCase();
  const tokenStart = /[A-Za-z]$/.test(input.slice(0, start)) ? start - 1 : start;
  const token = input.slice(tokenStart, end).toUpperCase();
  if (allowIds.has(token) || allowIds.has(original.toUpperCase())) return true;
  const after = input.slice(end, end + 8).toLowerCase();
  // Dates and year ranges: 2027-06-01, 01/06/2027, 2025-2027.
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(original) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(original))
    return true;
  if (/^(19|20)\d{2}\s*[-–/]\s*(19|20)\d{2}$/.test(original)) return true;
  // Prices and areas: "Rs 12500000/-", "₹ 45000-55000", "2000-2500 sq ft".
  if (/(₹|rs\.?|inr)\s*$/.test(before)) return true;
  if (/^\s*(\/-|sq|sft|cr|crore|lakh|lac|l\b)/.test(after)) return true;
  return false;
}

// ---- pattern rules --------------------------------------------------------------------------------------------------

const PATTERN_RULES: { kind: FindingKind; re: RegExp }[] = [
  { kind: 'social_handle', re: /(?<![\w.@])@[a-z0-9_.]{3,}/gi },
  {
    kind: 'social_handle',
    re: /\b(?:insta(?:gram)?|whats\s?app\s+me|dm\s+me|telegram|snapchat|twitter|facebook|fb)\b\s*[:-]?\s*@?[a-z0-9_.]{3,}/gi,
  },
  {
    kind: 'wing_unit',
    re: /\b(?:wing|flat|unit|shop|office|gala|apt|door|room|block)\s*(?:no\.?|number|#)?\s*[a-z]?-?\d{1,4}[a-z]?\b(?!\s*(?:sq|sft|square|,\d))/gi,
  },
  { kind: 'wing_unit', re: /\b[a-z]-?\d{3,4}\b/gi },
  { kind: 'wing_unit', re: /\b\d{3,4}\s*[a-z]\b(?!\s+[a-z]{2,})/gi },
  { kind: 'wing_unit', re: /\b[a-z]\s*-?\s*wing\b/gi },
  { kind: 'exact_floor', re: /\b\d{1,2}\s*(?:st|nd|rd|th)\s*floor\b/gi },
  { kind: 'exact_floor', re: /\bfloor\s*(?:no\.?|number|#)?\s*\d{1,2}\b/gi },
  { kind: 'street_address', re: /\b(?:plot|survey|s\.?\s?no|cts|gat)\s*(?:no\.?|number|#)?\s*\d+/gi },
  {
    kind: 'street_address',
    re: /\b\d{1,4}[a-z]{0,2}\s*,?\s+(?:[a-z]+\s+){0,2}(?:road|rd|marg|lane|street|galli|gully|path)\b/gi,
  },
];

const KIND_OF_DETECTION: Record<string, FindingKind> = {
  PHONE: 'phone',
  EMAIL: 'email',
  URL: 'url',
  ID: 'phone',
};

function patternFindings(text: string, allowIds: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  for (const d of detect(text, { kinds: ['PHONE', 'EMAIL', 'URL', 'ID', 'UNIT'] })) {
    if ((d.kind === 'PHONE' || d.kind === 'ID') && isExemptNumber(text, d.start, d.end, d.value, allowIds))
      continue;
    const kind =
      d.kind === 'UNIT'
        ? /^(?:plot|survey|s\.?\s?no|cts|gat)\b/i.test(d.value)
          ? 'street_address'
          : 'wing_unit'
        : KIND_OF_DETECTION[d.kind];
    if (kind) out.push({ kind, severity: 'block', field: 'description', start: d.start, end: d.end });
  }
  for (const rule of PATTERN_RULES) {
    for (const m of text.matchAll(rule.re)) {
      out.push({
        kind: rule.kind,
        severity: 'block',
        field: 'description',
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return out;
}

// ---- private terms (R-20): n-grams hashed with the salt shared with records ---------------------------------------

/** Words that describe the kind of building rather than naming it (same list as records' scan-term builder). */
const BUILDING_STOP_WORDS = new Set([
  'chs',
  'chsl',
  'co',
  'op',
  'coop',
  'cooperative',
  'housing',
  'society',
  'soc',
  'ltd',
  'limited',
  'building',
  'bldg',
  'tower',
  'towers',
  'apartment',
  'apartments',
  'apts',
  'apt',
  'residency',
  'the',
]);

interface Token {
  text: string;
  start: number;
  end: number;
}

/** records' `norm`: NFKD, diacritics dropped, lower case, anything not a letter/number is a separator. */
function tokens(input: string): Token[] {
  const out: Token[] = [];
  for (const m of input.matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0].normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (t) out.push({ text: t, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export interface Gram {
  /** The token string records would hash ("sea breeze" or "seabreeze"). */
  key: string;
  words: number;
  start: number;
  end: number;
}

/** 1–4-token n-grams of the text after building-kind words are dropped, in both spaced and joined forms. */
export function candidateGrams(text: string): Gram[] {
  const toks = tokens(text).filter((t) => !BUILDING_STOP_WORDS.has(t.text));
  const grams: Gram[] = [];
  for (let i = 0; i < toks.length; i++) {
    for (let n = 1; n <= 4 && i + n <= toks.length; n++) {
      const slice = toks.slice(i, i + n);
      const start = (slice[0] as Token).start;
      const end = (slice[n - 1] as Token).end;
      const spaced = slice.map((t) => t.text).join(' ');
      grams.push({ key: spaced, words: n, start, end });
      if (n > 1) grams.push({ key: slice.map((t) => t.text).join(''), words: n, start, end });
    }
  }
  return grams;
}

export type TermKind = 'building' | 'society' | 'wing' | 'unit';

/**
 * Findings for n-grams whose hash matched a private term. Single tokens of a building/society name count only if they
 * have ≥ 6 characters and aren't on the allow-list (localities, micromarkets, amenities, vocabulary words, the
 * project's own public name). Wing/unit single tokens count when they contain a digit and have ≥ 3 characters.
 */
export function termFindings(
  grams: readonly Gram[],
  matched: ReadonlyMap<string, TermKind>,
  hashOf: (key: string) => string,
  allowList: ReadonlySet<string>,
): Finding[] {
  const out: Finding[] = [];
  for (const g of grams) {
    const kind = matched.get(hashOf(g.key));
    if (!kind) continue;
    if (allowList.has(g.key)) continue;
    if (kind === 'building' || kind === 'society') {
      if (g.words === 1 && g.key.length < 6) continue;
      out.push({
        kind: kind === 'building' ? 'building_name' : 'society_name',
        severity: 'block',
        field: 'description',
        start: g.start,
        end: g.end,
      });
    } else {
      if (g.words === 1 && (g.key.length < 3 || !/\d/.test(g.key))) continue;
      out.push({ kind: 'wing_unit', severity: 'block', field: 'description', start: g.start, end: g.end });
    }
  }
  return out;
}

/** Normalised allow-list entries (whole phrases and their words) for termFindings. */
export function allowListOf(values: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const words = tokens(v)
      .map((t) => t.text)
      .filter((w) => !BUILDING_STOP_WORDS.has(w));
    if (!words.length) continue;
    words.forEach((w) => out.add(w));
    out.add(words.join(' '));
    out.add(words.join(''));
  }
  return out;
}

// ---- the scan -------------------------------------------------------------------------------------------------------

export interface ScanInput {
  text: string;
  /** Exact identifiers that may appear (the agent and project RERA numbers). */
  allowIds?: ReadonlySet<string>;
  /** Private-term findings computed by the caller (termFindings). */
  termFindings?: readonly Finding[];
  /** Selected photos with detected text: warning only (R-8). */
  photoTextIds?: readonly string[];
}

/** All findings for a text, de-duplicated by (kind, start, end) and sorted by position. */
export function scanText(input: ScanInput): Finding[] {
  const findings = [
    ...patternFindings(input.text, input.allowIds ?? new Set()),
    ...digitRunFindings(input.text, input.allowIds ?? new Set()),
    ...(input.termFindings ?? []),
  ];
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const k = `${f.kind}:${f.start}:${f.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0));
  for (const photoId of input.photoTextIds ?? [])
    unique.push({ kind: 'photo_text', severity: 'warn', field: 'photo', photoId });
  return unique;
}
