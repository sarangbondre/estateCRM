// Normalised copies of free text used for matching (records LLD §3: `*_norm` columns are lower-cased,
// punctuation-stripped, whitespace-collapsed).

/** Lower-case, punctuation → space, collapse whitespace. Null for blank. */
export function norm(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return n === '' ? null : n;
}

/** Words that describe the kind of building rather than naming it (BRD dedup rules: "CHS", "society", …). */
export const BUILDING_STOP_WORDS = new Set([
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

/** Building identity for dedup: normalised, building-kind words removed. Null when nothing is left. */
export function buildingNorm(name: string | null | undefined): string | null {
  const n = norm(name);
  if (n === null) return null;
  const words = n.split(' ').filter((w) => !BUILDING_STOP_WORDS.has(w));
  return words.length ? words.join(' ') : null;
}

/** "Sanjay Kumar" → "S. K."; blank → "—" is not used: callers fall back to the code. */
export function initials(name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  const parts = n
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (!parts.length) return null;
  return parts
    .slice(0, 3)
    .map((w) => `${w.charAt(0).toUpperCase()}.`)
    .join(' ');
}

/** Case-insensitive de-duplication keeping the first spelling. */
export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v.trim());
  }
  return out;
}
