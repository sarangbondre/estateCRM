#!/usr/bin/env node
// Usage: 11e-migrate --schema <schema> [--dir migrations] [--check]
// Env:   MIGRATOR_DATABASE_URL (the service's <schema>_migrator role; direct/session connection).
// --check only loads and lints the files (no database), for CI.
import { parseArgs } from 'node:util';
import { loadMigrations, migrate } from '../migrate.js';

const { values } = parseArgs({
  options: {
    schema: { type: 'string' },
    dir: { type: 'string', default: 'migrations' },
    check: { type: 'boolean', default: false },
  },
});

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string): never => {
  process.stderr.write(`${s}\n`);
  process.exit(1);
};

const dir = values.dir ?? 'migrations';
if (values.check) {
  const files = await loadMigrations(dir).catch((e: Error) => fail(e.message));
  out(`migrations ok: ${files.length} file(s) in ${dir}`);
} else {
  const schema = values.schema ?? fail('--schema is required');
  const url = process.env['MIGRATOR_DATABASE_URL'] ?? fail('MIGRATOR_DATABASE_URL is not set');
  const r = await migrate({ connectionString: url, schema, dir }).catch((e: Error) => fail(e.message));
  out(
    `${schema}: applied ${r.applied.length} (${r.applied.join(', ') || 'none'}), already applied ${r.alreadyApplied.length}`,
  );
}
