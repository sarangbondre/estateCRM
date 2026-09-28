// Deterministic UUID-shaped ids for derived rows (e.g. one rm_person_flag row per person and flag, one rm_row_stat row
// per upload bucket). Pure: two 64-bit FNV-1a hashes over the key, formatted as a version-8 (custom) UUID.

const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

function fnv1a64(input: string, seed: bigint): bigint {
  let h = seed;
  for (const ch of input) {
    h ^= BigInt(ch.codePointAt(0) ?? 0);
    h = (h * FNV_PRIME) & MASK;
  }
  return h;
}

export function stableUuid(key: string): string {
  const a = fnv1a64(key, 0xcbf29ce484222325n).toString(16).padStart(16, '0');
  const b = fnv1a64(`${key}\u0001`, 0x84222325cbf29ce4n).toString(16).padStart(16, '0');
  const hex = a + b;
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
