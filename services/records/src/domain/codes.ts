// Display codes issued per tenant from code_sequences (records LLD §3.1, §4.1).
export const CODE_PADS = {
  PRP: 5,
  PRJ: 4,
  INV: 5,
  DEM: 6,
  PER: 6,
  ENQ: 6,
  BIZ: 4,
  CAP: 4,
  EQP: 4,
  WCH: 4,
  AD: 6,
} as const;
export type CodePrefix = keyof typeof CODE_PADS;

/** `PRP-00210`: the number grows past the pad naturally. */
export function formatCode(prefix: CodePrefix, value: number): string {
  return `${prefix}-${String(value).padStart(CODE_PADS[prefix], '0')}`;
}

const CODE = /^[A-Z]{2,3}-\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isCode = (s: string): boolean => CODE.test(s);
export const isUuid = (s: string): boolean => UUID.test(s);

/** Path parameter `{idOrCode}`: a UUID, a code with the expected prefix, or neither (→ not found). */
export function parseIdOrCode(
  value: string,
  prefixes: readonly CodePrefix[],
): { id: string } | { code: string } | null {
  if (isUuid(value)) return { id: value.toLowerCase() };
  if (isCode(value) && prefixes.some((p) => value.startsWith(`${p}-`))) return { code: value };
  return null;
}

/** Desk → code prefix (records LLD §3.16). */
export const DESK_PREFIX = {
  business: 'BIZ',
  capital: 'CAP',
  archive: 'EQP',
  watchlist: 'WCH',
} as const satisfies Record<string, CodePrefix>;
