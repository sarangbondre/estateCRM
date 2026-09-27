// Rotates a service's database role password (data-hosting §3: every 90 days and on any suspected leak; runbook
// docs/runbooks/rotate-secrets.md). Prints the new password ONCE to this terminal for pasting into that Vercel project's
// env (DATABASE_URL); it is never written to a file or a log.
// Usage: ADMIN_DATABASE_URL=… node infra/scripts/rotate-db-password.mjs <service> [svc|migrator]
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SERVICES, adminUrl, schemaOf } from './db-roles.mjs';

const [svc, kind = 'svc'] = process.argv.slice(2);
if (!svc || !SERVICES.includes(svc) || !['svc', 'migrator'].includes(kind)) {
  process.stderr.write(`usage: rotate-db-password.mjs <${SERVICES.join('|')}> [svc|migrator]\n`);
  process.exit(2);
}
const role = `${schemaOf(svc)}_${kind}`;
const password = randomBytes(24).toString('base64url');

const client = new pg.Client({
  connectionString: adminUrl(),
  ssl: adminUrl().includes('127.0.0.1') ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  // Identifier is from a fixed list; the password is base64url (no quotes), so the literal is safe.
  await client.query(`alter role ${role} password '${password}'`);
} finally {
  await client.end();
}
process.stdout.write(
  [
    `new password for ${role} (shown once; paste it into the Vercel env, then redeploy; old sessions keep working until they reconnect):`,
    password,
    '',
  ].join('\n'),
);
