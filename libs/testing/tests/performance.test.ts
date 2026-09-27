import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeDataset } from '../src/index.js';

/**
 * Sanity check that 5M rows is feasible (≈ 1 min per 5M at the NDJSON rate). The limit is soft on
 * shared CI runners (slower, noisy neighbours).
 */
const LIMIT_MS = process.env.CI === undefined ? 5_000 : 20_000;

const dir = mkdtempSync(join(tmpdir(), '11e-synth-perf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('performance', () => {
  it(`writes 100k NDJSON rows in under ${LIMIT_MS} ms`, { timeout: 60_000 }, async () => {
    const out = join(dir, 'perf.ndjson');
    const result = await writeDataset(
      { rows: 100_000, seed: 99, errorRate: 0.02 },
      { format: 'ndjson', out, manifestPath: null },
    );
    expect(result.manifest.totals.rows).toBe(100_000);
    expect(statSync(out).size).toBeGreaterThan(100_000 * 1_000);
    expect(result.elapsedMs).toBeLessThan(LIMIT_MS);
  });
});
