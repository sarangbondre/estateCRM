// In-memory photo bucket and image fetcher for REC-09 tests.
import { createHash } from 'node:crypto';
import type { ImageFetcher, PhotoStore, StoredObject } from '../../src/application/ports.js';

export class FakePhotoStore implements PhotoStore {
  readonly objects = new Map<string, Uint8Array>();

  async signedUploadUrl(path: string): Promise<string> {
    return `https://storage.example.com/upload/${path}?token=t`;
  }
  async signedReadUrl(path: string, expiresInSec: number): Promise<string> {
    return `https://storage.example.com/read/${path}?ttl=${expiresInSec}`;
  }
  async inspect(path: string): Promise<StoredObject | undefined> {
    const bytes = this.objects.get(path);
    if (!bytes) return undefined;
    return { sizeBytes: bytes.byteLength, head: bytes.slice(0, 65536), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(path, bytes);
  }
  async remove(path: string): Promise<void> {
    this.objects.delete(path);
  }
  /** The client's PUT to the signed URL. */
  upload(storagePathWithBucket: string, bytes: Uint8Array) {
    this.objects.set(storagePathWithBucket.replace(/^records-photos\//, ''), bytes);
  }
}

/** A valid PNG header of the given size (unique content per seed). */
export function png(width = 640, height = 480, seed = 0): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  b[40] = seed & 0xff;
  b[41] = (seed >> 8) & 0xff;
  return b;
}

export class FakeImages implements ImageFetcher {
  constructor(private readonly byUrl: Map<string, Uint8Array | Error>) {}
  async fetch(url: string) {
    const r = this.byUrl.get(url);
    if (!r) throw new Error('HTTP 404');
    if (r instanceof Error) throw r;
    return { bytes: r, contentType: 'image/png' };
  }
}
