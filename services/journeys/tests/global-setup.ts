// Applies the migrations once before the test files run (the migrator role has a small connection cap).
import { migrate } from '@11e/db';

export default async function setup(): Promise<void> {
  const host = '127.0.0.1:54322/postgres';
  await migrate({
    connectionString:
      process.env['JOURNEYS_MIGRATOR_DATABASE_URL'] ?? `postgresql://journeys_migrator:local_journeys_migrator@${host}`,
    schema: 'journeys',
    dir: new URL('../migrations', import.meta.url).pathname,
  });
}
