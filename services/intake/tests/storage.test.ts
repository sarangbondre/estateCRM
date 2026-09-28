// Supabase Storage adapter against the local Storage API (`pnpm db:start` runs it; CI starts only Postgres, so this
// file runs when INTAKE_STORAGE_URL and INTAKE_STORAGE_SERVICE_KEY are set, e.g. from `supabase status -o env`).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { supabaseFileStore } from '../src/adapters/storage.js';

const url = process.env['INTAKE_STORAGE_URL'];
const keyFile = process.env['INTAKE_STORAGE_SERVICE_KEY_FILE'];
const key =
  process.env['INTAKE_STORAGE_SERVICE_KEY'] ?? (keyFile ? readFileSync(keyFile, 'utf8').trim() : undefined);

describe.skipIf(!url || !key)('supabaseFileStore (local Storage API)', () => {
  const store = supabaseFileStore({ url: url ?? '', serviceKey: key ?? '' });

  it('signs an upload URL the browser can PUT to, then stats, reads and removes the object', async () => {
    const path = `intake-uploads/${randomUUID()}/${randomUUID()}/source`;
    const signed = await store.signedUploadUrl(path);
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const put = await fetch(signed.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/csv' },
      body: 'a,b\n1,2\n',
    });
    expect(put.ok).toBe(true);
    expect(await store.stat(path)).toEqual({ sizeBytes: 8 });
    const chunks: Uint8Array[] = [];
    for await (const c of await store.read(path)) chunks.push(c);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('a,b\n1,2\n');
    const link = await store.signedReadUrl(path, 60);
    expect((await fetch(link.url)).status).toBe(200);
    await store.remove([path]);
    expect(await store.stat(path)).toBeUndefined();
  });

  it('writes with put (upsert) into the rejected bucket', async () => {
    const path = `intake-rejected/${randomUUID()}/${randomUUID()}.csv`;
    await store.put(path, 'x\n', 'text/csv');
    await store.put(path, 'row,error\n', 'text/csv');
    expect(await store.stat(path)).toEqual({ sizeBytes: 10 });
    await store.remove([path]);
  });
});
