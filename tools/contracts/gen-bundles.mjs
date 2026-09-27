// Bundles each service's OpenAPI spec (with _common.yaml refs inlined as local #/components refs) into
// contracts/generated/openapi/<service>.json for runtime request validation by libs/http (CR-007).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { root } from './events.mjs';

const services = ['web', 'intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight'];
const redocly = createRequire(import.meta.url).resolve('@redocly/cli/bin/cli.js');
const outDir = new URL('contracts/generated/openapi/', root);
mkdirSync(outDir, { recursive: true });
for (const svc of services) {
  const r = spawnSync(
    process.execPath,
    [
      redocly,
      'bundle',
      fileURLToPath(new URL(`contracts/openapi/${svc}.yaml`, root)),
      '--ext',
      'json',
      '-o',
      fileURLToPath(new URL(`${svc}.json`, outDir)),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout);
    process.exit(1);
  }
}
process.stdout.write(`openapi bundles: ${services.length}\n`);
