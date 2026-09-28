// Opaque identifiers generated from caller-supplied random bytes (the CSPRNG lives in an adapter).
import { scanText } from './privacy.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PUBLIC_ID_PATTERN = /^L-[0-9A-HJKMNP-TV-Z]{10}$/;

/** `L-` + 10 Crockford base32 characters from 50 random bits (LLD §4.6). Needs ≥ 7 random bytes. */
export function publicIdFrom(random: Uint8Array): string {
  if (random.length < 7) throw new RangeError('publicIdFrom needs at least 7 random bytes');
  let bits = 0n;
  for (let i = 0; i < 7; i++) bits = (bits << 8n) | BigInt(random[i] ?? 0);
  bits >>= 6n; // 56 → 50 bits
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = (CROCKFORD[Number(bits & 31n)] as string) + out;
    bits >>= 5n;
  }
  return `L-${out}`;
}

/**
 * True when an id would trip the privacy scan (digit runs and look-alike letters that read as a phone number, etc.).
 * Public ids are re-drawn until this is false, so the M8 output scan (0 PII-like strings in API output) always holds.
 */
export const hasContactLikeDigits = (id: string) =>
  scanText({ text: id }).some((f) => f.severity === 'block');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const API_KEY_PREFIX = 'lk_live_';

/** `lk_live_` + 40 base62 characters (≈ 238 bits, LLD §4.10). Rejection sampling keeps the alphabet uniform. */
export function apiKeyFrom(random: Uint8Array): string {
  let out = '';
  for (const byte of random) {
    if (byte >= 248) continue; // 248 = 4 × 62
    out += BASE62[byte % 62];
    if (out.length === 40) break;
  }
  if (out.length < 40) throw new RangeError('apiKeyFrom needs more random bytes');
  return `${API_KEY_PREFIX}${out}`;
}

/** First 8 characters, for display only ("lk_live_"). The contract calls them the prefix. */
export const apiKeyDisplayPrefix = (key: string) => key.slice(0, 10);

/**
 * Random public file name for a photo copy: 24 lower-case letters (≈ 112 bits), never the photo id. Letters only, so
 * a public URL never holds a digit run that could read as a phone number (M8 output scans).
 */
export function publicNameFrom(random: Uint8Array): string {
  return Array.from(random.slice(0, 24), (b) => String.fromCharCode(97 + (b % 26))).join('');
}
