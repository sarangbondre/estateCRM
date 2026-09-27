import { digitsOf } from '../normalize.js';
import type { Span } from './span.js';

/**
 * A run of digit groups: starts with an optional `+`, then a digit; groups are separated by up to 3 spaces, dashes,
 * dots or brackets. O/o inside the run count as zero ("98200 1234O"). Runs never start after another digit.
 */
const RUN = /(?<![0-9])(?:\+\s?)?[0-9](?:[0-9Oo]|[ \t\-.()]{1,3}(?=[0-9Oo]))*/gu;
const GROUP = /[0-9Oo]+/gu;

/** Currency or price cue right before a number: "Rs 25000000", "₹ 2500000", "INR 7500000", "@ 12000000". */
const MONEY_BEFORE = /(?:rs\.?|inr|₹|price|rate|cost|budget|value|amount|deposit|rent|@)\s*[:-]?\s*$/iu;
/** Unit or money cue right after a number: "2500-3000 sq ft", "25000000/-", "2345 6789 cr". */
const UNIT_AFTER =
  /^\s*(?:\/-|sq|sft|ft|feet|carpet|built|acre|acres|guntha|gunta|bigha|hect|cr\b|crore|lakh|lac|lacs|l\b|k\b|psf|per\b|bhk|rk\b|mtr|m2|yd|onwards|only|rs|inr|₹)/iu;
/** Contact cue close before a short (7-digit) number. */
const CUE_BEFORE =
  /(?:ph|phone|tel|telephone|mob|mobile|cell|call|contact|fax|landline|whatsapp|wa|sampark|संपर्क|फोन|मो)\s*[.:-]*\s*(?:no\.?|nos\.?|number)?\s*[.:-]*\s*$/iu;
const DATE = /^\d{1,2}\s?[.\-/]\s?\d{1,2}\s?[.\-/]\s?\d{2,4}$/u;
const YEAR_RANGE = /^(?:19|20)\d\d\s*[-–]\s*(?:(?:19|20)?\d\d)$/u;
const TIME_RANGE = /^\d{1,2}[.:]\d{2}\s*[-–]\s*\d{1,2}[.:]\d{2}$/u;
/** Alternate endings after a phone: "98200 12345/6789", "9820012345 / 46". */
const SUFFIX = /^\s*[/,]\s*([0-9Oo]{1,5})(?![0-9]|[ \t.-][0-9])/u;

interface Group {
  readonly start: number;
  readonly end: number;
  readonly digits: string;
}

function isMobileStart(d: string, at: number): boolean {
  const c = d.charAt(at);
  return c >= '6' && c <= '9';
}

/** Returns true when the digit string has the shape of an Indian phone number. */
function phoneShape(d: string, hasCue: boolean, strongOnly: boolean): boolean {
  const n = d.length;
  if (n === 10) return isMobileStart(d, 0) || !strongOnly;
  if (n === 11) return d.startsWith('0') || d.startsWith('1800') || d.startsWith('1860');
  if (n === 12) return d.startsWith('91') && isMobileStart(d, 2);
  if (n === 13) return d.startsWith('091') || d.startsWith('0091');
  if (n === 14) return d.startsWith('0091');
  if (n === 8) return !strongOnly && d.charAt(0) >= '2';
  if (n === 7) return !strongOnly && hasCue;
  return false;
}

/** Detects Indian phone numbers in the shadow text. */
export function detectPhones(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(RUN)) {
    const runStart = m.index;
    const run = m[0];
    const groups: Group[] = [];
    for (const g of run.matchAll(GROUP)) {
      const digits = digitsOf(g[0]);
      groups.push({ start: runStart + g.index, end: runStart + g.index + g[0].length, digits });
    }
    let i = 0;
    while (i < groups.length) {
      let acc = '';
      let best = -1;
      const first = groups[i];
      if (first === undefined) break;
      const before = text.slice(Math.max(0, first.start - 24), first.start);
      const hasCue = CUE_BEFORE.test(before);
      const moneyBefore = MONEY_BEFORE.test(before);
      for (let j = i; j < groups.length; j++) {
        const g = groups[j];
        if (g === undefined) break;
        acc += g.digits;
        if (acc.length > 14) break;
        const after = text.slice(g.end, g.end + 12);
        const strongOnly = moneyBefore || UNIT_AFTER.test(after) || isAdjacentHex(text, first.start, g.end);
        if (phoneShape(acc, hasCue, strongOnly) && !looksLikeNonPhone(text, groups, i, j, hasCue)) best = j;
      }
      const last = groups[best];
      if (best >= 0 && last !== undefined) {
        let start = first.start;
        if (i === 0 && run.startsWith('+')) start = runStart;
        if (text.charAt(start - 1) === '(') start -= 1;
        let end = last.end;
        if (text.charAt(end) === ')' && text.slice(start, end).includes('(')) end += 1;
        end = extendSuffixes(text, end);
        spans.push({ kind: 'PHONE', start, end });
        i = best + 1;
      } else {
        i += 1;
      }
    }
  }
  return spans;
}

function isAdjacentHex(text: string, start: number, end: number): boolean {
  return /[a-fA-F]/u.test(text.charAt(start - 1)) || /[a-fA-F]/u.test(text.charAt(end));
}

/** Dates, year/time ranges and round-number ranges ("2500-3000") are not phones. */
function looksLikeNonPhone(
  text: string,
  groups: readonly Group[],
  i: number,
  j: number,
  hasCue: boolean,
): boolean {
  const a = groups[i];
  const b = groups[j];
  if (a === undefined || b === undefined) return true;
  const s = text.slice(a.start, b.end);
  if (DATE.test(s) || YEAR_RANGE.test(s) || TIME_RANGE.test(s)) return true;
  if (!hasCue && j === i + 1 && a.digits.length <= 5 && b.digits.length <= 5) {
    // "2500-3000", "70000 - 80000": an ascending range of round numbers is an area or price, not a phone.
    const sep = text.slice(a.end, b.start);
    const ascending = !b.digits.startsWith('0') && Number(b.digits) > Number(a.digits);
    if (/[-–]/u.test(sep) && ascending && a.digits.endsWith('0') && b.digits.endsWith('0')) return true;
  }
  return false;
}

function extendSuffixes(text: string, end: number): number {
  let e = end;
  for (;;) {
    const rest = text.slice(e, e + 16);
    const m = SUFFIX.exec(rest);
    if (m === null) return e;
    const next = e + m[0].length;
    if (UNIT_AFTER.test(text.slice(next, next + 12))) return e;
    // A following "." + digit would be a decimal ("/ 2.5 Cr"): stop.
    if (/^[.,]\d/u.test(text.slice(next, next + 2))) return e;
    e = next;
  }
}
