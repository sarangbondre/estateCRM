// Builds web's HTTP app on the in-memory adapters (contract tests with response validation on, NODE_ENV=test).
import { randomBytes, randomUUID } from 'node:crypto';
import { observe } from '@11e/observability';
import { containsContact } from '@11e/redaction';
import { Sessions } from '../src/application/sessions';
import type { StaffContext } from '../src/application/sessions';
import { Tokens } from '../src/application/tokens';
import { Keyring } from '../src/adapters/crypto';
import { buildApi } from '../src/adapters/http/api';
import type { ApiDeps } from '../src/adapters/http/api';
import type { SupabaseSettings } from '../src/adapters/supabase';
import { JoseSigner } from '../src/adapters/signer';
import { AuditAndNotifications } from '../src/application/audit';
import { Users } from '../src/application/users';
import {
  FakeAuth,
  FakeClock,
  Memory,
  MemoryAudit,
  MemoryClients,
  MemoryKeyStore,
  MemoryNotifications,
  MemoryUow,
  MemoryUsers,
} from './fakes';

export const APP_ORIGIN = 'http://127.0.0.1:3000';
export const CRON_SECRET = randomUUID();
export const SUPABASE: SupabaseSettings = {
  url: 'http://127.0.0.1:1',
  anonKey: 'test-anon',
  serviceRoleKey: undefined,
  secureCookies: false,
};

export interface Parts {
  memory: Memory;
  auth: FakeAuth;
  clock: FakeClock;
  sessions: Sessions;
  tokens: Tokens;
  keyring: Keyring;
  users: Users;
  audit: AuditAndNotifications;
}

export async function harness(extra: Partial<ApiDeps> | ((p: Parts) => Partial<ApiDeps>) = {}) {
  const memory = new Memory();
  const auth = new FakeAuth();
  const clock = new FakeClock(new Date());
  const users = new MemoryUsers(memory);
  const uow = new MemoryUow(memory);
  const sessions = new Sessions({ auth, users, uow, clock });
  const keys = new MemoryKeyStore();
  const signer = new JoseSigner(keys, clock);
  const clients = new MemoryClients();
  const tokens = new Tokens({ signer, keys, clients, clock });
  const keyring = new Keyring(randomBytes(32));
  const onUserChanged = (id: string) => {
    sessions.evict(id);
    tokens.evictUser(id);
  };
  const userAdmin = new Users({
    users,
    uow,
    auth,
    clock,
    hasher: { hash: (email) => keyring.hmac('email-hash', email).toString('hex') },
    onUserChanged,
  });
  const audit = new AuditAndNotifications({
    audit: new MemoryAudit(memory),
    notifications: new MemoryNotifications(memory),
    users,
    clock,
    looksLikePii: containsContact,
  });
  const parts: Parts = { memory, auth, clock, sessions, tokens, keyring, users: userAdmin, audit };
  const svc = buildApi({
    db: null,
    obs: observe('web', { level: 'fatal' }),
    sessions,
    tokens,
    signer,
    supabase: SUPABASE,
    appOrigin: APP_ORIGIN,
    cronSecret: CRON_SECRET,
    environment: { name: 'local', pilot: true, vocabularyVersion: null },
    users: userAdmin,
    audit,
    ...(typeof extra === 'function' ? extra(parts) : extra),
  });
  const as = (userId: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      authorization: `Bearer token.${userId}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const staff = (u: { id: string; tenantId: string; role: StaffContext['role']; isDataOperator: boolean }) =>
    ({ tenantId: u.tenantId, userId: u.id, role: u.role, isDataOperator: u.isDataOperator, user: u }) as StaffContext;
  return { ...parts, userRepo: users, uow, keys, signer, clients, svc, app: svc.app, as, staff };
}
