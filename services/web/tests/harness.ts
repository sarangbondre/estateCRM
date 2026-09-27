import { randomUUID } from 'node:crypto';
// Builds web's HTTP app on the in-memory adapters (contract tests with response validation on, NODE_ENV=test).
import { observe } from '@11e/observability';
import { Sessions } from '../src/application/sessions';
import { Tokens } from '../src/application/tokens';
import { buildApi } from '../src/adapters/http/api';
import type { ApiDeps } from '../src/adapters/http/api';
import { JoseSigner } from '../src/adapters/signer';
import { FakeAuth, FakeClock, Memory, MemoryClients, MemoryKeyStore, MemoryUow, MemoryUsers } from './fakes';

export const APP_ORIGIN = 'http://127.0.0.1:3000';
export const CRON_SECRET = randomUUID();

export async function harness(extra: Partial<ApiDeps> = {}) {
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
  const svc = buildApi({
    db: null,
    obs: observe('web', { level: 'fatal' }),
    sessions,
    tokens,
    signer,
    supabase: {
      url: 'http://127.0.0.1:1',
      anonKey: 'test-anon',
      serviceRoleKey: undefined,
      secureCookies: false,
    },
    appOrigin: APP_ORIGIN,
    cronSecret: CRON_SECRET,
    environment: { name: 'local', pilot: true, vocabularyVersion: null },
    ...extra,
  });
  const as = (userId: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      authorization: `Bearer token.${userId}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return { memory, auth, clock, users, uow, sessions, keys, signer, clients, tokens, svc, app: svc.app, as };
}
