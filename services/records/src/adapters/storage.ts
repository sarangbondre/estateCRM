// Photo storage on Supabase Storage (private bucket records-photos, D-5) and the sheet-link image fetcher
// (records LLD §4.12: 5 concurrent per host, 2 s timeout, 10 MB cap).
import { createHash } from 'node:crypto';
import type { ImageFetcher, PhotoStore, StoredObject } from '../application/ports.js';
import type { Config } from '../config.js';

const MAX_BYTES = 10 * 1024 * 1024;

export interface StorageOptions {
  url: string;
  serviceKey: string;
  bucket: string;
  fetch?: typeof fetch;
}

export function supabasePhotoStore(o: StorageOptions): PhotoStore {
  const doFetch = o.fetch ?? fetch;
  const base = `${o.url.replace(/\/$/, '').replace(/\/storage\/v1$/, '')}/storage/v1`;
  const headers = { authorization: `Bearer ${o.serviceKey}`, apikey: o.serviceKey };
  const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const call = async (path: string, init: RequestInit) => {
    const res = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(2000) });
    return res;
  };
  return {
    async signedUploadUrl(path) {
      const res = await call(`/object/upload/sign/${o.bucket}/${enc(path)}`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`storage sign upload: ${res.status}`);
      const body = (await res.json()) as { url: string };
      return `${base}${body.url}`;
    },
    async signedReadUrl(path, expiresInSec) {
      const res = await call(`/object/sign/${o.bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSec }),
      });
      if (!res.ok) throw new Error(`storage sign read: ${res.status}`);
      const body = (await res.json()) as { signedURL: string };
      return `${base}${body.signedURL}`;
    },
    async inspect(path): Promise<StoredObject | undefined> {
      const res = await call(`/object/authenticated/${o.bucket}/${enc(path)}`, { method: 'GET', headers });
      if (res.status === 404 || res.status === 400) return undefined;
      if (!res.ok) throw new Error(`storage get: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        sizeBytes: bytes.byteLength,
        head: bytes.slice(0, 65536),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    async put(path, bytes, contentType) {
      const res = await call(`/object/${o.bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': contentType, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!res.ok) throw new Error(`storage put: ${res.status}`);
    },
    async remove(path) {
      const res = await call(`/object/${o.bucket}`, {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: [path] }),
      });
      if (!res.ok && res.status !== 404) throw new Error(`storage delete: ${res.status}`);
    },
  };
}

export function createPhotoStore(config: Config): PhotoStore | undefined {
  if (!config.storageUrl || !config.storageServiceKey) return undefined;
  return supabasePhotoStore({ url: config.storageUrl, serviceKey: config.storageServiceKey, bucket: config.photoBucket });
}

/** Downloads sheet-link photos: ≤ 5 at a time per host, 2 s, 10 MB. */
export function createImageFetcher(doFetch: typeof fetch = fetch): ImageFetcher {
  const active = new Map<string, number>();
  const waiters = new Map<string, (() => void)[]>();
  const acquire = async (host: string) => {
    while ((active.get(host) ?? 0) >= 5) {
      await new Promise<void>((resolve) => waiters.set(host, [...(waiters.get(host) ?? []), resolve]));
    }
    active.set(host, (active.get(host) ?? 0) + 1);
  };
  const release = (host: string) => {
    active.set(host, (active.get(host) ?? 1) - 1);
    const next = waiters.get(host)?.shift();
    next?.();
  };
  return {
    async fetch(url) {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported URL scheme');
      await acquire(u.host);
      try {
        const res = await doFetch(u, { redirect: 'follow', signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const length = Number(res.headers.get('content-length') ?? 0);
        if (length > MAX_BYTES) throw new Error('image larger than 10 MB');
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) throw new Error('image larger than 10 MB');
        return { bytes, contentType: res.headers.get('content-type') };
      } finally {
        release(u.host);
      }
    },
  };
}
