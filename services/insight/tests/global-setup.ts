// Applies the migrations once before the test files run (the migrator role has a small connection cap), and — when
// INSIGHT_CONTRACT_COVERAGE=1 (the package `test` script) — checks after the run that every contract operation was
// exercised with a success and an error status (responses are validated against the contract in tests).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '@11e/db';

/** Served by libs/http directly (no operationId on the route); verified in platform.test.ts. */
const PLATFORM = new Set(['live', 'ready']);

export default async function setup(): Promise<() => void> {
  const host = '127.0.0.1:54322/postgres';
  await migrate({
    connectionString:
      process.env['INSIGHT_MIGRATOR_DATABASE_URL'] ?? `postgresql://insight_migrator:local_insight_migrator@${host}`,
    schema: 'insight',
    dir: new URL('../migrations', import.meta.url).pathname,
  });
  const dir = mkdtempSync(join(tmpdir(), 'insight-hits-'));
  process.env['INSIGHT_HITS_DIR'] = dir;
  return () => {
    const strict = process.env['INSIGHT_CONTRACT_COVERAGE'] === '1';
    const spec = JSON.parse(
      readFileSync(new URL('../../../contracts/generated/openapi/insight.json', import.meta.url), 'utf8'),
    ) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ops = Object.values(spec.paths)
      .flatMap((p) => Object.values(p).map((o) => o.operationId))
      .filter((x): x is string => !!x && !PLATFORM.has(x));
    const ok = new Set<string>();
    const err = new Set<string>();
    for (const f of readdirSync(dir)) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
        const [op, status] = JSON.parse(line) as [string, number];
        if (status < 300) ok.add(op);
        else if (status >= 400 && status < 500) err.add(op);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    const missing = ops.filter((o) => !ok.has(o)).map((o) => `${o} (no 2xx)`);
    missing.push(...ops.filter((o) => !err.has(o)).map((o) => `${o} (no 4xx)`));
    process.stdout.write(
      `\ncontract coverage: ${ops.length} operations (+ 2 health), ${ok.size} with a success, ${err.size} with an error path\n`,
    );
    if (strict && missing.length) throw new Error(`contract operations not exercised: ${missing.join(', ')}`);
  };
}
