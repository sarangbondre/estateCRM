import type { PiiKind } from '../types.js';

/** A detector hit before values are attached (offsets into the text, end exclusive). */
export interface Span {
  readonly kind: PiiKind;
  readonly start: number;
  readonly end: number;
}

/**
 * Runs a global regex and turns each match into a span. When the regex has the `d` flag and a named group `v`,
 * only that group is the span (context words around it stay).
 */
export function spansOf(text: string, re: RegExp, kind: PiiKind): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    const v = m.indices?.groups?.['v'];
    if (v !== undefined) {
      out.push({ kind, start: v[0], end: v[1] });
    } else if (m.groups !== undefined && 'v' in m.groups) {
      // Optional group `v` did not participate: nothing to mask.
      continue;
    } else {
      out.push({ kind, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}
