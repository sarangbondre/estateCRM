// Supabase Storage buckets (LLD §3 "Buckets"): listings-photos (private, sanitised copies) and listings-public (public
// CDN, copies used by Public items only). Plus the image sanitiser: metadata (EXIF/GPS/XMP/comments) is stripped
// byte-wise without re-encoding.
import type { ImageProcessor, PhotoStore } from '../application/ports.js';

export interface StorageOptions {
  url: string;
  serviceKey: string;
  privateBucket: string;
  publicBucket: string;
  fetch?: typeof fetch;
}

export function supabasePhotoStore(o: StorageOptions): PhotoStore {
  const doFetch = o.fetch ?? fetch;
  const base = `${o.url.replace(/\/$/, '').replace(/\/storage\/v1$/, '')}/storage/v1`;
  const headers = { authorization: `Bearer ${o.serviceKey}`, apikey: o.serviceKey };
  const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const call = (path: string, init: RequestInit) =>
    doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const remove = async (bucket: string, path: string) => {
    const res = await call(`/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`storage delete: ${res.status}`);
  };
  return {
    async putPrivate(path, bytes, contentType) {
      const res = await call(`/object/${o.privateBucket}/${enc(path)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': contentType, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!res.ok) throw new Error(`storage put: ${res.status}`);
    },
    async copyToPublic(privatePath, publicPath) {
      const res = await call(`/object/copy`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          bucketId: o.privateBucket,
          sourceKey: privatePath,
          destinationBucket: o.publicBucket,
          destinationKey: publicPath,
        }),
      });
      if (!res.ok) throw new Error(`storage copy: ${res.status}`);
    },
    removePublic: (path) => remove(o.publicBucket, path),
    removePrivate: (path) => remove(o.privateBucket, path),
    publicUrl: (path) => `${base}/object/public/${o.publicBucket}/${enc(path)}`,
  };
}

/** Public URL builder when storage isn't configured (local): same shape, never fetched. */
export const publicUrlFor = (url: string | undefined, bucket: string) => (path: string) =>
  `${(url ?? 'http://127.0.0.1:54321').replace(/\/$/, '').replace(/\/storage\/v1$/, '')}/storage/v1/object/public/${bucket}/${path}`;

// ---- metadata stripping ------------------------------------------------------------------------------------------

const u16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32le = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
const u32be = (b: Uint8Array, i: number) => ((u16(b, i) << 16) >>> 0) + u16(b, i + 2);

/** JPEG: drops APP1..APP15 (EXIF, XMP, ICC/maker notes) and COM segments; keeps APP0 (JFIF) and image data. */
export function stripJpeg(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error('corrupt JPEG');
    const marker = b[i + 1] ?? 0;
    if (marker === 0xda) {
      parts.push(b.subarray(i)); // start of scan: the rest is entropy-coded data
      break;
    }
    const len = u16(b, i + 2);
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return concat(parts);
}

/** PNG: drops eXIf and text chunks (tEXt, zTXt, iTXt) and time. */
export function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (!['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type)) parts.push(b.subarray(i, end));
    i = end;
  }
  return concat(parts);
}

/** WebP: drops EXIF and XMP chunks and clears their VP8X flags. */
export function stripWebp(b: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const len = u32le(b, i + 4);
    const end = i + 8 + len + (len % 2);
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = b.slice(i, end);
      if (type === 'VP8X') chunk[8] = (chunk[8] ?? 0) & ~0x0c; // EXIF (0x08) and XMP (0x04) flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 4));
  const size = body.length + 4;
  header.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
  header.set(b.subarray(8, 12), 8);
  return concat([header, body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function size(b: Uint8Array): { width: number; height: number } {
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      const marker = b[i + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { height: u16(b, i + 5), width: u16(b, i + 7) };
      i += 2 + u16(b, i + 2);
    }
  } else if (b[0] === 0x89 && b[1] === 0x50) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  } else if (String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    const u24 = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
    if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
    if (chunk === 'VP8 ')
      return {
        width: (b[26] ?? 0) | (((b[27] ?? 0) & 0x3f) << 8),
        height: (b[28] ?? 0) | (((b[29] ?? 0) & 0x3f) << 8),
      };
  }
  return { width: 0, height: 0 };
}

/**
 * Metadata stripping for JPEG / PNG / WebP (EXIF and GPS never leave listings). The LLD's 1600 px WebP re-encode needs a
 * native image library; it isn't installed (build scripts are denied in the workspace), so renditions keep their
 * original encoding (records caps originals at 10 MB).
 */
export const metadataStripper: ImageProcessor = {
  async sanitise(bytes) {
    let out: Uint8Array;
    let contentType: string;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      out = stripJpeg(bytes);
      contentType = 'image/jpeg';
    } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      out = stripPng(bytes);
      contentType = 'image/png';
    } else if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF') {
      out = stripWebp(bytes);
      contentType = 'image/webp';
    } else throw new Error('unsupported image type');
    return { bytes: out, contentType, ext: contentType.slice(6).replace('jpeg', 'jpg'), ...size(out) };
  },
};
