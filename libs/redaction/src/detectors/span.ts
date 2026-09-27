import type { PiiKind } from '../types.js';

/** A detector hit before values are attached (offsets into the text, end exclusive). */
export interface Span {
  readonly kind: PiiKind;
  readonly start: number;
  readonly end: number;
}

/**
 * All matches of a global regex, without `String.prototype.matchAll` (which clones the regex on every call; with
 * large patterns a clone can mean a recompile when V8 has flushed the compiled code).
 */
export function execAll(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  re.lastIndex = 0;
  return out;
}

/**
 * Runs a global regex and turns each match into a span. When the regex has the `d` flag and a named group `v`,
 * only that group is the span (context words around it stay).
 */
export function spansOf(text: string, re: RegExp, kind: PiiKind): Span[] {
  const out: Span[] = [];
  for (const m of execAll(re, text)) {
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
