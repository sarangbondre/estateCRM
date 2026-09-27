// Seeds one synthetic user per role in Supabase Auth + web.users (active), signs each in through /auth/confirm (the
// e-mail-link route) and saves a storage state per role (e2e/.auth/<role>.json, git-ignored). Local stack only.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createDb, withTransaction } from '@11e/db';
import type { Kysely } from '@11e/db';
import { Keyring } from '../src/adapters/crypto';
import type { WebDb } from '../src/adapters/db/schema';
import { txRepos } from '../src/adapters/db/uow';
import { DbUserRepo } from '../src/adapters/db/users';
import { SCHEMA, loadConfig } from '../src/config';
import type { RoleCode } from '../src/domain/roles';
import { SYSTEM_ACTOR_ID } from '../src/domain/users';
import { E2E_USERS, authFile } from './users';

for (const f of ['../../../.env.local', '../.env.local']) {
  try {
    process.loadEnvFile(new URL(f, import.meta.url));
  } catch {
    /* optional */
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:3000';
  const cfg = loadConfig();
  if (!cfg.supabaseServiceRoleKey) throw new Error('E2E needs SUPABASE_SERVICE_ROLE_KEY (pnpm --filter @11e/web env:local)');
  const admin = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // The migrator role (web_owner) so the running server keeps all web_svc connections (role cap).
  const handle = createDb<WebDb>({ connectionString: process.env['WEB_MIGRATOR_DATABASE_URL'] ?? cfg.databaseUrl, schema: SCHEMA, maxConnections: 1 });
  const keyring = new Keyring(cfg.kek);
  mkdirSync(new URL('./.auth/', import.meta.url), { recursive: true });

  const existing = new Map<string, string>();
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const u of list?.users ?? []) if (u.email) existing.set(u.email.toLowerCase(), u.id);

  const browser = await chromium.launch(process.env['CI'] ? {} : { channel: process.env['PW_CHANNEL'] ?? 'chrome' });
  try {
    for (const [key, u] of Object.entries(E2E_USERS)) {
      let id = existing.get(u.email);
      if (!id) {
        const { data, error } = await admin.auth.admin.createUser({ email: u.email, email_confirm: true });
        if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
        id = data.user.id;
      }
      await upsertActive(handle.db, keyring, cfg.tenantId, id, u.email, u.name, u.role);
      const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.email });
      if (error || !link.properties?.hashed_token) throw new Error(`generateLink ${key}: ${error?.message}`);
      const ctx = await browser.newContext({ baseURL });
      const page = await ctx.newPage();
      await page.goto(`/auth/confirm?type=magiclink&token_hash=${encodeURIComponent(link.properties.hashed_token)}`);
      await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
      await ctx.storageState({ path: authFile(key) });
      await ctx.close();
    }
  } finally {
    await browser.close();
    await handle.close();
  }
}

async function upsertActive(
  db: Kysely<WebDb>,
  keyring: Keyring,
  tenantId: string,
  id: string,
  email: string,
  name: string,
  role: RoleCode,
) {
  const found = await new DbUserRepo(db).findById(id);
  const now = new Date();
  await withTransaction(db, async (trx) => {
    const tx = txRepos(trx);
    if (!found) {
      const user = {
        tenantId,
        id,
        email,
        displayName: name,
        role,
        isDataOperator: false,
        status: 'active' as const,
        invitedBy: SYSTEM_ACTOR_ID,
        invitedAt: now,
        activatedAt: now,
        deactivatedAt: null,
        lastSeenAt: now,
        version: 1,
      };
      await tx.users.insert({ ...user, emailHash: keyring.hmac('email-hash', email).toString('hex') });
      await tx.outbox.userChanged({ tenantId, user, correlationId: randomUUID() });
    } else if (found.role !== role || found.status !== 'active') {
      const user = { ...found, role, status: 'active' as const, deactivatedAt: null, lastSeenAt: now, version: found.version + 1 };
      await tx.users.update(user, found.version);
      await tx.outbox.userChanged({ tenantId, user, correlationId: randomUUID() });
    } else {
      await trx.updateTable('users').set({ last_seen_at: now }).where('id', '=', id).execute();
    }
  });
}
