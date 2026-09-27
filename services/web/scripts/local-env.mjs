// Writes services/web/.env.local for local development (git-ignored): the local Supabase URL and keys (from
// `supabase status`), a fresh WEB_KEK, the single tenant id and the local app origin. Existing values are kept, so
// signing keys and e-mail hashes stay readable. Usage: pnpm --filter @11e/web env:local
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.env.local', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const current = new Map();
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) current.set(m[1], m[2]);
  }
}

let status = {};
try {
  const out = execFileSync('supabase', ['--workdir', 'infra', 'status', '-o', 'env'], {
    cwd: repo,
    encoding: 'utf8',
  });
  status = Object.fromEntries(
    out
      .split('\n')
      .map((l) => /^([A-Z_]+)="?([^"]*)"?$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
} catch {
  process.stderr.write('supabase status failed: is the local stack running (pnpm db:start)?\n');
  process.exit(1);
}

const set = (k, v) => {
  if (!current.has(k) && v) current.set(k, v);
};
set('SUPABASE_URL', status.API_URL ?? 'http://127.0.0.1:54321');
set('SUPABASE_ANON_KEY', status.ANON_KEY ?? status.PUBLISHABLE_KEY);
set('SUPABASE_SERVICE_ROLE_KEY', status.SERVICE_ROLE_KEY ?? status.SECRET_KEY);
set('WEB_KEK', randomBytes(32).toString('base64'));
set('WEB_TENANT_ID', '11e00000-0000-4000-8000-000000000001');
// Must match the local Supabase site_url (infra/supabase/config.toml) for auth redirects.
set('WEB_APP_ORIGIN', 'http://127.0.0.1:3000');
set('ENVIRONMENT_NAME', 'local');

writeFileSync(file, [...current].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
process.stdout.write(`wrote ${file} (${current.size} variables; values not shown)\n`);
