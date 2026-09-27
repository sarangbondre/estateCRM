// WEB-02: sign-in completion, per-request authentication, /v1/me, sign-out, roles, JWKS and service-token minting
// (use cases + HTTP contract with response validation, on in-memory adapters).
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_TTL_SEC } from '../src/domain/service-tokens';
import { NEXT_KEY_PUBLISH_MS } from '../src/application/tokens';
import { TENANT, makeUser } from './fakes';
import { harness } from './harness';

type H = Awaited<ReturnType<typeof harness>>;
let h: H;
beforeEach(async () => {
  h = await harness();
});

describe('completeSignIn (web LLD §4.1 step 2)', () => {
  it('activates an invited user: users, invitation, audit and user.changed.v1 together', async () => {
    const u = h.memory.add(
      makeUser({ status: 'invited', activatedAt: null, lastSeenAt: null, role: 'Supply agent' }),
    );
    h.memory.invitations.push({
      tenantId: TENANT,
      id: randomUUID(),
      userId: u.id,
      emailHash: 'aa',
      role: 'Supply agent',
      isDataOperator: false,
      status: 'pending',
      invitedBy: randomUUID(),
      expiresAt: new Date(h.clock.now().getTime() + 86_400_000),
      acceptedAt: null,
    });
    const active = await h.sessions.completeSignIn(`token.${u.id}`, 'cid-12345678');
    expect(active).toMatchObject({ status: 'active', version: 2 });
    expect(h.memory.invitations[0]?.status).toBe('accepted');
    expect(h.memory.audit.map((a) => a.action)).toEqual(['user.activated']);
    expect(h.memory.events).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        user: expect.objectContaining({ id: u.id, status: 'active', version: 2 }),
      }),
    ]);
  });

  it('refuses a Google account that was never invited and removes it from Supabase Auth', async () => {
    const stranger = randomUUID();
    await expect(h.sessions.completeSignIn(`token.${stranger}`, 'cid-12345678')).rejects.toThrow(
      'not-invited',
    );
    expect(h.auth.deleted).toEqual([stranger]);
  });

  it('refuses deactivated users and expired invitations', async () => {
    const d = h.memory.add(makeUser({ status: 'deactivated' }));
    await expect(h.sessions.completeSignIn(`token.${d.id}`, 'c')).rejects.toThrow('user-deactivated');
    const inv = h.memory.add(makeUser({ status: 'invited' }));
    h.memory.invitations.push({
      tenantId: TENANT,
      id: randomUUID(),
      userId: inv.id,
      emailHash: 'bb',
      role: 'Demand agent',
      isDataOperator: false,
      status: 'pending',
      invitedBy: randomUUID(),
      expiresAt: new Date(h.clock.now().getTime() - 1000),
      acceptedAt: null,
    });
    await expect(h.sessions.completeSignIn(`token.${inv.id}`, 'c')).rejects.toThrow('not-invited');
  });

  it('a returning active user gets a fresh idle timer', async () => {
    const u = h.memory.add(makeUser({ lastSeenAt: new Date(h.clock.now().getTime() - 13 * 3600_000) }));
    await h.sessions.completeSignIn(`token.${u.id}`, 'c');
    await expect(h.sessions.authenticate(`token.${u.id}`)).resolves.toMatchObject({ userId: u.id });
  });
});

describe('authenticate (web LLD §4.1 step 3)', () => {
  it('rejects missing and invalid tokens', async () => {
    await expect(h.sessions.authenticate(null)).rejects.toThrow('unauthenticated');
    await expect(h.sessions.authenticate('garbage')).rejects.toThrow('unauthenticated');
  });
  it('expires the session after 12 h idle', async () => {
    const u = h.memory.add(
      makeUser({ lastSeenAt: new Date(h.clock.now().getTime() - 12 * 3600_000 - 1000) }),
    );
    await expect(h.sessions.authenticate(`token.${u.id}`)).rejects.toThrow('session-expired');
  });
  it('records activity at most once a minute', async () => {
    const u = h.memory.add(makeUser({ lastSeenAt: new Date(h.clock.now().getTime() - 120_000) }));
    await h.sessions.authenticate(`token.${u.id}`);
    await h.sessions.authenticate(`token.${u.id}`);
    expect(h.memory.touches).toBe(1);
    h.clock.advance(61_000);
    await h.sessions.authenticate(`token.${u.id}`);
    expect(h.memory.touches).toBe(2);
  });
  it('caches the user for 60 s; evict makes a deactivation effective at once', async () => {
    const u = h.memory.add(makeUser());
    await h.sessions.authenticate(`token.${u.id}`);
    h.memory.users.get(u.id)!.status = 'deactivated';
    await expect(h.sessions.authenticate(`token.${u.id}`)).resolves.toBeTruthy();
    h.sessions.evict(u.id);
    await expect(h.sessions.authenticate(`token.${u.id}`)).rejects.toThrow('user-deactivated');
  });
});

describe('HTTP contract: session endpoints', () => {
  it('GET /v1/me returns the user, permissions, idle expiry and environment', async () => {
    const u = h.memory.add(makeUser({ role: 'Manager', displayName: 'Mira Manager' }));
    const res = await h.app.request('/v1/me', h.as(u.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      userId: u.id,
      tenantId: TENANT,
      role: 'Manager',
      environment: { name: 'local', pilot: true },
    });
    expect(body.permissions).toContain('queue.reassign');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
  it('GET /v1/me: 401 without a session, 403 not-invited / user-deactivated', async () => {
    expect((await h.app.request('/v1/me')).status).toBe(401);
    const res = await h.app.request('/v1/me', h.as(randomUUID()));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('not-invited');
    const d = h.memory.add(makeUser({ status: 'deactivated' }));
    expect(await (await h.app.request('/v1/me', h.as(d.id))).json()).toMatchObject({
      code: 'user-deactivated',
    });
  });
  it('DELETE /v1/me/session signs out (204) and audits it', async () => {
    const u = h.memory.add(makeUser());
    const res = await h.app.request('/v1/me/session', h.as(u.id, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(h.memory.audit.map((a) => a.action)).toEqual(['session.signed_out']);
    expect((await h.app.request('/v1/me/session', { method: 'DELETE' })).status).toBe(401);
  });
  it('GET /v1/roles lists the five roles for every staff member', async () => {
    const u = h.memory.add(makeUser({ role: 'Data operator' }));
    const res = await h.app.request('/v1/roles', h.as(u.id));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(5);
  });
  it('rejects a cookie-less cross-origin request only when it uses the session cookie', async () => {
    // Bearer callers are not subject to the CSRF origin check.
    const u = h.memory.add(makeUser());
    const res = await h.app.request(
      '/v1/me/session',
      h.as(u.id, { method: 'DELETE', headers: { origin: 'https://evil.example' } }),
    );
    expect(res.status).toBe(204);
  });
});

describe('service tokens and JWKS (R-2)', () => {
  const credential = 'listings-credential-0123456789abcdef';
  beforeEach(() => {
    h.clients.clients.set(credential, { name: 'listings', allowedAudiences: ['records'], status: 'active' });
  });

  it('JWKS publishes the active key; minted tokens verify against it', async () => {
    const jwks = await (await h.app.request('/.well-known/jwks.json')).json();
    expect(jwks.keys).toHaveLength(1);
    const res = await h.app.request('/internal/v1/service-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-credential': credential },
      body: JSON.stringify({ audience: 'records', tenantId: TENANT }),
    });
    expect(res.status).toBe(200);
    const { token, expiresAt } = await res.json();
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: 'web',
      audience: 'records',
    });
    expect(payload).toMatchObject({ sub: 'listings', tid: TENANT });
    expect(payload['uid']).toBeUndefined();
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(TOKEN_TTL_SEC * 1000 + 1000);
  });

  it('401 for an unknown credential, 403 for a pair that is not allowed, 400 for a bad body', async () => {
    const post = (cred: string, body: unknown) =>
      h.app.request('/internal/v1/service-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-credential': cred },
        body: JSON.stringify(body),
      });
    const bad = await post('nope-nope-nope-nope', { audience: 'records', tenantId: TENANT });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe('service-credential-invalid');
    const denied = await post(credential, { audience: 'journeys', tenantId: TENANT });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('audience-not-allowed');
    expect((await post(credential, { audience: 'records' })).status).toBe(400);
  });

  it('user-context tokens are cached per user and audience and evicted on sign-out', async () => {
    const u = makeUser({ role: 'Supply agent' });
    const ctx = { tenantId: TENANT, userId: u.id, role: u.role, isDataOperator: false, user: u };
    const t1 = await h.tokens.userToken(ctx, 'records');
    expect(await h.tokens.userToken(ctx, 'records')).toBe(t1);
    expect(await h.tokens.userToken(ctx, 'journeys')).not.toBe(t1);
    expect(decodeJwt(t1)).toMatchObject({
      iss: 'web',
      sub: 'web',
      aud: 'records',
      uid: u.id,
      role: 'Supply agent',
      dop: false,
    });
    h.tokens.evictUser(u.id);
    h.clock.advance(1000);
    expect(await h.tokens.userToken(ctx, 'records')).not.toBe(t1);
  });

  it('rotation: publish a next key first, promote it later, retire the previous after 1 h', async () => {
    await h.signer.jwks();
    h.clock.advance(91 * 86_400_000);
    await h.tokens.rotate();
    expect((await h.tokens.jwks()).keys).toHaveLength(2); // active + next
    const activeBefore = h.keys.keys.find((k) => k.status === 'active')!.kid;
    h.clock.advance(NEXT_KEY_PUBLISH_MS);
    await h.tokens.rotate();
    const active = h.keys.keys.find((k) => k.status === 'active')!;
    expect(active.kid).not.toBe(activeBefore);
    expect(h.keys.keys.find((k) => k.kid === activeBefore)?.status).toBe('previous');
    const { token } = await h.signer.sign({ sub: 'x' }, 60);
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid).toBe(active.kid);
    h.clock.advance(3600_000 + 1);
    await h.tokens.rotate();
    expect((await h.tokens.jwks()).keys).toHaveLength(1);
  });
});

describe('health', () => {
  it('live and ready', async () => {
    expect((await h.app.request('/health/live')).status).toBe(200);
    expect(await (await h.app.request('/health/ready')).json()).toMatchObject({ status: 'ok' });
  });
});
