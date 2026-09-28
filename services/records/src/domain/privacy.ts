// Scan terms (R-20) and image checks (D-5, A-26).
import { BUILDING_STOP_WORDS, norm } from './text.js';

/** Building/society name tokens that listings must not publish: ≥ 3 chars, building-kind words removed. */
export function buildingTokens(name: string | null | undefined): string[] {
  const n = norm(name);
  if (!n) return [];
  const words = n.split(' ').filter((w) => w.length >= 3 && !BUILDING_STOP_WORDS.has(w));
  const out = new Set(words);
  // The whole name without stop words also counts as one token ("sea breeze" → "sea breeze", "seabreeze").
  if (words.length > 1) {
    out.add(words.join(' '));
    out.add(words.join(''));
  }
  return [...out];
}

/** Wing / unit identifiers ("B-1203" → "b 1203", "b1203"). */
export function unitTokens(value: string | null | undefined): string[] {
  const n = norm(value);
  if (!n) return [];
  return [...new Set([n, n.replace(/\s+/g, '')])];
}

export const PHOTO_LIMIT = 30;
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Content type from magic bytes; null when not JPG/PNG/WebP. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Width and height when cheaply readable from the header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X). */
export function imageSize(bytes: Uint8Array, type: ImageType): { width: number; height: number } | null {
  const u16be = (i: number) => ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  const u32be = (i: number) => ((u16be(i) << 16) >>> 0) + u16be(i + 2);
  const u16le = (i: number) => (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8);
  const u24le = (i: number) => u16le(i) | ((bytes[i + 2] ?? 0) << 16);
  if (type === 'image/png' && bytes.length >= 24) return { width: u32be(16), height: u32be(20) };
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] ?? 0;
      const len = u16be(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: u16be(i + 5), width: u16be(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (type === 'image/webp' && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = (k: number) => bytes[21 + k] ?? 0;
      return { width: 1 + (((b(1) & 0x3f) << 8) | b(0)), height: 1 + (((b(3) & 0xf) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)) };
    }
  }
  return null;
}
