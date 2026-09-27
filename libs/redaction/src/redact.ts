import { detectEmails, detectIds, detectUrls } from './detectors/contact.js';
import { detectNames } from './detectors/name.js';
import { detectPhones } from './detectors/phone.js';
import { execAll, type Span } from './detectors/span.js';
import { detectUnits } from './detectors/unit.js';
import { digitsOf, shadow } from './normalize.js';
import { hasResidualRisk } from './residual.js';
import {
  PII_KINDS,
  type Detection,
  type PiiKind,
  type PlaceholderStyle,
  type RedactOptions,
  type RedactionResult,
} from './types.js';

/** When spans of different kinds overlap, the merged span takes the highest-priority kind. */
const PRIORITY: Readonly<Record<PiiKind, number>> = { EMAIL: 6, URL: 5, PHONE: 4, ID: 3, UNIT: 2, NAME: 1 };

/** Existing placeholders in either style, so a second pass neither re-masks nor re-uses their numbers. */
const PLACEHOLDER = /[[⟨](PHONE|EMAIL|URL|NAME|UNIT|ID)_(\d+)[\]⟩]/gu;

function placeholderFor(kind: PiiKind, n: number, style: PlaceholderStyle): string {
  return style === 'angle' ? `⟨${kind}_${n}⟩` : `[${kind}_${n}]`;
}

function lowerWords(terms: Iterable<string> | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (terms === undefined) return out;
  for (const t of terms) {
    for (const w of t.split(/\s+/u)) if (w.length > 0) out.add(w.toLowerCase());
  }
  return out;
}

/**
 * Sorts, then unions overlapping spans. The merged span takes the kind of the longer input (an Aadhaar number beats
 * the phone-shaped part inside it); on equal length, the higher priority wins.
 */
function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  const lengthOf = new Map<Span, number>();
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start < last.end) {
      const lastLen = lengthOf.get(last) ?? last.end - last.start;
      const sLen = s.end - s.start;
      const sWins = sLen > lastLen || (sLen === lastLen && PRIORITY[s.kind] > PRIORITY[last.kind]);
      const kind = sWins ? s.kind : last.kind;
      const merged = { kind, start: last.start, end: Math.max(last.end, s.end) };
      lengthOf.set(merged, Math.max(lastLen, sLen));
      out[out.length - 1] = merged;
    } else {
      out.push(s);
    }
  }
  return out;
}

/** Normalised key so the same value gets the same placeholder within one text. */
function keyOf(kind: PiiKind, value: string): string {
  if (kind === 'PHONE') {
    const d = digitsOf(shadow(value));
    return `${kind}:${d.length >= 10 ? d.slice(-10) : d}`;
  }
  return `${kind}:${value.toLowerCase().replace(/\s+/gu, ' ')}`;
}

/**
 * Finds personal data in `text`. Offsets refer to `text`. Values are PII: never log them.
 */
export function detect(text: string, options: Pick<RedactOptions, 'kinds' | 'allowTerms'> = {}): Detection[] {
  const kinds = new Set<PiiKind>(options.kinds ?? PII_KINDS);
  const s = shadow(text);
  const emails = detectEmails(s);
  const urls = detectUrls(s);
  const phones = detectPhones(s);
  const existing: Span[] = [];
  for (const m of execAll(PLACEHOLDER, s)) {
    const kind = m[1] as PiiKind;
    if (kind === 'PHONE' || kind === 'EMAIL')
      existing.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  const anchors = [...phones, ...emails, ...existing];
  const all: Span[] = [
    ...emails,
    ...urls,
    ...phones,
    ...detectIds(s),
    ...detectUnits(s),
    ...detectNames(s, anchors, lowerWords(options.allowTerms)),
  ];
  // Never mask inside an existing placeholder.
  const placeholders = [...execAll(PLACEHOLDER, s)].map((m) => [m.index, m.index + m[0].length] as const);
  const kept = all.filter(
    (sp) => kinds.has(sp.kind) && !placeholders.some(([a, b]) => sp.start < b && sp.end > a),
  );
  return merge(kept).map((sp) => ({ ...sp, value: text.slice(sp.start, sp.end) }));
}

/**
 * Replaces personal data with numbered placeholders (`[PHONE_1]`, `[NAME_1]`, …). Pure and synchronous.
 * The returned `mapping` holds the originals: keep it in request memory only.
 */
export function redact(text: string, options: RedactOptions = {}): RedactionResult {
  const style = options.placeholderStyle ?? 'square';
  const detections = detect(text, options);
  const counts: Record<PiiKind, number> = { PHONE: 0, EMAIL: 0, URL: 0, NAME: 0, UNIT: 0, ID: 0 };
  const next: Record<PiiKind, number> = { PHONE: 1, EMAIL: 1, URL: 1, NAME: 1, UNIT: 1, ID: 1 };
  for (const m of execAll(PLACEHOLDER, text)) {
    const kind = m[1] as PiiKind;
    next[kind] = Math.max(next[kind], Number(m[2]) + 1);
  }
  const byKey = new Map<string, string>();
  const mapping = new Map<string, string>();
  let out = '';
  let cursor = 0;
  for (const d of detections) {
    const key = keyOf(d.kind, d.value);
    let placeholder = byKey.get(key);
    if (placeholder === undefined) {
      placeholder = placeholderFor(d.kind, next[d.kind], style);
      next[d.kind] += 1;
      byKey.set(key, placeholder);
      mapping.set(placeholder, d.value);
    }
    counts[d.kind] += 1;
    out += text.slice(cursor, d.start) + (options.replacer ? options.replacer(d, placeholder) : placeholder);
    cursor = d.end;
  }
  out += text.slice(cursor);
  return { text: out, counts, mapping, uncertain: hasResidualRisk(out) };
}

/**
 * Puts the originals back into text produced from a redacted input (e.g. action-card payloads streamed to the same
 * user, insight LLD §4.1). Unknown placeholders are left as they are.
 */
export function restore(text: string, mapping: ReadonlyMap<string, string>): string {
  return text.replace(PLACEHOLDER, (ph) => mapping.get(ph) ?? ph);
}

/** True when the text holds a phone number or e-mail (web audit scrub, LLD web §4.6). */
export function containsContact(text: string): boolean {
  const s = shadow(text);
  return detectPhones(s).length > 0 || detectEmails(s).length > 0;
}
