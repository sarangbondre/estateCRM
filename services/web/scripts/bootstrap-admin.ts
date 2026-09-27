// Creates the first Admin (questionnaire A6: Sarang is the only Admin; everyone else is invited in the app).
// Makes sure the Supabase Auth user exists (no e-mail sent) and inserts/updates web.users as an active Admin, with an
// audit entry and user.changed.v1, in one transaction. Idempotent.
// Usage: pnpm --filter @11e/web bootstrap-admin --email you@example.com --name "Your Name"
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createDb, withTransaction } from '@11e/db';
import { Keyring } from '../src/adapters/crypto';
import type { WebDb } from '../src/adapters/db/schema';
import { txRepos } from '../src/adapters/db/uow';
import { DbUserRepo } from '../src/adapters/db/users';
import { SCHEMA, loadConfig } from '../src/config';
import { SYSTEM_ACTOR_ID, assertValidEmail, normalizeEmail } from '../src/domain/users';
import type { User } from '../src/domain/users';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const email = normalizeEmail(arg('email') ?? '');
const displayName = (arg('name') ?? '').trim();
assertValidEmail(email);
if (!displayName) throw new Error('--name is required');

const config = loadConfig();
if (!config.supabaseServiceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function authUserId(): Promise<string> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Supabase Auth: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (found) return found.id;
    if (data.users.length < 200) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`Supabase Auth: ${error?.message ?? 'no user'}`);
  return data.user.id;
}

const handle = createDb<WebDb>({ connectionString: config.databaseUrl, schema: SCHEMA, maxConnections: 1 });
try {
  const id = await authUserId();
  const keyring = new Keyring(config.kek);
  const emailHash = keyring.hmac('email-hash', email).toString('hex');
  const existing = await new DbUserRepo(handle.db).findById(id);
  const now = new Date();
  await withTransaction(handle.db, async (trx) => {
    const tx = txRepos(trx);
    const correlationId = randomUUID();
    let user: User;
    if (!existing) {
      user = {
        tenantId: config.tenantId,
        id,
        email,
        displayName,
        role: 'Admin',
        isDataOperator: false,
        status: 'active',
        invitedBy: SYSTEM_ACTOR_ID,
        invitedAt: now,
        activatedAt: now,
        deactivatedAt: null,
        lastSeenAt: null,
        version: 1,
      };
      await tx.users.insert({ ...user, emailHash });
    } else {
      user = {
        ...existing,
        role: 'Admin',
        status: 'active',
        deactivatedAt: null,
        displayName,
        version: existing.version + 1,
      };
      await tx.users.update(user, existing.version);
    }
    await tx.audit.append({
      tenantId: user.tenantId,
      occurredAt: now,
      producer: 'web',
      action: existing ? 'user.role_changed' : 'user.activated',
      actorUserId: SYSTEM_ACTOR_ID,
      subjectType: 'user',
      subjectId: user.id,
      via: 'system',
      details: { role: 'Admin', source: 'bootstrap' },
      correlationId,
    });
    await tx.outbox.userChanged({ tenantId: user.tenantId, user, correlationId });
  });
  process.stdout.write(`Admin ready (user ${id}). Sign in with Google (or the local e-mail link).\n`);
} finally {
  await handle.close();
}
