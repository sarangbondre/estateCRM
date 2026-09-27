import { NON_NAME_WORDS, NON_PERSON_SUFFIXES } from '../lexicon.js';
import { ciAlt } from './regex-util.js';
import type { Span } from './span.js';

/**
 * Person names are only masked **next to a contact cue**: an honorific, a contact phrase, a phone/e-mail, or a
 * "-bhai/-ji/-saheb" suffix. A bare capitalised word elsewhere is kept (localities, buildings, developers).
 */

const HONORIFICS = [
  'mr',
  'mrs',
  'ms',
  'miss',
  'mister',
  'dr',
  'shri',
  'shree',
  'sri',
  'smt',
  'kum',
  'late',
  'adv',
];
const CONTACT_PHRASES = [
  'contact person',
  'contact name',
  'contact',
  'contacts',
  'cont',
  'cntct',
  'call',
  'calls',
  'ph',
  'phone',
  'mob',
  'mobile',
  'tel',
  'cell',
  'whatsapp',
  'whats app',
  'wa',
  'sampark',
  'samparka',
  'owner',
  'broker',
  'agent',
  'dealer',
  'consultant',
  'from',
  'name',
  'attn',
  'regards',
  'speak to',
  'talk to',
  'ask for',
  'posted by',
  'listed by',
  'c/o',
  'reach',
  'meet',
  'sms',
  'msg',
  'email',
  'mail',
  'enquiry',
  'enquiries',
];
const SUFFIXES = ['bhai', 'bhau', 'ji', 'seth', 'sheth', 'saheb', 'sahab', 'sir', 'madam', 'mam', 'maam'];

/** A name token: "Sanjay", "SANJAY", "D'Souza", "Rao-Patil", initial "R." or "R". */
const TOKEN = String.raw`[A-Z][A-Za-z'’]*(?:-[A-Z][A-Za-z'’]*)?\.?`;
const LOWER_TOKEN = String.raw`[A-Za-z][A-Za-z'’]*\.?`;
const SEP = String.raw`[ \t]*[:\-–—.,/(]*[ \t]*`;

const HONORIFIC_RE = new RegExp(
  String.raw`\b(?:${ciAlt(HONORIFICS)})\b\.?[ \t]*(?=(?<c>${TOKEN}(?:[ \t]+${TOKEN}){0,4}))`,
  'gdu',
);
const PHRASE_RE = new RegExp(
  String.raw`\b(?:${ciAlt(CONTACT_PHRASES)})\b${SEP}(?=(?<c>${TOKEN}(?:[ \t]+${TOKEN}){0,4}))`,
  'gdu',
);
/** Lower-case after a strong contact phrase ("call sanjay", "contact priya"): WhatsApp-style text. */
const PHRASE_LOWER_RE = new RegExp(
  String.raw`\b(?:${ciAlt(['contact', 'call', 'sampark', 'owner', 'broker', 'agent', 'whatsapp', 'speak to', 'ask for', 'talk to'])})\b${SEP}(?=(?<c>${LOWER_TOKEN}(?:[ \t]+${LOWER_TOKEN}){0,3}))`,
  'gdu',
);
const SUFFIX_RE = new RegExp(
  String.raw`(?<c>\b[A-Za-z][A-Za-z'’]{2,}(?:[ \t]+[A-Z][A-Za-z'’]+)?)[ \t]*-?[ \t]*\b(?:${ciAlt(SUFFIXES)})\b`,
  'gdu',
);
/** Devanagari: "संपर्क: सुनील पाटील", "श्री राजेश", "मालक रमेश". */
const DEVANAGARI_WORD = String.raw`[ऀ-ॣ॰-ॿ]+`;
const DEVANAGARI_RE = new RegExp(
  String.raw`(?:संपर्क|फोन|फ़ोन|मोबाइल|मो\.|श्रीमती|श्री|मालक|मालिक|दलाल)[ \t]*[:\-–.]*[ \t]*(?<c>${DEVANAGARI_WORD}(?:[ \t]+${DEVANAGARI_WORD})?)`,
  'gdu',
);
const DEVANAGARI_STOP = new Set([
  'करें',
  'करे',
  'करा',
  'करो',
  'करिए',
  'साधा',
  'साधावा',
  'के',
  'लिए',
  'हेतु',
  'नंबर',
  'क्रमांक',
]);

/** Before an anchor (phone/e-mail/placeholder): up to 3 words, any case. */
const BEFORE_ANCHOR = new RegExp(
  String.raw`(?<c>${LOWER_TOKEN}(?:[ \t]+${LOWER_TOKEN}){0,2})[ \t]*[:\-–—,()]*[ \t]*$`,
  'du',
);
/** After an anchor: up to 3 capitalised words, then a terminator. */
const AFTER_ANCHOR = new RegExp(
  String.raw`^[ \t]*[\-–—:(,.]?[ \t]*(?<c>${TOKEN}(?:[ \t]+${TOKEN}){0,2})[ \t]*(?=\)|$|[,;.\n|/(!]|[ \t]+(?:or|&)\b)`,
  'du',
);
/** After an anchor, lower case: a single word that ends the text, line or bracket ("… 90000 01266 sanjay"). */
const AFTER_ANCHOR_LOWER = new RegExp(
  String.raw`^[ \t]*[\-–—:(,]?[ \t]*(?<c>[a-z][a-z'’]{2,})[ \t]*(?=\)|$|[\n.!])`,
  'du',
);

interface Tok {
  readonly start: number;
  readonly end: number;
  readonly word: string;
}

function tokenize(s: string, offset: number): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(/[^\s]+/gu)) {
    const word = m[0].replace(/[.,:;]+$/u, '');
    if (word.length > 0) out.push({ start: offset + m.index, end: offset + m.index + word.length, word });
  }
  return out;
}

/** "R." / "K" in "Mr. R. K. Sinha": an initial is part of a name, even when the letter is also a stop word. */
function isInitial(word: string): boolean {
  return /^[A-Z]\.?$/u.test(word);
}

function isStop(word: string, stop: ReadonlySet<string>): boolean {
  const w = word.toLowerCase().replace(/[.'’]/gu, '');
  return w.length === 0 || NON_NAME_WORDS.has(w) || stop.has(w);
}

function isSuffix(word: string | undefined): boolean {
  return word !== undefined && NON_PERSON_SUFFIXES.has(word.toLowerCase().replace(/[.'’]/gu, ''));
}

/**
 * From a candidate token list, skip up to `skip` leading stop words, then take up to `max` consecutive non-stop
 * tokens. Rejects the run when it is followed by a building/company word ("Sai Krupa CHS", "Om Realty").
 */
function pick(toks: readonly Tok[], stop: ReadonlySet<string>, skip: number, max: number): Span | null {
  let i = 0;
  while (i < toks.length && i < skip && isStop(toks[i]?.word ?? '', stop)) i++;
  const taken: Tok[] = [];
  let j = i;
  while (j < toks.length && taken.length < max + 2) {
    const t = toks[j];
    if (t === undefined) break;
    const initialBeforeName = isInitial(t.word) && toks[j + 1] !== undefined;
    if (!initialBeforeName && isStop(t.word, stop)) break;
    if (!initialBeforeName && taken.filter((x) => !isInitial(x.word)).length >= max) break;
    taken.push(t);
    j++;
  }
  const first = taken[0];
  const last = taken[taken.length - 1];
  if (first === undefined || last === undefined) return null;
  if (isSuffix(toks[j]?.word)) return null;
  // A lone single letter is not a name.
  if (taken.length === 1 && first.word.replace(/\./gu, '').length < 2) return null;
  return { kind: 'NAME', start: first.start, end: last.end };
}

function fromLookahead(
  text: string,
  re: RegExp,
  stop: ReadonlySet<string>,
  skip: number,
  max: number,
): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    const c = m.indices?.groups?.['c'];
    if (c === undefined) continue;
    const span = pick(tokenize(text.slice(c[0], c[1]), c[0]), stop, skip, max);
    if (span !== null) out.push(span);
  }
  return out;
}

/** Suffix form picks from the right: the words closest to "bhai"/"ji" are the name. */
function fromSuffix(text: string, stop: ReadonlySet<string>): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(SUFFIX_RE)) {
    const c = m.indices?.groups?.['c'];
    if (c === undefined) continue;
    const toks = tokenize(text.slice(c[0], c[1]), c[0]);
    const taken: Tok[] = [];
    for (let k = toks.length - 1; k >= 0; k--) {
      const t = toks[k];
      if (t === undefined || isStop(t.word, stop)) break;
      taken.unshift(t);
    }
    const first = taken[0];
    const last = taken[taken.length - 1];
    if (first !== undefined && last !== undefined)
      out.push({ kind: 'NAME', start: first.start, end: last.end });
  }
  return out;
}

function fromDevanagari(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(DEVANAGARI_RE)) {
    const c = m.indices?.groups?.['c'];
    if (c === undefined) continue;
    const toks = tokenize(text.slice(c[0], c[1]), c[0]).filter((t) => !DEVANAGARI_STOP.has(t.word));
    const first = toks[0];
    const last = toks[toks.length - 1];
    if (first !== undefined && last !== undefined)
      out.push({ kind: 'NAME', start: first.start, end: last.end });
  }
  return out;
}

/** Names right before or after a phone/e-mail span ("Sanjay 98200 12345", "98200 12345 (Priya)"). */
function aroundAnchors(text: string, anchors: readonly Span[], stop: ReadonlySet<string>): Span[] {
  const out: Span[] = [];
  for (const a of anchors) {
    const beforeStart = Math.max(0, a.start - 60);
    const before = text.slice(beforeStart, a.start);
    const bm = BEFORE_ANCHOR.exec(before);
    const bc = bm?.indices?.groups?.['c'];
    if (bc !== undefined) {
      const toks = tokenize(before.slice(bc[0], bc[1]), beforeStart + bc[0]);
      const taken: Tok[] = [];
      for (let k = toks.length - 1; k >= 0; k--) {
        const t = toks[k];
        if (t === undefined || isStop(t.word, stop)) break;
        const lower = t.word.charAt(0) !== t.word.charAt(0).toUpperCase();
        // Lower-case words need at least 3 letters ("sanjay"), and only the one closest to the number when lower.
        if (lower && (t.word.length < 3 || taken.length > 0)) break;
        taken.unshift(t);
      }
      const first = taken[0];
      const last = taken[taken.length - 1];
      if (first !== undefined && last !== undefined && !(taken.length === 1 && first.word.length < 2)) {
        out.push({ kind: 'NAME', start: first.start, end: last.end });
      }
    }
    // A NUL sentinel stops `$` from matching at an arbitrary cut inside the text.
    const after = text.slice(a.end, a.end + 80) + (a.end + 80 < text.length ? '\u0000' : '');
    const am = AFTER_ANCHOR.exec(after) ?? AFTER_ANCHOR_LOWER.exec(after);
    const ac = am?.indices?.groups?.['c'];
    if (ac !== undefined) {
      const toks = tokenize(after.slice(ac[0], ac[1]), a.end + ac[0]);
      if (toks.length > 0 && toks.every((t) => !isStop(t.word, stop))) {
        const first = toks[0];
        const last = toks[toks.length - 1];
        if (first !== undefined && last !== undefined && first.word.replace(/\./gu, '').length >= 2) {
          out.push({ kind: 'NAME', start: first.start, end: last.end });
        }
      }
    }
  }
  return out;
}

/**
 * @param anchors phone/e-mail spans and existing placeholders; names are looked for around them.
 * @param stop extra lower-case words never treated as names (caller's allow-list).
 */
export function detectNames(text: string, anchors: readonly Span[], stop: ReadonlySet<string>): Span[] {
  return [
    ...fromLookahead(text, HONORIFIC_RE, stop, 0, 3),
    ...fromLookahead(text, PHRASE_RE, stop, 2, 3),
    ...fromLookahead(text, PHRASE_LOWER_RE, stop, 2, 2),
    ...fromSuffix(text, stop),
    ...fromDevanagari(text),
    ...aroundAnchors(text, anchors, stop),
  ];
}
