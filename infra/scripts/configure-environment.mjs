// Provisioning (F-07 / runbook): configures the scheduler of a cloud environment (pilot, staging, production).
// Everything comes from environment variables typed in the operator's shell; nothing is read from or written to files.
//
//   ADMIN_DATABASE_URL        postgres admin connection of the Supabase project (direct, not the pooler)
//   ENVIRONMENT_NAME          pilot | staging | production (shown in alarm webhooks)
//   <SCHEMA>_BASE_URL         e.g. RECORDS_BASE_URL=https://11e-records.vercel.app   (one per service)
//   <SCHEMA>_CRON_SECRET      the same value as that Vercel project's CRON_SECRET env var
//   ALARM_WEBHOOK_URL         optional: where alarm state changes are POSTed (JSON, no PII)
//   SCHEDULES                 on | off (default off: set on only after every service is deployed and healthy)
//
// Usage: node infra/scripts/configure-environment.mjs [--dry-run]
import pg from 'pg';
import { SERVICES, schemaOf } from './db-roles.mjs';

const env = process.env;
const dryRun = process.argv.includes('--dry-run');
const fail = (m) => {
  process.stderr.write(`${m}\n`);
  process.exit(1);
};

if (!env['ADMIN_DATABASE_URL']) fail('ADMIN_DATABASE_URL is required');
if (!['pilot', 'staging', 'production'].includes(env['ENVIRONMENT_NAME'] ?? ''))
  fail('ENVIRONMENT_NAME must be pilot, staging or production');
const plan = SERVICES.map((svc) => {
  const key = schemaOf(svc).toUpperCase();
  const baseUrl = env[`${key}_BASE_URL`];
  const secret = env[`${key}_CRON_SECRET`];
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) fail(`${key}_BASE_URL must be an https URL`);
  if (!secret || secret.length < 32) fail(`${key}_CRON_SECRET must be at least 32 characters`);
  return { svc, baseUrl, secret };
});
const enabled = env['SCHEDULES'] === 'on';

const upsertSecret = async (client, name, value) => {
  const found = await client.query('select id from vault.secrets where name = $1', [name]);
  if (found.rows[0]) await client.query('select vault.update_secret($1, $2)', [found.rows[0].id, value]);
  else await client.query('select vault.create_secret($1, $2)', [value, name]);
};

process.stdout.write(
  `${dryRun ? '[dry run] ' : ''}${env['ENVIRONMENT_NAME']}: ${plan.map((p) => `${p.svc}=${p.baseUrl}`).join(' ')}; schedules ${enabled ? 'ON' : 'off'}; alarm webhook ${env['ALARM_WEBHOOK_URL'] ? 'set' : 'not set'}\n`,
);
if (dryRun) process.exit(0);

const client = new pg.Client({
  connectionString: env['ADMIN_DATABASE_URL'],
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query('begin');
  for (const p of plan) {
    await upsertSecret(client, `cron_secret_${schemaOf(p.svc)}`, p.secret);
    await client.query(
      'update platform.service_endpoints set base_url = $2, enabled = $3, updated_at = now() where service = $1',
      [p.svc, p.baseUrl, enabled],
    );
  }
  await upsertSecret(client, 'environment_name', env['ENVIRONMENT_NAME']);
  if (env['ALARM_WEBHOOK_URL']) await upsertSecret(client, 'alarm_webhook_url', env['ALARM_WEBHOOK_URL']);
  await client.query('commit');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  await client.end();
}
process.stdout.write(
  'done. Verify with: ADMIN_DATABASE_URL=… VERIFY_ROLE_URL_<SCHEMA>=… node infra/scripts/verify-platform.mjs\n',
);
