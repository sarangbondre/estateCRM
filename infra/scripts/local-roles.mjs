// Local stack only: gives each service's LOGIN roles its local password (the bootstrap migration never sets one),
// stores each service's local cron secret in Supabase Vault, points the scheduler at the local dev ports, and prints the
// connection env. Run after `supabase start` / `db reset`: `pnpm db:start` does it for you.
// Usage: node infra/scripts/local-roles.mjs [--env] [--schedules on|off]
//   --env        print only KEY=value lines
//   --schedules  enable/disable pg_cron calls into locally running services (default: leave as is; off after a reset)
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import pg from 'pg';
import {
  LOCAL_ADMIN_URL,
  SERVICES,
  localCronSecret,
  localPassword,
  localUrl,
  schemaOf,
} from './db-roles.mjs';

const args = process.argv.slice(2);
const schedulesArg = args.includes('--schedules') ? args[args.indexOf('--schedules') + 1] : undefined;
const { localPorts } = load(readFileSync(new URL('../schedules.yaml', import.meta.url), 'utf8'));

const client = new pg.Client({ connectionString: LOCAL_ADMIN_URL });
await client.connect();
try {
  for (const svc of SERVICES) {
    const s = schemaOf(svc);
    for (const suffix of ['svc', 'migrator']) {
      const role = `${s}_${suffix}`;
      await client.query(`alter role ${role} password '${localPassword(role)}'`);
    }
    const name = `cron_secret_${s}`;
    const existing = await client.query('select id from vault.secrets where name = $1', [name]);
    if (existing.rows[0])
      await client.query('select vault.update_secret($1, $2)', [existing.rows[0].id, localCronSecret(svc)]);
    else await client.query('select vault.create_secret($1, $2)', [localCronSecret(svc), name]);
    await client.query(
      'update platform.service_endpoints set base_url = $2, updated_at = now() where service = $1',
      [svc, `http://host.docker.internal:${localPorts[svc]}`],
    );
    if (schedulesArg) {
      await client.query('update platform.service_endpoints set enabled = $2 where service = $1', [
        svc,
        schedulesArg === 'on',
      ]);
    }
  }
} finally {
  await client.end();
}

const lines = SERVICES.flatMap((svc) => {
  const key = schemaOf(svc).toUpperCase();
  return [
    `${key}_DATABASE_URL=${localUrl(`${schemaOf(svc)}_svc`)}`,
    `${key}_MIGRATOR_DATABASE_URL=${localUrl(`${schemaOf(svc)}_migrator`)}`,
    `${key}_CRON_SECRET=${localCronSecret(svc)}`,
    `${key}_PORT=${localPorts[svc]}`,
  ];
});
if (!args.includes('--env')) {
  process.stdout.write(
    `local service roles ready (schedules ${schedulesArg ?? 'unchanged'}). Connection env:\n`,
  );
}
process.stdout.write(`${lines.join('\n')}\n`);
