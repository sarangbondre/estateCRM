/**
 * Case-insensitive source for a literal word, without the `i` flag (so the rest of the pattern can stay
 * case-sensitive, e.g. "a capitalised name after a case-insensitive contact phrase").
 */
export function ci(word: string): string {
  let out = '';
  for (const ch of word) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo !== up) out += `[${up}${lo}]`;
    else if (/[\\^$.*+?()[\]{}|/-]/u.test(ch)) out += `\\${ch}`;
    else if (ch === ' ') out += '\\s+';
    else out += ch;
  }
  return out;
}

/** Alternation of case-insensitive words, longest first so "contact person" wins over "contact". */
export function ciAlt(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map(ci)
    .join('|');
}
