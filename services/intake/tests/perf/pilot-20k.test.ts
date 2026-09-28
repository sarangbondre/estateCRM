// INT-11 performance check (capacity plan §3, LLD §8): a 20,000-row synthetic pilot file (CR-005 cap) through the
// whole pipeline locally — inspect, split (500-row chunks, anonymised), 5 concurrent chunk workers (R-22 pilot),
// finalize — must finish within 5 minutes. Opt-in (INTAKE_PERF=1): it takes minutes and is run locally, not in CI.
//   INTAKE_PERF=1 pnpm --filter @11e/intake exec vitest run tests/perf
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { supabaseFileStore } from '../../src/adapters/storage.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processChunk } from '../../src/application/chunk.js';
import { runFinalize } from '../../src/application/finalize.js';
import { runInspection } from '../../src/application/inspection.js';
import { runSplit } from '../../src/application/split.js';
import { createHarness, newTenant } from '../support/harness.js';
import type { Harness } from '../support/harness.js';
import { synthFile } from '../support/files.js';
import { seedVocabulary, uploadFile } from '../support/flows.js';

const enabled = process.env['INTAKE_PERF'] === '1';
const WORKERS = 5;
// Real local Supabase Storage when configured (like tests/storage.test.ts), else in-memory storage.
const storageUrl = process.env['INTAKE_STORAGE_URL'];
const keyFile = process.env['INTAKE_STORAGE_SERVICE_KEY_FILE'];
const storageKey =
  process.env['INTAKE_STORAGE_SERVICE_KEY'] ?? (keyFile ? readFileSync(keyFile, 'utf8').trim() : undefined);
const files =
  storageUrl && storageKey ? supabaseFileStore({ url: storageUrl, serviceKey: storageKey }) : undefined;

let h: Harness;
beforeAll(async () => {
  if (enabled) h = await createHarness({ env: { POOL_MAX: '5' }, ...(files ? { files } : {}) });
});
afterAll(async () => {
  if (enabled) await h.close();
});

describe.skipIf(!enabled)('pilot throughput', () => {
  it('processes a 20k-row pilot file end to end in ≤ 5 minutes', { timeout: 600_000 }, async () => {
    const t0 = performance.now();
    const { bytes, manifest } = await synthFile({
      rows: 20_000,
      seed: 2026,
      errorRate: 0.01,
      whatsappRate: 0.1,
    });
    const generated = performance.now();
    const t = newTenant();
    await seedVocabulary(h, t);
    const u = await uploadFile(h, t, bytes);

    const start = performance.now();
    expect((await h.call('POST', `/v1/uploads/${u.id}/inspect`, u.headers)).status).toBe(202);
    await runInspection(h.app, h.app.sheets, { tenantId: t, uploadId: u.id, correlationId: 'perf' });
    const inspected = performance.now();
    expect((await h.call('POST', `/v1/uploads/${u.id}/start`, u.headers, {})).status).toBe(202);
    await runSplit(h.app, { tenantId: t, uploadId: u.id, correlationId: 'perf' });
    const split = performance.now();

    const chunks = (
      await h.db.selectFrom('upload_chunks').select('chunk_no').where('upload_id', '=', u.id).execute()
    ).map((c) => c.chunk_no);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunkNo = chunks[next++] as number;
        await processChunk(h.app, { tenantId: t, uploadId: u.id, chunkNo, correlationId: 'perf' });
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    const processed = performance.now();
    await runFinalize(h.app, { tenantId: t, uploadId: u.id, correlationId: 'perf' });
    const done = performance.now();

    const up = (await h.call('GET', `/v1/uploads/${u.id}`, u.headers)).body;
    expect(up).toMatchObject({
      status: 'completed',
      chunkCount: 40,
      counts: { read: 20_000, accepted: manifest.totals.loaded, rejected: manifest.totals.rejected },
    });
    const s = (a: number, b: number) => `${((b - a) / 1000).toFixed(1)} s`;
    const report = {
      rows: 20_000,
      chunks: chunks.length,
      workers: WORKERS,
      generateFile: s(t0, generated),
      inspect: s(start, inspected),
      split: s(inspected, split),
      chunks40: s(split, processed),
      perChunkAvg: `${((processed - split) / chunks.length / 1000) * WORKERS} s (per worker)`,
      finalize: s(processed, done),
      endToEnd: s(start, done),
      fileBytes: bytes.byteLength,
      storage: files ? 'supabase-local' : 'memory',
    };
    process.stdout.write(`\nINTAKE PILOT 20k: ${JSON.stringify(report, null, 2)}\n`);
    expect(done - start).toBeLessThan(5 * 60_000);
  });
});
