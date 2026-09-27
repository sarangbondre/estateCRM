// Local stack only: gives each service's LOGIN roles its local password (the bootstrap migration never sets one)
// and prints the connection env. Run after `supabase start` / `db reset`: `pnpm db:start` does it for you.
// Usage: node infra/scripts/local-roles.mjs [--env]   (--env prints only KEY=value lines)
import pg from 'pg';
import { LOCAL_ADMIN_URL, SERVICES, localPassword, localUrl, schemaOf } from './db-roles.mjs';

const client = new pg.Client({ connectionString: LOCAL_ADMIN_URL });
await client.connect();
try {
  for (const svc of SERVICES) {
    for (const suffix of ['svc', 'migrator']) {
      const role = `${schemaOf(svc)}_${suffix}`;
      await client.query(`alter role ${role} password '${localPassword(role)}'`);
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
  ];
});
if (!process.argv.includes('--env')) process.stdout.write('local service roles ready. Connection env:\n');
process.stdout.write(`${lines.join('\n')}\n`);
