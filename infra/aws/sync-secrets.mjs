// Writes each app's Secrets Manager secret (CR-018) from the pilot settings: the PILOT_ENV variable holds the settings
// file (KEY=value lines, as in the private pilot secrets file) and HF_TOKEN the Hugging Face key. apps.json says which
// keys each app gets and where they come from. Only key names are printed, never values.
// Usage (GitHub workflow aws-secrets, with AWS credentials): node infra/aws/sync-secrets.mjs <environment-name> [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const envName = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!/^(pilot|staging|production)$/.test(envName ?? '')) {
  process.stderr.write('usage: sync-secrets.mjs <pilot|staging|production> [--dry-run]\n');
  process.exit(2);
}

const source = {};
for (const line of (process.env['PILOT_ENV'] ?? '').split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) continue;
  let v = m[2].trim();
  if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
  source[m[1]] = v;
}
if (process.env['HF_TOKEN']) source['HF_TOKEN'] = process.env['HF_TOKEN'];

const apps = JSON.parse(readFileSync(new URL('./apps.json', import.meta.url), 'utf8'));
let missing = 0;
for (const [app, def] of Object.entries(apps)) {
  if (app === '_comment') continue;
  const secret = {};
  for (const [key, from] of Object.entries(def.secrets)) {
    if (!source[from]) {
      process.stdout.write(`::error::${app}: ${key} needs ${from}, which is not in the settings\n`);
      missing++;
      continue;
    }
    secret[key] = source[from];
  }
  if (Object.keys(secret).length !== Object.keys(def.secrets).length) continue;
  const id = `estatecrm/${envName}/${app}`;
  if (!dryRun) {
    // The value goes through stdin, never the command line (visible in the process list).
    execFileSync(
      'aws',
      ['secretsmanager', 'put-secret-value', '--secret-id', id, '--secret-string', 'file:///dev/stdin'],
      {
        input: JSON.stringify(secret),
        stdio: ['pipe', 'ignore', 'inherit'],
      },
    );
  }
  process.stdout.write(`${dryRun ? '[dry run] ' : ''}${id}: ${Object.keys(secret).join(', ')}\n`);
}
if (missing) process.exit(1);
