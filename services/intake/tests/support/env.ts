// Local stack connection settings for tests (pnpm db:start; CI starts the same stack).
import { randomUUID } from 'node:crypto';
import { SCHEMA } from '../../src/config.js';

const HOST = '127.0.0.1:54322/postgres';
export const dbEnv = {
  DATABASE_URL:
    process.env['INTAKE_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['INTAKE_MIGRATOR_DATABASE_URL'] ??
    `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
};
