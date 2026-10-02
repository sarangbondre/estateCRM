// FileStore on the Supabase Storage REST API (private buckets intake-uploads and intake-rejected, intake LLD §2, §7).
// Paths are `<bucket>/<key>`. Buckets are created idempotently on first use (they live in the platform `storage` schema,
// which service migrations must not touch); production provisioning may create them beforehand.
import { DownstreamError } from '@11e/http';
import type { FileStore, SignedUrl } from '../application/ports.js';

export const BUCKETS = ['intake-uploads', 'intake-rejected'] as const;

export interface SupabaseStorageOptions {
  url: string;
  serviceKey: string;
  fetch?: typeof fetch;
  /** Per-call timeout (ms). Uploads of chunk files may take longer than metadata calls. */
  timeoutMs?: number;
}

function split(path: string): { bucket: string; key: string } {
  const i = path.indexOf('/');
  if (i <= 0) throw new Error('storage path must be <bucket>/<key>');
  return { bucket: path.slice(0, i), key: path.slice(i + 1) };
}

const enc = (key: string) => key.split('/').map(encodeURIComponent).join('/');

/** Expiry of a Supabase signed token (JWT `exp`), else the fallback. */
function tokenExpiry(url: string, fallbackSec: number): Date {
  try {
    const token = new URL(url, 'http://x').searchParams.get('token') ?? '';
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (typeof payload.exp === 'number') return new Date(payload.exp * 1000);
  } catch {
    // fall through
  }
  return new Date(Date.now() + fallbackSec * 1000);
}

export function supabaseFileStore(o: SupabaseStorageOptions): FileStore {
  const doFetch = o.fetch ?? fetch;
  const base = `${o.url.replace(/\/$/, '').replace(/\/storage\/v1$/, '')}/storage/v1`;
  const auth = { authorization: `Bearer ${o.serviceKey}`, apikey: o.serviceKey };
  const timeout = o.timeoutMs ?? 10_000;
  let buckets: Promise<void> | undefined;

  const call = async (path: string, init: RequestInit, ms = timeout) => {
    try {
      return await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (err) {
      throw new DownstreamError('storage', 0, `storage ${init.method ?? 'GET'} failed`, { cause: err });
    }
  };
  const fail = (what: string, status: number) =>
    new DownstreamError('storage', status, `storage ${what}: ${status}`);

  const ensureBuckets = () =>
    (buckets ??= (async () => {
      for (const id of BUCKETS) {
        const res = await call('/bucket', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ id, name: id, public: false }),
        });
        // 409 (or 400 on older Storage versions) = already exists
        if (!res.ok && res.status !== 409 && res.status !== 400) throw fail('create bucket', res.status);
        await res.body?.cancel();
      }
    })().catch((err: unknown) => {
      buckets = undefined;
      throw err;
    }));

  return {
    async signedUploadUrl(path): Promise<SignedUrl> {
      await ensureBuckets();
      const { bucket, key } = split(path);
      const res = await call(`/object/upload/sign/${bucket}/${enc(key)}`, { method: 'POST', headers: auth });
      if (!res.ok) throw fail('sign upload', res.status);
      const body = (await res.json()) as { url: string };
      return { url: `${base}${body.url}`, expiresAt: tokenExpiry(body.url, 7200) };
    },

    async signedReadUrl(path, expiresInSec): Promise<SignedUrl> {
      const { bucket, key } = split(path);
      const res = await call(`/object/sign/${bucket}/${enc(key)}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSec }),
      });
      if (!res.ok) throw fail('sign read', res.status);
      const body = (await res.json()) as { signedURL: string };
      return { url: `${base}${body.signedURL}`, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
    },

    async stat(path) {
      const { bucket, key } = split(path);
      const res = await call(`/object/authenticated/${bucket}/${enc(key)}`, {
        method: 'HEAD',
        headers: auth,
      });
      if (res.status === 404 || res.status === 400) return undefined;
      if (!res.ok) throw fail('stat', res.status);
      return { sizeBytes: Number(res.headers.get('content-length') ?? 0) };
    },

    async read(path) {
      const { bucket, key } = split(path);
      const res = await call(
        `/object/authenticated/${bucket}/${enc(key)}`,
        { method: 'GET', headers: auth },
        120_000,
      );
      if (!res.ok || !res.body) throw fail('read', res.status);
      return res.body as unknown as AsyncIterable<Uint8Array>;
    },

    async put(path, body, contentType) {
      await ensureBuckets();
      const { bucket, key } = split(path);
      const res = await call(
        `/object/${bucket}/${enc(key)}`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': contentType, 'x-upsert': 'true' },
          body: typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
        },
        60_000,
      );
      if (!res.ok) throw fail('put', res.status);
      await res.body?.cancel();
    },

    async remove(paths) {
      const byBucket = new Map<string, string[]>();
      for (const p of paths) {
        const { bucket, key } = split(p);
        byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), key]);
      }
      for (const [bucket, keys] of byBucket) {
        for (let i = 0; i < keys.length; i += 1000) {
          const res = await call(`/object/${bucket}`, {
            method: 'DELETE',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ prefixes: keys.slice(i, i + 1000) }),
          });
          if (!res.ok && res.status !== 404) throw fail('delete', res.status);
          await res.body?.cancel();
        }
      }
    },
  };
}
