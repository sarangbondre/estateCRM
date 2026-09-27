// Creates or rotates a service's client credential for POST /internal/v1/service-tokens (R-2). The plaintext is printed
// once: put it into that service's SERVICE_CREDENTIAL (Vercel env / local .env). Only its HMAC is stored.
// Usage: pnpm --filter @11e/web service-client <intake|records|journeys|crm-engine|listings|insight>
import { randomBytes } from 'node:crypto';
import { createDb } from '@11e/db';
import { Keyring } from '../src/adapters/crypto';
import { DbServiceClientRepo } from '../src/adapters/db/keys';
import type { WebDb } from '../src/adapters/db/schema';
import { SCHEMA, loadConfig } from '../src/config';
import { ALLOWED_AUDIENCES, isServiceName } from '../src/domain/service-tokens';

const name = process.argv[2];
if (!isServiceName(name)) {
  process.stderr.write('usage: service-client <intake|records|journeys|crm-engine|listings|insight>\n');
  process.exit(2);
}
const config = loadConfig();
const handle = createDb<WebDb>({ connectionString: config.databaseUrl, schema: SCHEMA, maxConnections: 1 });
try {
  const credential = randomBytes(32).toString('base64url');
  await new DbServiceClientRepo(handle.db, new Keyring(config.kek)).upsert(
    name,
    credential,
    ALLOWED_AUDIENCES[name],
    new Date(),
  );
  process.stdout.write(
    `${name}: SERVICE_CREDENTIAL=${credential}\n(audiences: ${ALLOWED_AUDIENCES[name].join(', ')})\n`,
  );
} finally {
  await handle.close();
}
