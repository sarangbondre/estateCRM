// FileStoragePort: Supabase Storage (private bucket `journeys-proposals`, signed URLs) through its REST API. Without
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (local development only) files go to a local directory and "signed URLs"
// are file:// URLs.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileStoragePort } from '../application/ports.js';
import type { Config } from '../config.js';

const TIMEOUT = 10_000;

export function supabaseStorage(url: string, serviceKey: string, bucket: string): FileStoragePort {
  const base = `${url.replace(/\/$/, '')}/storage/v1`;
  const auth = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  const put = async (path: string, body: Uint8Array, contentType: string) => {
    const res = await fetch(`${base}/object/${bucket}/${enc(path)}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': contentType, 'x-upsert': 'true' },
      body,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`storage put ${res.status}`);
  };
  return {
    put,
    async copyFromUrl(src, path) {
      const res = await fetch(src, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok) throw new Error(`photo fetch ${res.status}`);
      await put(path, new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type') ?? 'application/octet-stream');
    },
    async signedUrl(path, expiresInSec) {
      const res = await fetch(`${base}/object/sign/${bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSec }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`storage sign ${res.status}`);
      const body = (await res.json()) as { signedURL?: string };
      return `${base}${body.signedURL ?? ''}`;
    },
    async signedUrls(paths, expiresInSec) {
      if (!paths.length) return [];
      const res = await fetch(`${base}/object/sign/${bucket}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSec, paths }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`storage sign ${res.status}`);
      const body = (await res.json()) as { path?: string; signedURL?: string | null }[];
      const byPath = new Map(body.map((b) => [b.path, b.signedURL]));
      return paths.map((p) => `${base}${byPath.get(p) ?? ''}`);
    },
    async remove(paths) {
      if (!paths.length) return;
      const res = await fetch(`${base}/object/${bucket}`, {
        method: 'DELETE',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`storage delete ${res.status}`);
    },
  };
}

export function localStorage(dir: string): FileStoragePort {
  const file = (path: string) => {
    const p = normalize(join(dir, path));
    if (!p.startsWith(normalize(dir))) throw new Error('path escapes the storage directory');
    return p;
  };
  const put = async (path: string, body: Uint8Array) => {
    await mkdir(dirname(file(path)), { recursive: true });
    await writeFile(file(path), body);
  };
  return {
    put: (path, body) => put(path, body),
    async copyFromUrl(src, path) {
      if (src.startsWith('file:')) {
        await put(path, await readFile(new URL(src)));
        return;
      }
      const res = await fetch(src, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok) throw new Error(`photo fetch ${res.status}`);
      await put(path, new Uint8Array(await res.arrayBuffer()));
    },
    signedUrl: async (path) => pathToFileURL(file(path)).href,
    signedUrls: async (paths) => paths.map((p) => pathToFileURL(file(p)).href),
    async remove(paths) {
      for (const p of paths) await rm(file(p), { force: true });
    },
  };
}

export function createStorage(config: Config): FileStoragePort {
  if (config.supabaseUrl && config.supabaseServiceKey)
    return supabaseStorage(config.supabaseUrl, config.supabaseServiceKey, config.storageBucket);
  return localStorage(config.localStorageDir ?? join(tmpdir(), 'journeys-proposals'));
}
